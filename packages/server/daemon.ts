import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadState, saveState, transition, type FeedbackPayload } from "./state";

export type DaemonLaunchOptions = {
  childCommand: string[];
  cwd?: string;
  env?: Record<string, string>;
  lockfilePath: string;
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  stopSignal?: NodeJS.Signals | number;
  stopTimeoutMs?: number;
};

export type DaemonCommandResult = {
  pid?: number;
  verdict: "started" | "running" | "stopped" | "recovered";
};

type LockfileRecord = {
  pid: number;
  childPid: number | null;
  createdAt: string;
  command: string[];
  cwd: string;
};

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const RUN_DAEMON_SENTINEL = "__plannotator_run_daemon__";
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_SIGNAL: NodeJS.Signals = "SIGTERM";

function syncDirectory(path: string): void {
  if (process.platform === "win32") {
    return;
  }

  const directoryFd = openSync(path, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function normalizeOptions(options: DaemonLaunchOptions): Required<DaemonLaunchOptions> {
  if (!Array.isArray(options.childCommand) || options.childCommand.length === 0) {
    throw new Error("Daemon childCommand must contain at least one executable.");
  }

  if (typeof options.lockfilePath !== "string" || options.lockfilePath.length === 0) {
    throw new Error("Daemon lockfilePath must be a non-empty string.");
  }

  return {
    childCommand: [...options.childCommand],
    cwd: options.cwd ?? process.cwd(),
    env: { ...(options.env ?? {}) },
    lockfilePath: options.lockfilePath,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    stopSignal: options.stopSignal ?? DEFAULT_STOP_SIGNAL,
    stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
  };
}

function getLockfilePath(options: Required<DaemonLaunchOptions>): string {
  return resolve(options.lockfilePath);
}

function getLogPath(lockfilePath: string, stream: "stdout" | "stderr"): string {
  return `${lockfilePath}.${stream}.log`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }

    throw error;
  }
}

function removeLockfile(lockfilePath: string): void {
  if (!existsSync(lockfilePath)) {
    return;
  }

  rmSync(lockfilePath, { force: true });
  syncDirectory(dirname(lockfilePath));
}

function readLockfile(lockfilePath: string): LockfileRecord | null {
  if (!existsSync(lockfilePath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockfilePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse daemon lockfile at ${lockfilePath}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Daemon lockfile at ${lockfilePath} must contain an object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) {
    throw new Error(`Daemon lockfile at ${lockfilePath} must contain a positive integer pid.`);
  }

  const childPid = record.childPid;
  if (
    childPid !== null &&
    childPid !== undefined &&
    (typeof childPid !== "number" || !Number.isInteger(childPid) || childPid <= 0)
  ) {
    throw new Error(
      `Daemon lockfile at ${lockfilePath} must contain a null or positive integer childPid.`,
    );
  }

  if (!Array.isArray(record.command) || !record.command.every((entry) => typeof entry === "string")) {
    throw new Error(`Daemon lockfile at ${lockfilePath} must contain a string[] command.`);
  }

  if (typeof record.createdAt !== "string" || typeof record.cwd !== "string") {
    throw new Error(
      `Daemon lockfile at ${lockfilePath} must contain string createdAt and cwd fields.`,
    );
  }

  return {
    pid: record.pid,
    childPid: childPid ?? null,
    createdAt: record.createdAt,
    command: [...record.command],
    cwd: record.cwd,
  };
}

function writeLockfile(lockfilePath: string, record: LockfileRecord): void {
  const directory = dirname(lockfilePath);
  mkdirSync(directory, { recursive: true });

  const tempPath = `${lockfilePath}.tmp`;
  const serialized = JSON.stringify(record);
  const fd = openSync(tempPath, "w", 0o600);
  try {
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tempPath, lockfilePath);
  syncDirectory(directory);
}

function buildCancelledFeedback(): FeedbackPayload {
  return {
    approved: false,
    feedback: "Daemon recovered a stale awaiting-response state after the owning process stopped.",
    annotations: [],
    cancelled: true,
  };
}

function recoverPersistedState(): boolean {
  const state = loadState();
  if (state.status !== "awaiting-response") {
    return false;
  }

  const nextState = transition(state, {
    type: "resolve",
    feedback: buildCancelledFeedback(),
  });
  saveState(nextState);
  return true;
}

function recoverStateForMissingDaemon(lockfilePath: string): DaemonCommandResult {
  const recovered = recoverPersistedState();
  if (existsSync(lockfilePath)) {
    removeLockfile(lockfilePath);
  }

  return {
    verdict: recovered ? "recovered" : "stopped",
  };
}

function recoverStateForStaleLockfile(pid: number, lockfilePath: string): DaemonCommandResult {
  removeLockfile(lockfilePath);
  recoverPersistedState();

  return {
    pid,
    verdict: "recovered",
  };
}

function parseMainInvocation(argv1: string | undefined): string | null {
  if (!argv1) {
    return null;
  }

  return resolve(argv1);
}

function isCompiledBunModulePath(modulePath: string): boolean {
  return modulePath.startsWith("/$bunfs/");
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const handleSpawn = () => {
      cleanup();
      resolvePromise();
    };
    const handleError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      child.off("spawn", handleSpawn);
      child.off("error", handleError);
    };

    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<ChildExit> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise({
        code,
        signal,
      });
    });
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
  description: string,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`);
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  await waitForCondition(
    () => !isPidAlive(pid),
    timeoutMs,
    pollIntervalMs,
    `pid ${pid} to exit`,
  );
}

export async function runDaemon(options: DaemonLaunchOptions): Promise<void> {
  const normalized = normalizeOptions(options);
  const lockfilePath = getLockfilePath(normalized);
  const existingLock = readLockfile(lockfilePath);

  if (existingLock) {
    if (isPidAlive(existingLock.pid)) {
      throw new Error(`Daemon already running with pid ${existingLock.pid}.`);
    }

    removeLockfile(lockfilePath);
  }

  recoverPersistedState();

  const [command, ...args] = normalized.childCommand;
  const child = spawn(command, args, {
    cwd: normalized.cwd,
    detached: false,
    env: {
      ...process.env,
      ...normalized.env,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  await waitForSpawn(child);

  const childExitPromise = waitForChildExit(child);
  const childPid = child.pid ?? null;

  writeLockfile(lockfilePath, {
    pid: process.pid,
    childPid,
    createdAt: new Date().toISOString(),
    command: normalized.childCommand,
    cwd: normalized.cwd,
  });

  let cleanupStarted = false;

  const cleanup = async (
    requestedSignal?: NodeJS.Signals | number,
  ): Promise<void> => {
    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;
    try {
      if (childPid !== null && isPidAlive(childPid) && requestedSignal !== undefined) {
        child.kill(requestedSignal);
        await waitForProcessExit(
          childPid,
          normalized.stopTimeoutMs,
          normalized.pollIntervalMs,
        );
      }
    } finally {
      removeLockfile(lockfilePath);
    }
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    void cleanup(signal)
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    const exit = await childExitPromise;
    await cleanup();

    if (exit.code !== null) {
      process.exitCode = exit.code;
      return;
    }

    if (exit.signal) {
      process.kill(process.pid, exit.signal);
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}

export async function startDaemonDetached(
  options: DaemonLaunchOptions,
): Promise<DaemonCommandResult> {
  const normalized = normalizeOptions(options);
  const lockfilePath = getLockfilePath(normalized);
  const existingLock = readLockfile(lockfilePath);

  if (existingLock) {
    if (isPidAlive(existingLock.pid)) {
      return {
        pid: existingLock.pid,
        verdict: "running",
      };
    }

    removeLockfile(lockfilePath);
    recoverPersistedState();
  } else {
    recoverPersistedState();
  }

  mkdirSync(dirname(lockfilePath), { recursive: true });

  const stdoutFd = openSync(getLogPath(lockfilePath, "stdout"), "a");
  const stderrFd = openSync(getLogPath(lockfilePath, "stderr"), "a");

  try {
    const daemonScriptPath = fileURLToPath(import.meta.url);
    const compiledDaemon = isCompiledBunModulePath(daemonScriptPath);
    const helperArgs = compiledDaemon
      ? [RUN_DAEMON_SENTINEL, JSON.stringify(normalized)]
      : [daemonScriptPath, RUN_DAEMON_SENTINEL, JSON.stringify(normalized)];
    const daemon = spawn(
      process.execPath,
      helperArgs,
      {
        cwd: normalized.cwd,
        detached: true,
        env: {
          ...process.env,
          ...normalized.env,
        },
        stdio: ["ignore", stdoutFd, stderrFd],
      },
    );

    daemon.unref();

    const daemonPid = daemon.pid;
    if (typeof daemonPid !== "number" || daemonPid <= 0) {
      throw new Error("Detached daemon spawn did not provide a pid.");
    }

    await waitForCondition(
      () => {
        if (existsSync(lockfilePath)) {
          return true;
        }

        if (!isPidAlive(daemonPid)) {
          throw new Error(`Detached daemon process ${daemonPid} exited before writing its lockfile.`);
        }

        return false;
      },
      normalized.startTimeoutMs,
      normalized.pollIntervalMs,
      "detached daemon lockfile creation",
    );

    return {
      pid: daemonPid,
      verdict: "started",
    };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

export async function stopDaemon(
  options: DaemonLaunchOptions,
): Promise<DaemonCommandResult> {
  const normalized = normalizeOptions(options);
  const lockfilePath = getLockfilePath(normalized);
  const existingLock = readLockfile(lockfilePath);

  if (!existingLock) {
    return recoverStateForMissingDaemon(lockfilePath);
  }

  if (!isPidAlive(existingLock.pid)) {
    return recoverStateForStaleLockfile(existingLock.pid, lockfilePath);
  }

  process.kill(existingLock.pid, normalized.stopSignal);
  await waitForProcessExit(
    existingLock.pid,
    normalized.stopTimeoutMs,
    normalized.pollIntervalMs,
  );

  removeLockfile(lockfilePath);
  return {
    pid: existingLock.pid,
    verdict: "stopped",
  };
}

export async function daemonStatus(
  options: DaemonLaunchOptions,
): Promise<DaemonCommandResult> {
  const normalized = normalizeOptions(options);
  const lockfilePath = getLockfilePath(normalized);
  const existingLock = readLockfile(lockfilePath);

  if (!existingLock) {
    return recoverStateForMissingDaemon(lockfilePath);
  }

  if (isPidAlive(existingLock.pid)) {
    return {
      pid: existingLock.pid,
      verdict: "running",
    };
  }

  return recoverStateForStaleLockfile(existingLock.pid, lockfilePath);
}

const currentModulePath = fileURLToPath(import.meta.url);
const mainModulePath = parseMainInvocation(process.argv[1]);
const compiledSentinelInvocation =
  isCompiledBunModulePath(currentModulePath) &&
  process.argv[1] === RUN_DAEMON_SENTINEL;
const sourceSentinelInvocation =
  mainModulePath === currentModulePath &&
  process.argv[2] === RUN_DAEMON_SENTINEL;

if (compiledSentinelInvocation || sourceSentinelInvocation) {
  const serializedOptions = compiledSentinelInvocation
    ? process.argv[2]
    : process.argv[3];
  if (typeof serializedOptions !== "string" || serializedOptions.length === 0) {
    throw new Error("Missing serialized daemon options.");
  }

  const parsedOptions = JSON.parse(serializedOptions) as DaemonLaunchOptions;
  await runDaemon(parsedOptions);
}
