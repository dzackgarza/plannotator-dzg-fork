import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type CommandResult = {
  script: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type TopLevelViolations = {
  docHits: string[];
  presentScripts: string[];
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bunExecutable = Bun.which("bun") ?? "bun";

const disallowedRepoPaths = [
  "apps/marketing",
  "apps/paste-service",
  "apps/pi-extension",
  "apps/portal",
  "packages/server/remote.ts",
  "packages/server/share-url.ts",
  "packages/ui/hooks/useSharing.ts",
  "packages/ui/utils/sharing.ts",
];

const disallowedTopLevelScripts = [
  "build:marketing",
  "build:pi",
  "build:portal",
  "dev:marketing",
  "dev:portal",
];

const disallowedDocMarkers = [
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_PASTE_URL",
  "PLANNOTATOR_SHARE_URL",
  "apps/marketing",
  "apps/paste-service",
  "apps/pi-extension",
  "apps/portal",
  "share.plannotator.ai",
];

const localBuildArtifacts = [
  "apps/hook/dist/index.html",
  "apps/opencode-plugin/plannotator.html",
  "apps/opencode-plugin/review-editor.html",
  "apps/review/dist/index.html",
];

const builtUiArtifacts = [
  "apps/hook/dist/index.html",
  "apps/opencode-plugin/plannotator.html",
  "apps/opencode-plugin/review-editor.html",
];

const bannedBuiltUiMarkers = [
  "Import Teammate Review",
  "Paste a share link from a teammate",
  "Plannotator Share Link",
  "share.plannotator.ai",
];

const tempDirs: string[] = [];
let localBuildsPromise: Promise<{ results: CommandResult[]; workspaceRoot: string }> | undefined;

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readRootFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function collectPresentRepoPaths(): string[] {
  return disallowedRepoPaths.filter((relativePath) =>
    existsSync(join(repoRoot, relativePath)),
  );
}

function collectTopLevelViolations(root: string): TopLevelViolations {
  const packageJson = JSON.parse(readRootFile(root, "package.json")) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};
  const presentScripts = disallowedTopLevelScripts.filter((name) => name in scripts);

  const docFiles = ["README.md", "CLAUDE.md"];
  const docHits: string[] = [];

  for (const docFile of docFiles) {
    const content = readRootFile(root, docFile);
    for (const marker of disallowedDocMarkers) {
      if (content.includes(marker)) {
        docHits.push(`${docFile}:${marker}`);
      }
    }
  }

  return { docHits, presentScripts };
}

function shouldDeferBuildProof(): boolean {
  const repoPathHits = collectPresentRepoPaths();
  const topLevelViolations = collectTopLevelViolations(repoRoot);

  return (
    repoPathHits.length > 0 ||
    topLevelViolations.docHits.length > 0 ||
    topLevelViolations.presentScripts.length > 0
  );
}

function createDisposableWorkspace(): string {
  const baseDir = mkdtempSync(join(tmpdir(), "plannotator-nim13-"));
  const workspaceRoot = join(baseDir, "workspace");
  tempDirs.push(baseDir);

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

  const sourceNodeModules = join(repoRoot, "node_modules");
  if (!existsSync(sourceNodeModules)) {
    throw new Error("Missing local workspace dependencies: run bun install before executing the build proof.");
  }

  symlinkSync(sourceNodeModules, join(workspaceRoot, "node_modules"), "dir");

  return workspaceRoot;
}

async function runBunScript(cwd: string, script: string): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [bunExecutable, "run", script],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  return { script, exitCode, stdout, stderr };
}

async function ensureLocalBuilds(): Promise<{ results: CommandResult[]; workspaceRoot: string }> {
  if (!localBuildsPromise) {
    localBuildsPromise = (async () => {
      const workspaceRoot = createDisposableWorkspace();
      const results: CommandResult[] = [];
      results.push(await runBunScript(workspaceRoot, "build:review"));
      results.push(await runBunScript(workspaceRoot, "build:hook"));
      results.push(await runBunScript(workspaceRoot, "build:opencode"));
      return { results, workspaceRoot };
    })();
  }

  return await localBuildsPromise;
}

function assertCommandSucceeded(result: CommandResult): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `bun run ${result.script} failed with exit code ${result.exitCode}.`,
      "",
      "--- stdout ---",
      result.stdout,
      "",
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  );
}

describe("NIM-13 remote-surface deletion proof", () => {
  test("removes the remote/share source surface from the repo tree", () => {
    const presentPaths = collectPresentRepoPaths();
    expect(presentPaths).toEqual([]);
  });

  test("removes top-level remote/share scripts and doc references", () => {
    const violations = collectTopLevelViolations(repoRoot);

    // AGENTS.md is intentionally excluded from this proof because the task
    // explicitly forbids editing it during S-1 implementation.
    expect(violations).toEqual({
      docHits: [],
      presentScripts: [],
    });
  });

  test("once the S-1 deletion gates are clean, the surviving local build commands stay green", async () => {
    if (shouldDeferBuildProof()) {
      return;
    }

    const { results, workspaceRoot } = await ensureLocalBuilds();
    for (const result of results) {
      assertCommandSucceeded(result);
    }

    const missingArtifacts = localBuildArtifacts.filter((relativePath) => {
      return !existsSync(join(workspaceRoot, relativePath));
    });

    expect(missingArtifacts).toEqual([]);
  }, 120_000);

  test("once the S-1 deletion gates are clean, built local UIs no longer ship sharing affordances", async () => {
    if (shouldDeferBuildProof()) {
      return;
    }

    const { results, workspaceRoot } = await ensureLocalBuilds();
    for (const result of results) {
      assertCommandSucceeded(result);
    }

    const hits: string[] = [];

    for (const relativePath of builtUiArtifacts) {
      const content = readRootFile(workspaceRoot, relativePath);
      for (const marker of bannedBuiltUiMarkers) {
        if (content.includes(marker)) {
          hits.push(`${relativePath}:${marker}`);
        }
      }
    }

    expect(hits).toEqual([]);
  }, 120_000);
});
