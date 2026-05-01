import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
};

type RunningCommand = {
  pid: number;
  result: Promise<CommandResult>;
  terminate: (signal?: NodeJS.Signals) => void;
};

type SessionInfo = {
  pid: number;
  port: number;
  url: string;
  mode: "plan" | "review" | "annotate";
  project: string;
  startedAt: string;
  label: string;
};

type BuiltWorkspace = {
  workspaceRoot: string;
};

type NotificationSurfaceGate =
  | {
      available: true;
    }
  | {
      available: false;
      reason: string;
    };

type NotificationCaptureHarness = {
  binDir: string;
  captureDir: string;
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const notifyModuleUrl = pathToFileURL(join(repoRoot, "packages/server/notify.ts")).href;
const bunExecutable = Bun.which("bun") ?? "bun";
const browserExecutable = Bun.which("true") ?? "/usr/bin/true";
const tempDirs: string[] = [];
const CASE_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 15_000;
const NOTIFICATION_TIMEOUT_MS = 15_000;
const VERDICT_SETTLE_MS = 500;

const submitPlanJson = JSON.stringify({
  tool_input: {
    plan: [
      "# NIM-19 Notification Proof Plan",
      "",
      "1. Start the daemon-backed submit flow.",
      "2. Capture the notification dispatch at idle -> in_review.",
      "3. Verify verdict transitions stay quiet.",
    ].join("\n"),
  },
});

let builtWorkspacePromise: Promise<BuiltWorkspace> | undefined;

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function assertLocalDependenciesPresent(): void {
  const nodeModulesPath = join(repoRoot, "node_modules");
  if (existsSync(nodeModulesPath)) {
    return;
  }

  throw new Error(
    "Missing local workspace dependencies: run `bun install` before executing the NIM-19 notification proof.",
  );
}

function createDisposableWorkspace(): string {
  assertLocalDependenciesPresent();

  const baseDir = createTempDir("plannotator-nim19-");
  const workspaceRoot = join(baseDir, "workspace");

  cpSync(repoRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (!rel) {
        return true;
      }

      const topLevel = rel.split("/")[0];
      return topLevel !== ".git" && topLevel !== "node_modules";
    },
  });

  symlinkSync(join(repoRoot, "node_modules"), join(workspaceRoot, "node_modules"), "dir");
  return workspaceRoot;
}

function spawnCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdinText?: string,
): RunningCommand {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  if (stdinText !== undefined) {
    child.stdin.write(stdinText);
  }
  child.stdin.end();

  return {
    pid: child.pid ?? -1,
    terminate(signal: NodeJS.Signals = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        // The process may have already exited.
      }
    },
    result: new Promise<CommandResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          signal,
        });
      });
    }),
  };
}

async function waitForResult(
  resultPromise: Promise<CommandResult>,
  timeoutMs: number,
  description: string,
): Promise<CommandResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function runCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  description: string,
  stdinText?: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const running = spawnCommand(command, cwd, env, stdinText);
  try {
    return await waitForResult(running.result, timeoutMs, description);
  } catch (error) {
    running.terminate("SIGKILL");
    throw error;
  }
}

async function runGit(
  workspaceRoot: string,
  ...args: string[]
): Promise<CommandResult> {
  return await runCommand(["git", ...args], workspaceRoot, process.env, `git ${args.join(" ")}`);
}

function assertCommandSucceeded(result: CommandResult, label: string): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `${label} failed with exit code ${result.exitCode}.`,
      "",
      "--- stdout ---",
      result.stdout,
      "",
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  );
}

async function initializeDisposableGitRepo(workspaceRoot: string): Promise<void> {
  assertCommandSucceeded(await runGit(workspaceRoot, "init", "-b", "main"), "git init");
  assertCommandSucceeded(
    await runGit(workspaceRoot, "config", "user.name", "Plannotator Tests"),
    "git config user.name",
  );
  assertCommandSucceeded(
    await runGit(workspaceRoot, "config", "user.email", "tests@example.com"),
    "git config user.email",
  );
  assertCommandSucceeded(await runGit(workspaceRoot, "add", "."), "git add");
  assertCommandSucceeded(
    await runGit(workspaceRoot, "commit", "-m", "baseline"),
    "git commit baseline",
  );
}

async function ensureBuiltWorkspace(): Promise<BuiltWorkspace> {
  if (!builtWorkspacePromise) {
    builtWorkspacePromise = (async () => {
      const workspaceRoot = createDisposableWorkspace();

      assertCommandSucceeded(
        await runCommand(
          [bunExecutable, "run", "build:hook"],
          workspaceRoot,
          process.env,
          "bun run build:hook",
          undefined,
          CASE_TIMEOUT_MS,
        ),
        "bun run build:hook",
      );

      await initializeDisposableGitRepo(workspaceRoot);

      return { workspaceRoot };
    })();
  }

  return await builtWorkspacePromise;
}

function createHomeDir(): string {
  const homeDir = join(createTempDir("plannotator-nim19-home-"), "home");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(homeDir, ".plannotator"), { recursive: true });
  return homeDir;
}

function cliEnv(
  homeDir: string,
  workspaceRoot: string,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    PATH: extraEnv.PATH ?? process.env.PATH,
    PLANNOTATOR_BROWSER: browserExecutable,
    PLANNOTATOR_CWD: workspaceRoot,
    ...extraEnv,
  };
}

function runCli(
  workspaceRoot: string,
  homeDir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  stdinText?: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return runCommand(
    [bunExecutable, "run", "apps/hook/server/index.ts", ...args],
    workspaceRoot,
    cliEnv(homeDir, workspaceRoot, extraEnv),
    `plannotator ${args.join(" ") || "<default>"}`,
    stdinText,
    timeoutMs,
  );
}

function spawnCli(
  workspaceRoot: string,
  homeDir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  stdinText?: string,
): RunningCommand {
  return spawnCommand(
    [bunExecutable, "run", "apps/hook/server/index.ts", ...args],
    workspaceRoot,
    cliEnv(homeDir, workspaceRoot, extraEnv),
    stdinText,
  );
}

function sessionsDir(homeDir: string): string {
  return join(homeDir, ".plannotator", "sessions");
}

function readSessions(homeDir: string): SessionInfo[] {
  const dir = sessionsDir(homeDir);
  if (!existsSync(dir)) {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const filePath = join(dir, entry);
    try {
      sessions.push(JSON.parse(readFileSync(filePath, "utf8")) as SessionInfo);
    } catch {
      // Corrupt or partially-written session files are not valid proof evidence.
    }
  }

  return sessions.sort(
    (left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
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

async function waitForActiveSession(
  homeDir: string,
  expectedMode: SessionInfo["mode"],
): Promise<SessionInfo> {
  await waitForCondition(() => {
    return readSessions(homeDir).some((session) => session.mode === expectedMode);
  }, SESSION_TIMEOUT_MS, `${expectedMode} active session file`);

  const match = readSessions(homeDir).find((session) => session.mode === expectedMode);
  if (!match) {
    throw new Error(`Expected an active ${expectedMode} session file, but none were present.`);
  }

  return match;
}

function createNotificationCaptureHarness(): NotificationCaptureHarness {
  const baseDir = createTempDir("plannotator-nim19-notify-");
  const binDir = join(baseDir, "bin");
  const captureDir = join(baseDir, "captures");
  const shimPath = join(binDir, "notify-send");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });

  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      "set -eu",
      'capture_dir=${PLANNOTATOR_NOTIFY_CAPTURE_DIR:?}',
      'capture_file=$(mktemp "$capture_dir/notify-send.XXXXXX")',
      "{",
      '  printf \'argv0=%s\\n\' \"$0\"',
      '  for arg in \"$@\"; do',
      '    printf \'%s\\n\' \"$arg\"',
      "  done",
      '} > "$capture_file"',
    ].join("\n"),
    "utf8",
  );
  chmodSync(shimPath, 0o755);

  return {
    binDir,
    captureDir,
  };
}

function readNotificationCaptures(captureDir: string): string[] {
  if (!existsSync(captureDir)) {
    return [];
  }

  return readdirSync(captureDir)
    .filter((entry) => entry.startsWith("notify-send."))
    .sort()
    .map((entry) => readFileSync(join(captureDir, entry), "utf8"));
}

async function waitForNotificationCount(
  captureDir: string,
  expectedCount: number,
  description: string,
): Promise<string[]> {
  await waitForCondition(() => {
    return readNotificationCaptures(captureDir).length === expectedCount;
  }, NOTIFICATION_TIMEOUT_MS, description);

  return readNotificationCaptures(captureDir);
}

async function postPlanApproval(url: string, feedback: string): Promise<Response> {
  return await fetch(`${url}/api/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback,
      annotations: [],
      permissionMode: "acceptEdits",
      planSave: {
        enabled: false,
      },
    }),
  });
}

async function postPlanDenial(url: string, feedback: string): Promise<Response> {
  return await fetch(`${url}/api/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback,
      annotations: [],
      planSave: {
        enabled: false,
      },
    }),
  });
}

async function stopDaemonIfRunning(
  workspaceRoot: string,
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  try {
    await runCli(workspaceRoot, homeDir, ["stop"], extraEnv, undefined, 10_000);
  } catch {
    // Best-effort cleanup only.
  }
}

async function terminateIfRunning(command: RunningCommand): Promise<void> {
  command.terminate("SIGTERM");

  try {
    await waitForResult(command.result, 5_000, `pid ${command.pid} to exit after SIGTERM`);
  } catch {
    command.terminate("SIGKILL");
    await waitForResult(command.result, 5_000, `pid ${command.pid} to exit after SIGKILL`);
  }
}

async function probeNotificationSurface(): Promise<NotificationSurfaceGate> {
  try {
    await import(notifyModuleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: [
        "NIM-19 expects packages/server/notify.ts to exist so the daemon-backed submit flow can dispatch platform notifications on idle -> in_review transitions.",
        `Import failed: ${message}`,
      ].join("\n"),
    };
  }

  return { available: true };
}

const notificationSurfaceGate = await probeNotificationSurface();

describe("NIM-19 notification proof", () => {
  test("defines packages/server/notify.ts before notification behavior proof cases activate", () => {
    if (!notificationSurfaceGate.available) {
      throw new Error(notificationSurfaceGate.reason);
    }
  });

  if (!notificationSurfaceGate.available) {
    return;
  }

  test(
    "fires one platform notification at idle -> in_review and stays quiet when approval resolves the plan verdict",
    async () => {
      const workspace = await ensureBuiltWorkspace();
      const homeDir = createHomeDir();
      const capture = createNotificationCaptureHarness();
      const extraEnv = {
        PATH: `${capture.binDir}:${process.env.PATH ?? ""}`,
        PLANNOTATOR_NOTIFY_CAPTURE_DIR: capture.captureDir,
      };
      const submit = spawnCli(
        workspace.workspaceRoot,
        homeDir,
        ["submit", "--no-browser"],
        extraEnv,
        submitPlanJson,
      );

      try {
        const session = await waitForActiveSession(homeDir, "plan");
        const preVerdictNotifications = await waitForNotificationCount(
          capture.captureDir,
          1,
          "one idle -> awaiting-response notification dispatch",
        );

        expect(preVerdictNotifications).toHaveLength(1);

        const approve = await postPlanApproval(
          session.url,
          "Notification proof approval should not emit a second desktop notification.",
        );
        expect(approve.status).toBe(200);

        const result = await waitForResult(
          submit.result,
          COMMAND_TIMEOUT_MS,
          "submit command to exit after approval",
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Notification proof approval");

        await Bun.sleep(VERDICT_SETTLE_MS);
        expect(readNotificationCaptures(capture.captureDir)).toHaveLength(1);
      } finally {
        await terminateIfRunning(submit).catch(() => {});
        await stopDaemonIfRunning(workspace.workspaceRoot, homeDir, extraEnv);
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "suppresses idle -> in_review notifications entirely when PLANNOTATOR_NOTIFY=0",
    async () => {
      const workspace = await ensureBuiltWorkspace();
      const homeDir = createHomeDir();
      const capture = createNotificationCaptureHarness();
      const extraEnv = {
        PATH: `${capture.binDir}:${process.env.PATH ?? ""}`,
        PLANNOTATOR_NOTIFY: "0",
        PLANNOTATOR_NOTIFY_CAPTURE_DIR: capture.captureDir,
      };
      const submit = spawnCli(
        workspace.workspaceRoot,
        homeDir,
        ["submit", "--no-browser"],
        extraEnv,
        submitPlanJson,
      );

      try {
        const session = await waitForActiveSession(homeDir, "plan");

        await Bun.sleep(VERDICT_SETTLE_MS);
        expect(readNotificationCaptures(capture.captureDir)).toHaveLength(0);

        const approve = await postPlanApproval(
          session.url,
          "Suppressed notification proof approval.",
        );
        expect(approve.status).toBe(200);

        const result = await waitForResult(
          submit.result,
          COMMAND_TIMEOUT_MS,
          "submit command to exit after approval under PLANNOTATOR_NOTIFY=0",
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");

        await Bun.sleep(VERDICT_SETTLE_MS);
        expect(readNotificationCaptures(capture.captureDir)).toHaveLength(0);
      } finally {
        await terminateIfRunning(submit).catch(() => {});
        await stopDaemonIfRunning(workspace.workspaceRoot, homeDir, extraEnv);
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "does not emit a second platform notification when denial resolves the plan verdict",
    async () => {
      const workspace = await ensureBuiltWorkspace();
      const homeDir = createHomeDir();
      const capture = createNotificationCaptureHarness();
      const extraEnv = {
        PATH: `${capture.binDir}:${process.env.PATH ?? ""}`,
        PLANNOTATOR_NOTIFY_CAPTURE_DIR: capture.captureDir,
      };
      const submit = spawnCli(
        workspace.workspaceRoot,
        homeDir,
        ["submit", "--no-browser"],
        extraEnv,
        submitPlanJson,
      );

      try {
        const session = await waitForActiveSession(homeDir, "plan");
        const preVerdictNotifications = await waitForNotificationCount(
          capture.captureDir,
          1,
          "one idle -> awaiting-response notification dispatch before denial",
        );

        expect(preVerdictNotifications).toHaveLength(1);

        const deny = await postPlanDenial(
          session.url,
          "Notification proof denial should not emit a second desktop notification.",
        );
        expect(deny.status).toBe(200);

        const result = await waitForResult(
          submit.result,
          COMMAND_TIMEOUT_MS,
          "submit command to exit after denial",
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Notification proof denial");

        await Bun.sleep(VERDICT_SETTLE_MS);
        expect(readNotificationCaptures(capture.captureDir)).toHaveLength(1);
      } finally {
        await terminateIfRunning(submit).catch(() => {});
        await stopDaemonIfRunning(workspace.workspaceRoot, homeDir, extraEnv);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
