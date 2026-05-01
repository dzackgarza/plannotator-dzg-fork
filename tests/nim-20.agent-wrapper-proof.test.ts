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
import { fileURLToPath } from "node:url";

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

type HookEnvelopeGate =
  | {
      available: true;
      workspace: BuiltWorkspace;
    }
  | {
      available: false;
      reason: string;
    };

type CliCapture = {
  argv: string[];
  stdin: string;
  cwd: string;
};

type PluginRunnerOutput = {
  ok: boolean;
  result?: string;
  error?: {
    message: string;
    stack?: string;
  };
  promptCount: number;
};

type SubmitShellOutGate =
  | {
      available: true;
      capture: CliCapture;
      runner: PluginRunnerOutput;
    }
  | {
      available: false;
      reason: string;
    };

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bunExecutable = Bun.which("bun") ?? "bun";
const browserExecutable = Bun.which("true") ?? "/usr/bin/true";
const tempDirs: string[] = [];
const CASE_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 15_000;
const SHELL_OUT_EXIT_CODE = 73;
const DIRECT_SERVER_START_FORBIDDEN =
  "NIM-20 forbids OpenCode submit_plan from calling startPlannotatorServer() directly. Shell out through the plannotator CLI instead.";

const hookPlanJson = JSON.stringify({
  permission_mode: "acceptEdits",
  tool_input: {
    plan: [
      "# NIM-20 Hook Envelope Plan",
      "",
      "1. Submit through the Claude hook wrapper.",
      "2. Wait for the daemon verdict.",
      "3. Emit the PermissionRequest envelope.",
    ].join("\n"),
    commit_message: "proof: hook envelope",
  },
});

let builtWorkspacePromise: Promise<BuiltWorkspace> | undefined;
let notificationHarnessBinDir: string | undefined;

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
  if (resolveNodeModulesPath()) {
    return;
  }

  throw new Error(
    "Missing local workspace dependencies: run `bun install` before executing the NIM-20 wrapper proof.",
  );
}

function resolveNodeModulesPath(): string | null {
  const directPath = join(repoRoot, "node_modules");
  if (existsSync(directPath)) {
    return directPath;
  }

  const worktreeMarker = `${process.platform === "win32" ? "\\\\" : "/"}_worktrees${process.platform === "win32" ? "\\\\" : "/"}`;
  const markerIndex = repoRoot.indexOf(worktreeMarker);
  if (markerIndex !== -1) {
    const primaryRepoPath = repoRoot.slice(0, markerIndex);
    const primaryNodeModulesPath = join(primaryRepoPath, "node_modules");
    if (existsSync(primaryNodeModulesPath)) {
      return primaryNodeModulesPath;
    }
  }

  let current = repoRoot;
  for (let depth = 0; depth < 5; depth++) {
    const parent = join(current, "..");
    if (parent === current) {
      break;
    }

    const candidate = join(parent, "node_modules");
    if (existsSync(candidate)) {
      return candidate;
    }
    current = parent;
  }

  return null;
}

function createDisposableWorkspace(prefix: string): string {
  assertLocalDependenciesPresent();
  const nodeModulesPath = resolveNodeModulesPath();
  if (!nodeModulesPath) {
    throw new Error("Expected local dependencies after assertLocalDependenciesPresent().");
  }

  const baseDir = createTempDir(prefix);
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

  symlinkSync(nodeModulesPath, join(workspaceRoot, "node_modules"), "dir");
  return workspaceRoot;
}

function cloneWorkspaceTemplate(templateRoot: string, prefix: string): string {
  const baseDir = createTempDir(prefix);
  const workspaceRoot = join(baseDir, "workspace");
  cpSync(templateRoot, workspaceRoot, { recursive: true });
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

async function runGit(workspaceRoot: string, ...args: string[]): Promise<CommandResult> {
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
      const workspaceRoot = createDisposableWorkspace("plannotator-nim20-built-");

      assertCommandSucceeded(
        await runCommand(
          [bunExecutable, "run", "build:review"],
          workspaceRoot,
          process.env,
          "bun run build:review",
          undefined,
          CASE_TIMEOUT_MS,
        ),
        "bun run build:review",
      );
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

      return { workspaceRoot };
    })();
  }

  return await builtWorkspacePromise;
}

function createHomeDir(): string {
  const homeDir = join(createTempDir("plannotator-nim20-home-"), "home");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(homeDir, ".plannotator"), { recursive: true });
  return homeDir;
}

function ensureNotificationHarnessBinDir(): string {
  if (notificationHarnessBinDir) {
    return notificationHarnessBinDir;
  }

  const binDir = join(createTempDir("plannotator-nim20-notify-"), "bin");
  mkdirSync(binDir, { recursive: true });

  const notifySendPath = join(binDir, "notify-send");
  writeFileSync(notifySendPath, ["#!/bin/sh", "exit 0", ""].join("\n"), "utf8");
  chmodSync(notifySendPath, 0o755);

  notificationHarnessBinDir = binDir;
  return binDir;
}

function cliEnv(homeDir: string, workspaceRoot: string): NodeJS.ProcessEnv {
  const notifyBinDir = ensureNotificationHarnessBinDir();
  return {
    ...process.env,
    HOME: homeDir,
    PLANNOTATOR_BROWSER: browserExecutable,
    PLANNOTATOR_CWD: workspaceRoot,
    PATH: `${notifyBinDir}:${process.env.PATH ?? ""}`,
  };
}

async function runCli(
  workspaceRoot: string,
  homeDir: string,
  args: string[],
  stdinText?: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return await runCommand(
    [bunExecutable, "run", "apps/hook/server/index.ts", ...args],
    workspaceRoot,
    cliEnv(homeDir, workspaceRoot),
    `plannotator ${args.join(" ") || "<default>"}`,
    stdinText,
    timeoutMs,
  );
}

function spawnCli(
  workspaceRoot: string,
  homeDir: string,
  args: string[],
  stdinText?: string,
): RunningCommand {
  return spawnCommand(
    [bunExecutable, "run", "apps/hook/server/index.ts", ...args],
    workspaceRoot,
    cliEnv(homeDir, workspaceRoot),
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

async function waitForActiveSession(homeDir: string): Promise<SessionInfo> {
  await waitForCondition(
    () => readSessions(homeDir).some((session) => session.mode === "plan"),
    SESSION_TIMEOUT_MS,
    "active plan session file",
  );

  const session = readSessions(homeDir).find((entry) => entry.mode === "plan");
  if (!session) {
    throw new Error("Expected an active plan session file, but none were present.");
  }

  return session;
}

async function postPlanApproval(url: string, feedback: string, permissionMode: string): Promise<Response> {
  return await fetch(`${url}/api/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback,
      annotations: [],
      permissionMode,
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

function parseHookEnvelope(stdout: string) {
  return JSON.parse(stdout) as {
    hookSpecificOutput?: {
      hookEventName?: string;
      decision?: {
        behavior?: string;
        message?: string;
        updatedPermissions?: Array<Record<string, unknown>>;
      };
    };
  };
}

async function probeHookEnvelopeSurface(): Promise<HookEnvelopeGate> {
  const workspace = await ensureBuiltWorkspace();
  const homeDir = createHomeDir();
  const probe = spawnCli(workspace.workspaceRoot, homeDir, [], hookPlanJson);

  try {
    let session: SessionInfo;
    try {
      session = await waitForActiveSession(homeDir);
    } catch (error) {
      probe.terminate("SIGTERM");
      const result = await waitForResult(
        probe.result,
        5_000,
        "hook envelope probe command to exit after missing session file",
      ).catch(() => null);
      const message = error instanceof Error ? error.message : String(error);

      return {
        available: false,
        reason: [
          "NIM-20 expects the default Claude hook wrapper to accept a real stdin hook event and register a review session before verdict handling begins.",
          "",
          message,
          result ? `exit ${result.exitCode}` : "exit <unknown>",
          result?.stdout ? `stdout: ${result.stdout.trimEnd()}` : "stdout: <empty>",
          result?.stderr ? `stderr: ${result.stderr.trimEnd()}` : "stderr: <empty>",
        ].join("\n"),
      };
    }

    const approval = await postPlanApproval(
      session.url,
      "Probe approval for NIM-20 hook envelope gate.",
      "acceptEdits",
    );
    if (approval.status !== 200) {
      const body = await approval.text();
      return {
        available: false,
        reason: [
          "NIM-20 expects the default Claude hook wrapper to accept a real stdin hook event and stay alive until a daemon verdict arrives.",
          "",
          `POST ${session.url}/api/approve returned ${approval.status}.`,
          body,
        ].join("\n"),
      };
    }

    const result = await waitForResult(
      probe.result,
      CASE_TIMEOUT_MS,
      "hook envelope probe command to exit",
    );
    if (result.exitCode !== 0) {
      return {
        available: false,
        reason: [
          "NIM-20 expects the default Claude hook wrapper to return a PermissionRequest envelope on stdout after approval.",
          "",
          `exit ${result.exitCode}`,
          result.stdout ? `stdout: ${result.stdout.trimEnd()}` : "stdout: <empty>",
          result.stderr ? `stderr: ${result.stderr.trimEnd()}` : "stderr: <empty>",
        ].join("\n"),
      };
    }
  } finally {
    probe.terminate("SIGKILL");
  }

  return {
    available: true,
    workspace,
  };
}

function addCliCaptureGuard(workspaceRoot: string): void {
  const filePath = join(workspaceRoot, "apps/hook/server/index.ts");
  const source = readFileSync(filePath, "utf8");
  const guard = [
    'if (process.env.NIM20_CAPTURE_PATH) {',
    '  const stdin = await Bun.stdin.text();',
    "  await Bun.write(",
    "    process.env.NIM20_CAPTURE_PATH,",
    '    JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }),',
    "  );",
    '  process.exit(Number.parseInt(process.env.NIM20_FAKE_EXIT_CODE ?? "73", 10));',
    "}",
    "",
  ].join("\n");
  writeFileSync(filePath, `${guard}${source}`, "utf8");
}

function injectDirectStartGuard(
  workspaceRoot: string,
  relativePath: string,
  exportedFunctionName: string,
  message: string,
): void {
  const filePath = join(workspaceRoot, relativePath);
  const lines = readFileSync(filePath, "utf8").split("\n");
  const signatureLine = lines.findIndex((line) =>
    line.includes(`export async function ${exportedFunctionName}`),
  );
  if (signatureLine === -1) {
    throw new Error(`Could not find ${exportedFunctionName} in ${relativePath}.`);
  }

  const openingBraceLine = lines.findIndex(
    (line, index) => index >= signatureLine && line.includes("{"),
  );
  if (openingBraceLine === -1) {
    throw new Error(`Could not find ${exportedFunctionName} opening brace in ${relativePath}.`);
  }

  lines.splice(openingBraceLine + 1, 0, `  throw new Error(${JSON.stringify(message)});`);
  writeFileSync(filePath, lines.join("\n"), "utf8");
}

function createSubmitPlanFixtureWorkspace(): string {
  const workspaceRoot = createDisposableWorkspace("plannotator-nim20-submit-");

  const docsDir = join(workspaceRoot, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "design.md"), "# Design\n\nWrapper target.\n", "utf8");

  const srcDir = join(workspaceRoot, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "app.ts"),
    "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
    "utf8",
  );

  return workspaceRoot;
}

function createPlannotatorShim(workspaceRoot: string): string {
  const binDir = join(createTempDir("plannotator-nim20-bin-"), "bin");
  mkdirSync(binDir, { recursive: true });

  const shimPath = join(binDir, "plannotator");
  const cliPath = join(workspaceRoot, "apps/hook/server/index.ts");
  writeFileSync(
    shimPath,
    ["#!/bin/sh", `exec "${bunExecutable}" run "${cliPath}" "$@"`, ""].join("\n"),
    "utf8",
  );
  chmodSync(shimPath, 0o755);

  return binDir;
}

function rewriteWorkspaceServerPackageManifest(workspaceRoot: string): void {
  const packageJsonPath = join(workspaceRoot, "packages", "server", "package.json");

  writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: "@plannotator/server",
        private: true,
        type: "module",
        exports: {
          ".": "./index.ts",
          "./review": "./review.ts",
          "./annotate": "./annotate.ts",
          "./remote": "./remote/index.ts",
          "./port": "./port.ts",
          "./browser": "./browser.ts",
          "./daemon": "./daemon.ts",
          "./notify": "./notify.ts",
          "./state": "./state.ts",
          "./storage": "./storage.ts",
          "./git": "./git.ts",
          "./repo": "./repo.ts",
          "./resolve-file": "./resolve-file.ts",
          "./sessions": "./sessions.ts",
          "./project": "./project.ts",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createSubmitPlanRunner(workspaceRoot: string): string {
  const runnerPath = join(workspaceRoot, "tests", "nim-20-opencode-submit-runner.ts");
  writeFileSync(
    runnerPath,
    [
      'import { writeFileSync } from "node:fs";',
      'import PlannotatorPlugin from "../apps/opencode-plugin/index.ts";',
      "",
      'const outputPath = process.env.NIM20_OUTPUT_PATH;',
      "if (!outputPath) {",
      '  throw new Error("Missing NIM20_OUTPUT_PATH.");',
      "}",
      "",
      "const prompts: unknown[] = [];",
      "const plugin = await PlannotatorPlugin({",
      "  directory: process.cwd(),",
      "  client: {",
      "    session: {",
      "      async prompt(request: unknown) {",
      "        prompts.push(request);",
      "        return {};",
      "      },",
      "      async messages() {",
      "        return { data: [] };",
      "      },",
      "    },",
      "    app: {",
      "      async agents() {",
      "        return { data: [] };",
      "      },",
      "      log() {},",
      "    },",
      "    tui: {",
      "      async executeCommand() {",
      "        return {};",
      "      },",
      "    },",
      "  },",
      "});",
      "",
      "try {",
      "  const result = await plugin.tool.submit_plan.execute(",
      "    {",
      '      plan: "# NIM-20 OpenCode Submit Plan\\n\\n1. Shell out through the CLI.\\n",',
      '      summary: "Proof wrapper shell-out",',
      '      commit_message: "proof: opencode submit shell-out",',
      "    },",
      "    {",
      '      sessionID: "nim-20-submit-session",',
      '      messageID: "message-1",',
      '      agent: "build",',
      "      abort: new AbortController().signal,",
      "      metadata() {},",
      "      async ask() {},",
      "    },",
      "  );",
      '  writeFileSync(outputPath, JSON.stringify({ ok: true, result, promptCount: prompts.length }), "utf8");',
      "} catch (error) {",
      "  const message = error instanceof Error ? error.message : String(error);",
      "  const stack = error instanceof Error ? error.stack : undefined;",
      '  writeFileSync(outputPath, JSON.stringify({ ok: false, error: { message, stack }, promptCount: prompts.length }), "utf8");',
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  return runnerPath;
}

async function runSubmitPlanShellOutProbe(): Promise<SubmitShellOutGate> {
  const workspaceRoot = createSubmitPlanFixtureWorkspace();
  const homeDir = createHomeDir();
  await initializeDisposableGitRepo(workspaceRoot);

  writeFileSync(
    join(workspaceRoot, "src", "app.ts"),
    "export function greet(name: string) {\n  return `hello, ${name}!`;\n}\n",
    "utf8",
  );

  addCliCaptureGuard(workspaceRoot);
  injectDirectStartGuard(
    workspaceRoot,
    "packages/server/index.ts",
    "startPlannotatorServer",
    DIRECT_SERVER_START_FORBIDDEN,
  );
  rewriteWorkspaceServerPackageManifest(workspaceRoot);

  const binDir = createPlannotatorShim(workspaceRoot);
  const outputPath = join(createTempDir("plannotator-nim20-submit-output-"), "result.json");
  const capturePath = join(createTempDir("plannotator-nim20-submit-capture-"), "capture.json");
  const runnerPath = createSubmitPlanRunner(workspaceRoot);
  const notifyBinDir = ensureNotificationHarnessBinDir();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    NIM20_CAPTURE_PATH: capturePath,
    NIM20_OUTPUT_PATH: outputPath,
    NIM20_FAKE_EXIT_CODE: String(SHELL_OUT_EXIT_CODE),
    PLANNOTATOR_PLAN_TIMEOUT_SECONDS: "1",
    PLANNOTATOR_BROWSER: browserExecutable,
    PLANNOTATOR_CWD: workspaceRoot,
    PATH: `${binDir}:${notifyBinDir}:${process.env.PATH ?? ""}`,
  };

  const result = await runCommand(
    [bunExecutable, "run", runnerPath],
    workspaceRoot,
    env,
    "OpenCode submit_plan shell-out probe",
    undefined,
    CASE_TIMEOUT_MS,
  );

  const runner = existsSync(outputPath)
    ? (JSON.parse(readFileSync(outputPath, "utf8")) as PluginRunnerOutput)
    : null;
  const capture = existsSync(capturePath)
    ? (JSON.parse(readFileSync(capturePath, "utf8")) as CliCapture)
    : null;

  if (!capture) {
    const runnerError = runner?.error?.message;
    if (runnerError?.includes(DIRECT_SERVER_START_FORBIDDEN)) {
      return {
        available: false,
        reason: [
          "NIM-20 expects the OpenCode `submit_plan` wrapper to shell out through the real plannotator CLI instead of calling daemon-general server startup in-process.",
          "",
          "Observed direct server-start path:",
          runnerError,
          "",
          `runner exit ${result.exitCode}`,
          result.stdout ? `stdout: ${result.stdout.trimEnd()}` : "stdout: <empty>",
          result.stderr ? `stderr: ${result.stderr.trimEnd()}` : "stderr: <empty>",
        ].join("\n"),
      };
    }

    return {
      available: false,
      reason: [
        "NIM-20 expected the OpenCode `submit_plan` wrapper to reach the public CLI, but no CLI capture was produced.",
        "",
        runner?.error?.message ? `runner error: ${runner.error.message}` : "runner error: <none>",
        `runner exit ${result.exitCode}`,
        result.stdout ? `stdout: ${result.stdout.trimEnd()}` : "stdout: <empty>",
        result.stderr ? `stderr: ${result.stderr.trimEnd()}` : "stderr: <empty>",
      ].join("\n"),
    };
  }

  return {
    available: true,
    capture,
    runner: runner ?? { ok: false, promptCount: 0 },
  };
}

const hookEnvelopeGate = await probeHookEnvelopeSurface();
const submitShellOutGate = await runSubmitPlanShellOutProbe();

function requireHookWorkspace(): BuiltWorkspace {
  if (!hookEnvelopeGate.available) {
    throw new Error(hookEnvelopeGate.reason);
  }

  return {
    workspaceRoot: cloneWorkspaceTemplate(
      hookEnvelopeGate.workspace.workspaceRoot,
      "plannotator-nim20-hook-",
    ),
  };
}

function requireSubmitShellOutGate(): Extract<SubmitShellOutGate, { available: true }> {
  if (!submitShellOutGate.available) {
    throw new Error(submitShellOutGate.reason);
  }

  return submitShellOutGate;
}

describe("NIM-20 agent wrapper proof", () => {
  test("defines the Claude hook envelope path before OpenCode wrapper shell-outs are implemented", () => {
    if (!hookEnvelopeGate.available) {
      throw new Error(hookEnvelopeGate.reason);
    }
  });

  test("requires OpenCode submit_plan to shell out through the public CLI instead of starting servers in-process", () => {
    if (!submitShellOutGate.available) {
      throw new Error(submitShellOutGate.reason);
    }
  });

  if (!hookEnvelopeGate.available) {
    return;
  }

  test("approved Claude hook submissions emit an allow envelope with updated permission mode", async () => {
    const workspace = requireHookWorkspace();
    const homeDir = createHomeDir();

    const command = spawnCli(workspace.workspaceRoot, homeDir, [], hookPlanJson);

    try {
      const session = await waitForActiveSession(homeDir);
      const approval = await postPlanApproval(
        session.url,
        "Approved through the NIM-20 hook proof.",
        "acceptEdits",
      );
      expect(approval.status).toBe(200);

      const result = await waitForResult(
        command.result,
        CASE_TIMEOUT_MS,
        "approved hook wrapper command to exit",
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const envelope = parseHookEnvelope(result.stdout);
      expect(envelope.hookSpecificOutput?.hookEventName).toBe("PermissionRequest");
      expect(envelope.hookSpecificOutput?.decision?.behavior).toBe("allow");
      expect(envelope.hookSpecificOutput?.decision?.updatedPermissions).toEqual([
        {
          type: "setMode",
          mode: "acceptEdits",
          destination: "session",
        },
      ]);
    } finally {
      command.terminate("SIGKILL");
    }
  }, CASE_TIMEOUT_MS);

  test("denied Claude hook submissions emit a deny envelope with the review feedback in-band", async () => {
    const workspace = requireHookWorkspace();
    const homeDir = createHomeDir();

    const command = spawnCli(workspace.workspaceRoot, homeDir, [], hookPlanJson);

    try {
      const session = await waitForActiveSession(homeDir);
      const denial = await postPlanDenial(
        session.url,
        "Please split the wrapper policy from daemon lifecycle logic.",
      );
      expect(denial.status).toBe(200);

      const result = await waitForResult(
        command.result,
        CASE_TIMEOUT_MS,
        "denied hook wrapper command to exit",
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const envelope = parseHookEnvelope(result.stdout);
      expect(envelope.hookSpecificOutput?.hookEventName).toBe("PermissionRequest");
      expect(envelope.hookSpecificOutput?.decision?.behavior).toBe("deny");
      expect(envelope.hookSpecificOutput?.decision?.message).toContain(
        "YOUR PLAN WAS NOT APPROVED.",
      );
      expect(envelope.hookSpecificOutput?.decision?.message).toContain(
        "Please split the wrapper policy from daemon lifecycle logic.",
      );
    } finally {
      command.terminate("SIGKILL");
    }
  }, CASE_TIMEOUT_MS);

  if (!submitShellOutGate.available) {
    return;
  }

  test("OpenCode submit_plan shells out as `plannotator submit` and streams the plan payload through stdin JSON", () => {
    const gate = requireSubmitShellOutGate();
    expect(gate.capture.argv[0]).toBe("submit");

    const payload = JSON.parse(gate.capture.stdin) as {
      tool_input?: {
        plan?: string;
        commit_message?: string;
      };
    };

    expect(payload.tool_input?.plan).toContain("# NIM-20 OpenCode Submit Plan");
    expect(payload.tool_input?.commit_message).toBe("proof: opencode submit shell-out");
  });
});
