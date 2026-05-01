import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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

type CompiledBinary = {
  binaryPath: string;
  workspaceRoot: string;
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bunExecutable = Bun.which("bun") ?? "bun";
const tempDirs: string[] = [];
const BUILD_TIMEOUT_MS = 240_000;
const COMMAND_TIMEOUT_MS = 30_000;

let compiledBinaryPromise: Promise<CompiledBinary> | undefined;

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

function isPlannotatorDependencyRoot(candidate: string): boolean {
  if (!existsSync(join(candidate, "node_modules"))) {
    return false;
  }

  // The repo only counts as a valid dependency root if its package.json
  // identifies the plannotator workspace; any random ancestor node_modules
  // (e.g. /home/<user>/node_modules) must be ignored.
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return pkg.name === "plannotator";
  } catch {
    return false;
  }
}

function resolveDependencyRoot(): string | null {
  if (isPlannotatorDependencyRoot(repoRoot)) {
    return repoRoot;
  }

  // Bun worktree convention used in this repo:
  //   /<parent>/<repo>_worktrees/<branch>/
  // The shared dependency tree always lives in /<parent>/<repo>/, so peel the
  // trailing `_worktrees/<branch>` segment off the worktree path.
  const sep = process.platform === "win32" ? "\\" : "/";
  const trimmed = repoRoot.replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}$`), "");
  const segments = trimmed.split(sep);
  if (segments.length >= 2) {
    const parentDirName = segments[segments.length - 2];
    if (parentDirName.endsWith("_worktrees")) {
      const projectDirName = parentDirName.slice(0, -"_worktrees".length);
      const projectPath = `${segments.slice(0, segments.length - 2).join(sep)}${sep}${projectDirName}`;
      if (isPlannotatorDependencyRoot(projectPath)) {
        return projectPath;
      }
    }
  }

  let current = repoRoot;
  for (let depth = 0; depth < 5; depth += 1) {
    const parent = join(current, "..");
    if (parent === current) {
      break;
    }
    if (isPlannotatorDependencyRoot(parent)) {
      return parent;
    }
    current = parent;
  }

  return null;
}

function ensureDependencyRoot(): string {
  const dependencyRoot = resolveDependencyRoot();
  if (!dependencyRoot) {
    throw new Error(
      "Missing local workspace dependencies: run `bun install` before executing the NIM-21 build proof.",
    );
  }
  return dependencyRoot;
}

function symlinkWorkspaceNodeModules(
  dependencyRoot: string,
  workspaceRoot: string,
  workspaceDirs: string[],
): void {
  for (const dir of workspaceDirs) {
    const source = join(dependencyRoot, dir, "node_modules");
    if (!existsSync(source)) {
      continue;
    }
    const destinationParent = join(workspaceRoot, dir);
    if (!existsSync(destinationParent)) {
      continue;
    }
    symlinkSync(source, join(destinationParent, "node_modules"), "dir");
  }
}

function createDisposableWorkspace(prefix: string): string {
  const dependencyRoot = ensureDependencyRoot();
  const baseDir = createTempDir(prefix);
  const workspaceRoot = join(baseDir, "workspace");

  cpSync(repoRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (!rel) {
        return true;
      }
      if (rel === ".git" || rel.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`)) {
        return false;
      }
      // Skip every node_modules directory in the source tree; we will splice
      // in symlinks to the dependency root's installed packages below.
      const segments = rel.split(process.platform === "win32" ? /[\\/]/ : "/");
      return !segments.includes("node_modules");
    },
  });

  symlinkSync(join(dependencyRoot, "node_modules"), join(workspaceRoot, "node_modules"), "dir");

  // Bun's workspace install layout places per-workspace node_modules under
  // each apps/* and packages/* directory; the build scripts resolve binaries
  // (vite, tsc, ...) through those directories, so we must mirror them.
  const workspaceDirs = ["apps/hook", "apps/review", "apps/opencode-plugin", "apps/vscode-extension"];
  symlinkWorkspaceNodeModules(dependencyRoot, workspaceRoot, workspaceDirs);

  const packagesDirs = [
    "packages/server",
    "packages/ui",
    "packages/editor",
    "packages/review-editor",
    "packages/shared",
  ];
  symlinkWorkspaceNodeModules(dependencyRoot, workspaceRoot, packagesDirs);

  return workspaceRoot;
}

function spawnCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { result: Promise<CommandResult>; terminate: (signal?: NodeJS.Signals) => void } {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
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

  return {
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

async function runCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  description: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const running = spawnCommand(command, cwd, env);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      running.result,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          running.terminate("SIGKILL");
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

async function ensureCompiledBinary(): Promise<CompiledBinary> {
  if (!compiledBinaryPromise) {
    compiledBinaryPromise = (async () => {
      const workspaceRoot = createDisposableWorkspace("plannotator-nim21-build-");

      // Mirror the README install flow: build the embedded HTML assets first
      // (build:hook chains build:review), then build the OpenCode plugin so the
      // documented "bun run build" path is exercised end-to-end.
      assertCommandSucceeded(
        await runCommand(
          [bunExecutable, "run", "build:hook"],
          workspaceRoot,
          process.env,
          "bun run build:hook",
          BUILD_TIMEOUT_MS,
        ),
        "bun run build:hook",
      );
      assertCommandSucceeded(
        await runCommand(
          [bunExecutable, "run", "build:opencode"],
          workspaceRoot,
          process.env,
          "bun run build:opencode",
          BUILD_TIMEOUT_MS,
        ),
        "bun run build:opencode",
      );

      const binaryPath = join(workspaceRoot, "plannotator-bin");
      assertCommandSucceeded(
        await runCommand(
          [
            bunExecutable,
            "build",
            "apps/hook/server/index.ts",
            "--compile",
            "--outfile",
            binaryPath,
          ],
          workspaceRoot,
          process.env,
          "bun build --compile apps/hook/server/index.ts",
          BUILD_TIMEOUT_MS,
        ),
        "bun build --compile apps/hook/server/index.ts",
      );

      return { binaryPath, workspaceRoot };
    })();
  }

  return compiledBinaryPromise;
}

function readPackageScripts(root: string): Record<string, string> {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  return packageJson.scripts ?? {};
}

function readPackageVersion(root: string): string {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { version?: string };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Top-level package.json is missing a version field.");
  }
  return packageJson.version;
}

describe("NIM-21 build, packaging, and install proof", () => {
  describe("primary build path stays free of portal/marketing dependencies", () => {
    test("top-level `bun run build` references only local app build targets", () => {
      const scripts = readPackageScripts(repoRoot);
      const buildScript = scripts.build ?? "";

      expect(buildScript.length).toBeGreaterThan(0);
      expect(buildScript).not.toContain("build:portal");
      expect(buildScript).not.toContain("build:marketing");
      expect(buildScript).not.toContain("build:pi");
    });

    test("portal, marketing, and pi-extension app directories are absent from the repo", () => {
      const banned = ["apps/portal", "apps/marketing", "apps/pi-extension"];
      const present = banned.filter((relativePath) =>
        existsSync(join(repoRoot, relativePath)),
      );
      expect(present).toEqual([]);
    });

    test("portal and marketing build/dev scripts are not declared", () => {
      const scripts = readPackageScripts(repoRoot);
      const banned = [
        "build:portal",
        "build:marketing",
        "build:pi",
        "dev:portal",
        "dev:marketing",
      ];
      const present = banned.filter((name) => name in scripts);
      expect(present).toEqual([]);
    });
  });

  describe("single-artifact compiled binary", () => {
    test("`bun build apps/hook/server/index.ts --compile` produces a single executable file", async () => {
      const { binaryPath } = await ensureCompiledBinary();

      expect(existsSync(binaryPath)).toBe(true);

      const stat = statSync(binaryPath);
      expect(stat.isFile()).toBe(true);
      // Bun's --compile target embeds the runtime; the resulting binary is
      // tens of MB on every supported platform. Anything substantially smaller
      // means we built a JS shim rather than a real single-artifact binary.
      expect(stat.size).toBeGreaterThan(5_000_000);

      // The binary must be directly executable on POSIX hosts. On Windows
      // statSync().mode does not carry the executable bit, so we skip that
      // check there but still proved size + isFile above.
      if (process.platform !== "win32") {
        const ownerExecutable = (stat.mode & 0o100) !== 0;
        expect(ownerExecutable).toBe(true);
      }
    }, BUILD_TIMEOUT_MS);
  });

  describe("compiled binary CLI surface", () => {
    test("`plannotator --help` exits 0 and prints usage text", async () => {
      const { binaryPath, workspaceRoot } = await ensureCompiledBinary();
      const homeDir = createTempDir("plannotator-nim21-help-home-");

      const result = await runCommand(
        [binaryPath, "--help"],
        workspaceRoot,
        { ...process.env, HOME: homeDir },
        "plannotator --help",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Usage:/);
      expect(result.stdout).toContain("plannotator");
    }, BUILD_TIMEOUT_MS);

    test("`plannotator --version` exits 0 and prints a semantic version string", async () => {
      // TODO: NIM-10 — the CLI must implement `--version` (and ideally `-V`).
      // Today `parseCommand` only handles `--help`/`-h`, so `--version` falls
      // through to the unknown-command branch and exits non-zero.
      const { binaryPath, workspaceRoot } = await ensureCompiledBinary();
      const homeDir = createTempDir("plannotator-nim21-version-home-");
      const expectedVersion = readPackageVersion(repoRoot);

      const result = await runCommand(
        [binaryPath, "--version"],
        workspaceRoot,
        { ...process.env, HOME: homeDir },
        "plannotator --version",
      );

      expect(result.exitCode).toBe(0);
      const trimmedStdout = result.stdout.trim();
      expect(trimmedStdout.length).toBeGreaterThan(0);
      expect(trimmedStdout).toMatch(/\d+\.\d+\.\d+/);
      // The printed version should track the workspace package.json so users
      // can correlate the binary they installed with the source they cloned.
      expect(trimmedStdout).toContain(expectedVersion);
    }, BUILD_TIMEOUT_MS);
  });

  describe("documented install flow", () => {
    test("binary copied to a PATH-resolvable bin dir as `plannotator` is callable end-to-end", async () => {
      const { binaryPath, workspaceRoot } = await ensureCompiledBinary();

      // Mirror the README's `cp plannotator ~/.local/bin/plannotator` step.
      const installRoot = createTempDir("plannotator-nim21-install-");
      const fakeBinDir = join(installRoot, "bin");
      mkdirSync(fakeBinDir, { recursive: true });
      const installedPath = join(fakeBinDir, "plannotator");
      copyFileSync(binaryPath, installedPath);
      chmodSync(installedPath, 0o755);

      expect(existsSync(installedPath)).toBe(true);

      const homeDir = createTempDir("plannotator-nim21-install-home-");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: homeDir,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      };

      const helpResult = await runCommand(
        ["plannotator", "--help"],
        workspaceRoot,
        env,
        "installed plannotator --help (PATH lookup)",
      );

      expect(helpResult.exitCode).toBe(0);
      expect(helpResult.stdout).toMatch(/Usage:/);
      expect(helpResult.stdout).toContain("plannotator");

      const versionResult = await runCommand(
        ["plannotator", "--version"],
        workspaceRoot,
        env,
        "installed plannotator --version (PATH lookup)",
      );

      expect(versionResult.exitCode).toBe(0);
      expect(versionResult.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    }, BUILD_TIMEOUT_MS);
  });
});
