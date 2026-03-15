import { $, type ShellOutput } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer } from "./review";
import { getGitContext, runGitDiff } from "./git";

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["PLANNOTATOR_REMOTE", "PLANNOTATOR_PORT", "SSH_TTY", "SSH_CONNECTION"];

function clearReviewServerEnv() {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function createTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-review-server-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/app.ts"),
    "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
  );
  return root;
}

async function runGit(command: ShellOutput): Promise<void> {
  const result = await command.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

async function createCommittedRepo(): Promise<string> {
  const root = createTempRepo();
  await runGit($`git init -b main`.cwd(root));
  await runGit($`git config user.name Plannotator Tests`.cwd(root));
  await runGit($`git config user.email tests@example.com`.cwd(root));
  await runGit($`git add src/app.ts`.cwd(root));
  await runGit($`git commit -m initial`.cwd(root));

  writeFileSync(
    join(root, "src/app.ts"),
    "export function greet(name: string) {\n  return `hello, ${name}!`;\n}\n",
  );
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const key of envKeys) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe("startReviewServer", () => {
  test("uses explicit cwd for diff switching and file content lookup", async () => {
    clearReviewServerEnv();
    const repo = await createCommittedRepo();
    const gitContext = await getGitContext(repo);
    const initialDiff = await runGitDiff("uncommitted", gitContext.defaultBranch, repo);

    const previousCwd = process.cwd();
    const unrelatedDir = mkdtempSync(join(tmpdir(), "plannotator-review-server-outside-"));
    tempDirs.push(unrelatedDir);
    process.chdir(unrelatedDir);

    try {
      const server = await startReviewServer({
        rawPatch: initialDiff.patch,
        gitRef: initialDiff.label,
        diffType: "uncommitted",
        gitContext,
        htmlContent: "<html></html>",
        cwd: repo,
      });

      try {
        const switchResponse = await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "uncommitted" }),
        });
        expect(switchResponse.ok).toBe(true);
        const switched = await switchResponse.json();
        expect(switched.rawPatch).toContain("hello, ${name}!");
        expect(switched.rawPatch).toContain("hello ${name}");

        const fileResponse = await fetch(
          `${server.url}/api/file-content?path=src/app.ts`,
        );
        expect(fileResponse.ok).toBe(true);
        const fileContents = await fileResponse.json();
        expect(fileContents.oldContent).toContain("hello ${name}");
        expect(fileContents.newContent).toContain("hello, ${name}!");
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
});
