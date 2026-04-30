import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DaemonState, DocumentSnapshot, FeedbackPayload } from "../packages/server/state";

type DaemonLaunchOptions = {
  childCommand: string[];
  cwd?: string;
  env?: Record<string, string>;
  lockfilePath: string;
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  stopSignal?: NodeJS.Signals | number;
  stopTimeoutMs?: number;
};

type DaemonCommandResult = {
  pid?: number;
  verdict: string;
};

type DaemonModule = {
  runDaemon: (options: DaemonLaunchOptions) => Promise<unknown> | unknown;
  startDaemonDetached: (
    options: DaemonLaunchOptions,
  ) => Promise<DaemonCommandResult> | DaemonCommandResult;
  stopDaemon: (
    options: DaemonLaunchOptions,
  ) => Promise<DaemonCommandResult> | DaemonCommandResult;
  daemonStatus: (
    options: DaemonLaunchOptions,
  ) => Promise<DaemonCommandResult> | DaemonCommandResult;
};

type DaemonModuleGate =
  | {
      available: true;
      module: DaemonModule;
    }
  | {
      available: false;
      reason: string;
    };

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type LifecycleHarness = {
  daemonScriptPath: string;
  driverScriptPath: string;
  exitFilePath: string;
  homeDir: string;
  lockfilePath: string;
  readyFilePath: string;
  statePath: string;
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const daemonModuleUrl = pathToFileURL(join(repoRoot, "packages/server/daemon.ts")).href;
const bunExecutable = Bun.which("bun") ?? "bun";
const tempDirs: string[] = [];
const CASE_TIMEOUT_MS = 60_000;

const resolvedDocument: DocumentSnapshot = {
  id: "nim-16-resolved-doc",
  mode: "plan",
  origin: "claude-code",
  content: "# Resolved plan\n\nAlready approved.\n",
};

const staleReviewDocument: DocumentSnapshot = {
  id: "nim-16-stale-doc",
  mode: "review",
  origin: "opencode",
  gitRef: "HEAD",
  content: [
    "diff --git a/src/server.ts b/src/server.ts",
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    "@@ -1,3 +1,3 @@",
    "-legacy",
    "+daemon",
  ].join("\n"),
};

const resolvedFeedback: FeedbackPayload = {
  approved: true,
  feedback: "Plan approved before daemon restart.",
  annotations: [{ blockId: "plan-1", type: "COMMENT" }],
  permissionMode: "acceptEdits",
};

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-nim16-"));
  tempDirs.push(dir);
  return dir;
}

function writeHarnessScript(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

function statePathForHome(homeDir: string): string {
  return join(homeDir, ".plannotator", "state.json");
}

function createLifecycleHarness(): LifecycleHarness {
  const dir = createTempDir();
  const homeDir = join(dir, "home");
  const daemonScriptPath = join(dir, "daemon-target.mjs");
  const driverScriptPath = join(dir, "daemon-driver.mjs");
  const lockfilePath = join(dir, "plannotator-daemon.lock.json");
  const readyFilePath = join(dir, "daemon-ready.json");
  const exitFilePath = join(dir, "daemon-exit.json");
  const statePath = statePathForHome(homeDir);

  mkdirSync(join(homeDir, ".plannotator"), { recursive: true });

  writeHarnessScript(
    daemonScriptPath,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { dirname } from "node:path";',
      "",
      "const readyFilePath = process.argv[2];",
      "const exitFilePath = process.argv[3];",
      "",
      "mkdirSync(dirname(readyFilePath), { recursive: true });",
      'writeFileSync(readyFilePath, JSON.stringify({ pid: process.pid, ppid: process.ppid }), "utf8");',
      "",
      "const exitCleanly = (signal) => {",
      '  writeFileSync(exitFilePath, JSON.stringify({ pid: process.pid, signal }), "utf8");',
      "  process.exit(0);",
      "};",
      "",
      'process.on("SIGTERM", () => exitCleanly("SIGTERM"));',
      'process.on("SIGINT", () => exitCleanly("SIGINT"));',
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
  );

  writeHarnessScript(
    driverScriptPath,
    [
      'import { readFileSync } from "node:fs";',
      "",
      "const action = process.argv[2];",
      "const moduleUrl = process.argv[3];",
      "const optionsPath = process.argv[4];",
      "const imported = await import(moduleUrl);",
      "const command = imported[action];",
      "",
      'if (typeof command !== "function") {',
      '  throw new Error(`packages/server/daemon.ts must export ${action}(options).`);',
      "}",
      "",
      'const options = JSON.parse(readFileSync(optionsPath, "utf8"));',
      "const result = await command(options);",
      "console.log(JSON.stringify(result ?? null));",
    ].join("\n"),
  );

  return {
    daemonScriptPath,
    driverScriptPath,
    exitFilePath,
    homeDir,
    lockfilePath,
    readyFilePath,
    statePath,
  };
}

function buildDaemonLaunchOptions(harness: LifecycleHarness): DaemonLaunchOptions {
  return {
    childCommand: [
      bunExecutable,
      harness.daemonScriptPath,
      harness.readyFilePath,
      harness.exitFilePath,
    ],
    cwd: repoRoot,
    env: {
      PLANNOTATOR_NIM16: "true",
    },
    lockfilePath: harness.lockfilePath,
    pollIntervalMs: 50,
    startTimeoutMs: 10_000,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 10_000,
  };
}

async function probeDaemonModule(): Promise<DaemonModuleGate> {
  let imported: unknown;

  try {
    imported = await import(daemonModuleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: [
        "NIM-16 expects packages/server/daemon.ts to exist and export runDaemon(), startDaemonDetached(), stopDaemon(), and daemonStatus().",
        `Import failed: ${message}`,
      ].join("\n"),
    };
  }

  const candidate = imported as Partial<DaemonModule>;
  if (
    typeof candidate.runDaemon !== "function" ||
    typeof candidate.startDaemonDetached !== "function" ||
    typeof candidate.stopDaemon !== "function" ||
    typeof candidate.daemonStatus !== "function"
  ) {
    return {
      available: false,
      reason:
        "packages/server/daemon.ts must export runDaemon(), startDaemonDetached(), stopDaemon(), and daemonStatus().",
    };
  }

  return {
    available: true,
    module: candidate as DaemonModule,
  };
}

const daemonModuleGate = await probeDaemonModule();

async function runDaemonCommand(
  harness: LifecycleHarness,
  action: "startDaemonDetached" | "daemonStatus" | "stopDaemon",
): Promise<DaemonCommandResult> {
  const optionsPath = join(dirname(harness.driverScriptPath), `${action}.options.json`);
  writeFileSync(
    optionsPath,
    JSON.stringify(buildDaemonLaunchOptions(harness), null, 2),
    "utf8",
  );

  const result = await runBunProcess(
    [harness.driverScriptPath, action, daemonModuleUrl, optionsPath],
    harness.homeDir,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `${action} failed with exit code ${result.exitCode}.`,
        "",
        "--- stdout ---",
        result.stdout,
        "",
        "--- stderr ---",
        result.stderr,
      ].join("\n"),
    );
  }

  return JSON.parse(result.stdout.trim()) as DaemonCommandResult;
}

async function runBunProcess(args: string[], homeDir: string): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(bunExecutable, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`);
}

function readLockfilePid(lockfilePath: string): number {
  if (!existsSync(lockfilePath)) {
    throw new Error(`Expected lockfile at ${lockfilePath}.`);
  }

  const parsed = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
    pid?: unknown;
  };

  if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error(`Expected ${lockfilePath} to contain a positive integer pid.`);
  }

  return parsed.pid;
}

function writePersistedState(homeDir: string, state: DaemonState): void {
  const stateDir = join(homeDir, ".plannotator");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePathForHome(homeDir), JSON.stringify(state), "utf8");
}

function readPersistedState(homeDir: string): DaemonState {
  return JSON.parse(readFileSync(statePathForHome(homeDir), "utf8")) as DaemonState;
}

async function cleanupHarnessProcess(harness: LifecycleHarness): Promise<void> {
  if (!existsSync(harness.lockfilePath)) {
    return;
  }

  const pid = readLockfilePid(harness.lockfilePath);
  if (!isPidAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGKILL");
  await waitForCondition(() => !isPidAlive(pid), 10_000, `pid ${pid} to exit during cleanup`);
}

describe("NIM-16 daemon lifecycle proof", () => {
  test("requires packages/server/daemon.ts before daemon lifecycle proof cases activate", () => {
    if (!daemonModuleGate.available) {
      throw new Error(daemonModuleGate.reason);
    }
  });

  if (!daemonModuleGate.available) {
    return;
  }

  test("startDaemonDetached launches a real daemon, writes a live lockfile, and leaves it running after the command exits", async () => {
    const harness = createLifecycleHarness();

    try {
      const started = await runDaemonCommand(harness, "startDaemonDetached");
      expect(started).toMatchObject({
        verdict: "started",
      });

      await waitForCondition(
        () => existsSync(harness.readyFilePath) && existsSync(harness.lockfilePath),
        10_000,
        "daemon ready and lockfile creation",
      );

      const pid = readLockfilePid(harness.lockfilePath);
      expect(started.pid).toBe(pid);
      expect(isPidAlive(pid)).toBe(true);
    } finally {
      await cleanupHarnessProcess(harness);
    }
  }, CASE_TIMEOUT_MS);

  test("daemonStatus reports running while the locked pid passes a real signal-0 liveness check", async () => {
    const harness = createLifecycleHarness();

    try {
      const started = await runDaemonCommand(harness, "startDaemonDetached");
      await waitForCondition(() => existsSync(harness.lockfilePath), 10_000, "lockfile creation");
      const pid = readLockfilePid(harness.lockfilePath);
      expect(started.pid).toBe(pid);
      expect(isPidAlive(pid)).toBe(true);

      const status = await runDaemonCommand(harness, "daemonStatus");
      expect(status).toMatchObject({
        verdict: "running",
        pid,
      });
    } finally {
      await cleanupHarnessProcess(harness);
    }
  }, CASE_TIMEOUT_MS);

  test("stopDaemon sends a real signal, waits for exit, and clears the lockfile for later restarts", async () => {
    const harness = createLifecycleHarness();

    const started = await runDaemonCommand(harness, "startDaemonDetached");
    await waitForCondition(() => existsSync(harness.lockfilePath), 10_000, "lockfile creation");
    const pid = readLockfilePid(harness.lockfilePath);

    try {
      expect(started.pid).toBe(pid);
      expect(isPidAlive(pid)).toBe(true);

      const stopped = await runDaemonCommand(harness, "stopDaemon");
      expect(stopped).toMatchObject({
        verdict: "stopped",
        pid,
      });

      await waitForCondition(() => !isPidAlive(pid), 10_000, `pid ${pid} to exit`);
      expect(existsSync(harness.exitFilePath)).toBe(true);
      expect(existsSync(harness.lockfilePath)).toBe(false);

      const status = await runDaemonCommand(harness, "daemonStatus");
      expect(status).toMatchObject({
        verdict: "stopped",
      });
    } finally {
      if (isPidAlive(pid)) {
        await cleanupHarnessProcess(harness);
      }
    }
  }, CASE_TIMEOUT_MS);

  test("daemonStatus treats a dead locked pid as recovered, removes the stale lockfile, and allows a clean restart", async () => {
    const harness = createLifecycleHarness();
    const started = await runDaemonCommand(harness, "startDaemonDetached");

    await waitForCondition(() => existsSync(harness.lockfilePath), 10_000, "lockfile creation");
    const crashedPid = readLockfilePid(harness.lockfilePath);
    expect(started.pid).toBe(crashedPid);

    process.kill(crashedPid, "SIGKILL");
    await waitForCondition(() => !isPidAlive(crashedPid), 10_000, `pid ${crashedPid} to crash`);

    const recovered = await runDaemonCommand(harness, "daemonStatus");
    expect(recovered).toMatchObject({
      verdict: "recovered",
    });
    expect(existsSync(harness.lockfilePath)).toBe(false);

    try {
      const restarted = await runDaemonCommand(harness, "startDaemonDetached");
      expect(restarted).toMatchObject({
        verdict: "started",
      });

      await waitForCondition(() => existsSync(harness.lockfilePath), 10_000, "replacement lockfile");
      const restartedPid = readLockfilePid(harness.lockfilePath);
      expect(restartedPid).not.toBe(crashedPid);
      expect(restarted.pid).toBe(restartedPid);
      expect(isPidAlive(restartedPid)).toBe(true);
    } finally {
      await cleanupHarnessProcess(harness);
    }
  }, CASE_TIMEOUT_MS);

  test("startDaemonDetached preserves an already resolved verdict when recovering persisted daemon state", async () => {
    const harness = createLifecycleHarness();
    writePersistedState(harness.homeDir, {
      schemaVersion: 1,
      status: "resolved",
      document: resolvedDocument,
      feedback: resolvedFeedback,
    });

    try {
      await runDaemonCommand(harness, "startDaemonDetached");
      await waitForCondition(() => existsSync(harness.lockfilePath), 10_000, "lockfile creation");

      expect(readPersistedState(harness.homeDir)).toEqual({
        schemaVersion: 1,
        status: "resolved",
        document: resolvedDocument,
        feedback: resolvedFeedback,
      });
    } finally {
      await cleanupHarnessProcess(harness);
    }
  }, CASE_TIMEOUT_MS);

  test("daemonStatus downgrades a stale awaiting-response verdict into a cancelled resolved verdict during recovery", async () => {
    const harness = createLifecycleHarness();

    writePersistedState(harness.homeDir, {
      schemaVersion: 1,
      status: "awaiting-response",
      document: staleReviewDocument,
      feedback: null,
    });

    const started = await runDaemonCommand(harness, "startDaemonDetached");
    await waitForCondition(() => existsSync(harness.lockfilePath), 10_000, "lockfile creation");
    const crashedPid = readLockfilePid(harness.lockfilePath);
    expect(started.pid).toBe(crashedPid);

    process.kill(crashedPid, "SIGKILL");
    await waitForCondition(() => !isPidAlive(crashedPid), 10_000, `pid ${crashedPid} to crash`);

    const recovered = await runDaemonCommand(harness, "daemonStatus");
    expect(recovered).toMatchObject({
      verdict: "recovered",
    });

    const recoveredState = readPersistedState(harness.homeDir);
    expect(recoveredState.status).toBe("resolved");
    expect(recoveredState.document).toEqual(staleReviewDocument);
    expect(recoveredState.feedback).toMatchObject({
      approved: false,
      cancelled: true,
    });
    expect(Array.isArray(recoveredState.feedback?.annotations)).toBe(true);
  }, CASE_TIMEOUT_MS);
});
