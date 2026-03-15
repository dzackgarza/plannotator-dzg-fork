/**
 * Git utilities for code review
 *
 * Centralized git operations for diff collection and branch detection.
 * Used by both Claude Code hook and OpenCode plugin.
 */

import { $ } from "bun";

export type { DiffOption, WorktreeInfo, GitContext } from "@plannotator/shared/types";

export type DiffType =
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "branch"
  | `worktree:${string}`;

export interface DiffResult {
  patch: string;
  label: string;
  error?: string;
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(cwd?: string): Promise<string> {
  try {
    const command = $`git rev-parse --abbrev-ref HEAD`.quiet();
    const result = cwd ? await command.cwd(cwd) : await command;
    return result.text().trim();
  } catch {
    return "HEAD"; // Detached HEAD state
  }
}

/**
 * Detect the default branch (main, master, etc.)
 *
 * Strategy:
 * 1. Check origin's HEAD reference
 * 2. Fallback to checking if 'main' exists
 * 3. Final fallback to 'master'
 */
export async function getDefaultBranch(cwd?: string): Promise<string> {
  // Try origin's HEAD first (most reliable for repos with remotes)
  try {
    const command = $`git symbolic-ref refs/remotes/origin/HEAD`.quiet();
    const result = cwd ? await command.cwd(cwd) : await command;
    const ref = result.text().trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // No remote or no HEAD set - check local branches
  }

  // Fallback: check if main exists locally
  try {
    const command = $`git show-ref --verify refs/heads/main`.quiet();
    await (cwd ? command.cwd(cwd) : command);
    return "main";
  } catch {
    // main doesn't exist
  }

  // Final fallback
  return "master";
}

/**
 * List all git worktrees by parsing `git worktree list --porcelain`
 */
export async function getWorktrees(cwd?: string): Promise<WorktreeInfo[]> {
  try {
    const command = $`git worktree list --porcelain`.quiet().nothrow();
    const result = cwd ? await command.cwd(cwd) : await command;
    if (result.exitCode !== 0) return [];

    const text = result.text();
    const entries: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of text.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          entries.push({ path: current.path, head: current.head || "", branch: current.branch ?? null });
        }
        current = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace("refs/heads/", "");
      } else if (line === "detached") {
        current.branch = null;
      }
    }
    // Flush last entry
    if (current.path) {
      entries.push({ path: current.path, head: current.head || "", branch: current.branch ?? null });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Get git context including branch info and available diff options
 */
export async function getGitContext(cwd?: string): Promise<GitContext> {
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(cwd),
    getDefaultBranch(cwd),
  ]);

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "staged", label: "Staged changes" },
    { id: "unstaged", label: "Unstaged changes" },
    { id: "last-commit", label: "Last commit" },
  ];

  // Only show branch diff if not on default branch
  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }

  // Discover worktrees (exposed separately from diff options)
  const [worktrees, currentTreePath] = await Promise.all([
    getWorktrees(cwd),
    (async () => {
      const command = $`git rev-parse --show-toplevel`.quiet();
      const result = cwd ? await command.cwd(cwd) : await command;
      return result.text().trim();
    })().catch(() => null),
  ]);

  const otherWorktrees = worktrees.filter(wt => wt.path !== currentTreePath);

  return { currentBranch, defaultBranch, diffOptions, worktrees: otherWorktrees };
}

/**
 * Get diffs for untracked (new) files not yet added to git.
 *
 * `git diff HEAD` and `git diff` only show tracked files. Newly created files
 * that haven't been staged with `git add` are invisible to those commands.
 * This helper discovers them via `git ls-files --others --exclude-standard` and
 * generates a proper unified diff for each using `git diff --no-index`.
 *
 * Note: `git diff --no-index` exits with code 1 when files differ (standard git
 * behaviour), so we use `.nothrow()` to avoid treating that as an error.
 */
async function getUntrackedFileDiffs(srcPrefix = 'a/', dstPrefix = 'b/', cwd?: string): Promise<string> {
  try {
    const lsCmd = $`git ls-files --others --exclude-standard`.quiet();
    const output = (cwd ? await lsCmd.cwd(cwd) : await lsCmd).text();
    const files = output.trim().split('\n').filter((f) => f.length > 0);
    if (files.length === 0) return '';

    const diffs = await Promise.all(
      files.map(async (file) => {
        try {
          const diffCmd = $`git diff --no-index --src-prefix=${srcPrefix} --dst-prefix=${dstPrefix} /dev/null ${file}`
            .quiet()
            .nothrow();
          const result = cwd ? await diffCmd.cwd(cwd) : await diffCmd;
          return result.text();
        } catch {
          return '';
        }
      }),
    );
    return diffs.join('');
  } catch {
    return '';
  }
}

/**
 * Parse a worktree diff type like `worktree:/path:last-commit` into path + sub-type.
 * Falls back to `uncommitted` if no sub-type suffix (backwards compatible).
 */
const WORKTREE_SUB_TYPES = new Set(["uncommitted", "staged", "unstaged", "last-commit", "branch"]);

export function parseWorktreeDiffType(diffType: string): { path: string; subType: string } | null {
  if (!diffType.startsWith("worktree:")) return null;
  const rest = diffType.slice("worktree:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1) {
    const maybeSub = rest.slice(lastColon + 1);
    if (WORKTREE_SUB_TYPES.has(maybeSub)) {
      return { path: rest.slice(0, lastColon), subType: maybeSub };
    }
  }
  return { path: rest, subType: "uncommitted" };
}


/**
 * Run git diff with the specified type
 */
export async function runGitDiff(
  diffType: DiffType,
  defaultBranch: string = "main",
  cwd?: string,
): Promise<DiffResult> {
  let patch: string;
  let label: string;

  // Handle worktree diffs — run git commands in the worktree's directory
  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) {
      return { patch: "", label: "Worktree error", error: "Could not parse worktree diff type" };
    }

    const { path: wtPath, subType } = parsed;

    try {
      switch (subType) {
        case "uncommitted": {
          const trackedDiff = (await $`git diff HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          const untrackedDiff = await getUntrackedFileDiffs('a/', 'b/', wtPath);
          patch = trackedDiff + untrackedDiff;
          label = "Uncommitted changes";
          break;
        }
        case "last-commit": {
          const hasParent = (await $`git rev-parse --verify HEAD~1`.quiet().nothrow().cwd(wtPath)).exitCode === 0;
          if (hasParent) {
            patch = (await $`git diff HEAD~1..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          } else {
            // Initial commit — show full tree as diff
            patch = (await $`git diff --root HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          }
          label = "Last commit";
          break;
        }
        case "staged":
          patch = (await $`git diff --staged --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          label = "Staged changes";
          break;
        case "unstaged": {
          const trackedDiff = (await $`git diff --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          const untrackedDiff = await getUntrackedFileDiffs('a/', 'b/', wtPath);
          patch = trackedDiff + untrackedDiff;
          label = "Unstaged changes";
          break;
        }
        case "branch":
          patch = (await $`git diff ${defaultBranch}..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          label = `Changes vs ${defaultBranch}`;
          break;
        default:
          patch = "";
          label = "Unknown worktree diff type";
      }

      // Prefix label with worktree branch name for context
      try {
        const branch = (await $`git rev-parse --abbrev-ref HEAD`.quiet().cwd(wtPath)).text().trim();
        label = `${branch}: ${label}`;
      } catch {
        label = `${wtPath.split("/").pop()}: ${label}`;
      }

      return { patch, label };
    } catch (error) {
      console.error(`Git diff error for ${diffType}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { patch: "", label: "Worktree error", error: errorMessage };
    }
  }

  try {
    switch (diffType) {
      case "uncommitted": {
        // Include tracked changes (staged + unstaged vs HEAD) and untracked new files
        const diffCommand = $`git diff HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
        const trackedDiff = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        const untrackedDiff = await getUntrackedFileDiffs('a/', 'b/', cwd);
        patch = trackedDiff + untrackedDiff;
        label = "Uncommitted changes";
        break;
      }

      case "staged":
        {
          const diffCommand = $`git diff --staged --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        }
        label = "Staged changes";
        break;

      case "unstaged": {
        // Include unstaged changes to tracked files and untracked new files
        const diffCommand = $`git diff --src-prefix=a/ --dst-prefix=b/`.quiet();
        const trackedDiff = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        const untrackedDiff = await getUntrackedFileDiffs('a/', 'b/', cwd);
        patch = trackedDiff + untrackedDiff;
        label = "Unstaged changes";
        break;
      }

      case "last-commit": {
        const parentCommand = $`git rev-parse --verify HEAD~1`.quiet().nothrow();
        const hasParent = (cwd ? await parentCommand.cwd(cwd) : await parentCommand).exitCode === 0;
        if (hasParent) {
          const diffCommand = $`git diff HEAD~1..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        } else {
          const diffCommand = $`git diff --root HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        }
        label = "Last commit";
        break;
      }

      case "branch":
        {
          const diffCommand = $`git diff ${defaultBranch}..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        }
        label = `Changes vs ${defaultBranch}`;
        break;

      default:
        patch = "";
        label = "Unknown diff type";
    }
  } catch (error) {
    // Handle errors gracefully (e.g., no commits yet, invalid ref)
    console.error(`Git diff error for ${diffType}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    patch = "";
    label = `Error: ${diffType}`;
    return { patch, label, error: errorMessage };
  }

  return { patch, label };
}

/**
 * Get old and new file contents for a given diff type.
 * Used by the expandable context feature to feed full file content to @pierre/diffs.
 */
export async function getFileContentsForDiff(
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  const oldFilePath = oldPath || filePath;

  async function gitShow(ref: string, path: string): Promise<string | null> {
    try {
      const cmd = $`git show ${ref}:${path}`.quiet();
      return (cwd ? await cmd.cwd(cwd) : await cmd).text();
    } catch {
      return null;
    }
  }

  async function readWorkingTree(path: string): Promise<string | null> {
    try {
      const fullPath = cwd ? `${cwd}/${path}` : path;
      return await Bun.file(fullPath).text();
    } catch {
      return null;
    }
  }

  // Determine the effective diff type (handle worktree prefix)
  let effectiveDiffType = diffType as string;
  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) return { oldContent: null, newContent: null };
    cwd = parsed.path;
    effectiveDiffType = parsed.subType;
  }

  let oldContent: string | null = null;
  let newContent: string | null = null;

  switch (effectiveDiffType) {
    case "uncommitted":
      oldContent = await gitShow("HEAD", oldFilePath);
      newContent = await readWorkingTree(filePath);
      break;
    case "staged":
      oldContent = await gitShow("HEAD", oldFilePath);
      newContent = await gitShow(":0", filePath);
      break;
    case "unstaged":
      oldContent = await gitShow(":0", oldFilePath);
      newContent = await readWorkingTree(filePath);
      break;
    case "last-commit":
      oldContent = await gitShow("HEAD~1", oldFilePath);
      newContent = await gitShow("HEAD", filePath);
      break;
    case "branch":
      oldContent = await gitShow(defaultBranch, oldFilePath);
      newContent = await gitShow("HEAD", filePath);
      break;
  }

  return { oldContent, newContent };
}

/**
 * Validate a file path for git operations.
 * Rejects path traversal and absolute paths.
 */
export function validateFilePath(filePath: string): void {
  if (filePath.includes("..") || filePath.startsWith("/")) {
    throw new Error("Invalid file path");
  }
}

/**
 * Stage a file via `git add`.
 */
export async function gitAddFile(filePath: string, cwd?: string): Promise<void> {
  validateFilePath(filePath);
  const cmd = $`git add -- ${filePath}`.quiet();
  await (cwd ? cmd.cwd(cwd) : cmd);
}

/**
 * Unstage a file via `git reset HEAD`.
 */
export async function gitResetFile(filePath: string, cwd?: string): Promise<void> {
  validateFilePath(filePath);
  const cmd = $`git reset HEAD -- ${filePath}`.quiet();
  await (cwd ? cmd.cwd(cwd) : cmd);
}
