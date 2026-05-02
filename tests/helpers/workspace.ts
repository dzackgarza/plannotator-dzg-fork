import { cpSync, existsSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "./paths";
import { createTempDir } from "./tempdir";

export function assertLocalDependenciesPresent(): void {
  const nodeModulesPath = join(repoRoot, "node_modules");
  if (existsSync(nodeModulesPath)) {
    return;
  }

  throw new Error(
    "Missing local workspace dependencies: run `bun install` before executing the proof harness.",
  );
}

export type DisposableWorkspaceOptions = {
  prefix?: string;
  excludeTopLevel?: ReadonlyArray<string>;
};

export function createDisposableWorkspace(
  options: DisposableWorkspaceOptions = {},
): string {
  assertLocalDependenciesPresent();

  const baseDir = createTempDir(options.prefix ?? "plannotator-workspace-");
  const workspaceRoot = join(baseDir, "workspace");
  const exclude = new Set(options.excludeTopLevel ?? [".git", "node_modules"]);

  cpSync(repoRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (!rel) {
        return true;
      }
      const topLevel = rel.split("/")[0];
      return !exclude.has(topLevel);
    },
  });

  symlinkSync(
    join(repoRoot, "node_modules"),
    join(workspaceRoot, "node_modules"),
    "dir",
  );

  return workspaceRoot;
}
