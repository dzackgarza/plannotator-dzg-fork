// @bun
// index.ts
import { join as join2 } from "path";
import { tool } from "@opencode-ai/plugin";

// ../../packages/server/remote.ts
function isRemoteSession() {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === "1" || remote?.toLowerCase() === "true") {
    return true;
  }
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  return false;
}

// ../../packages/server/browser.ts
var {$ } = globalThis.Bun;
import os from "os";
async function isWSL() {
  if (process.platform !== "linux") {
    return false;
  }
  if (os.release().toLowerCase().includes("microsoft")) {
    return true;
  }
  try {
    const file = Bun.file("/proc/version");
    if (await file.exists()) {
      const content = await file.text();
      return content.toLowerCase().includes("wsl") || content.toLowerCase().includes("microsoft");
    }
  } catch {}
  return false;
}
async function openBrowser(url) {
  try {
    const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
    const platform = process.platform;
    const wsl = await isWSL();
    if (browser) {
      const plannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
      if (plannotatorBrowser && platform === "darwin") {
        if (plannotatorBrowser.includes("/") && !plannotatorBrowser.endsWith(".app")) {
          await $`${plannotatorBrowser} ${url}`.quiet();
        } else {
          await $`open -a ${plannotatorBrowser} ${url}`.quiet();
        }
      } else if ((platform === "win32" || wsl) && plannotatorBrowser) {
        await $`cmd.exe /c start "" ${plannotatorBrowser} ${url}`.quiet();
      } else {
        await $`${browser} ${url}`.quiet();
      }
    } else {
      if (platform === "win32" || wsl) {
        await $`cmd.exe /c start ${url}`.quiet();
      } else if (platform === "darwin") {
        await $`open ${url}`.quiet();
      } else {
        await $`xdg-open ${url}`.quiet();
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ../../packages/server/image.ts
import { resolve, join } from "path";
import { tmpdir } from "os";
var ALLOWED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "avif"
]);
var UPLOAD_DIR = join(tmpdir(), "plannotator");

// ../../packages/server/shared-handlers.ts
async function handleServerReady(url, isRemote, _port) {
  if (!isRemote || process.env.PLANNOTATOR_BROWSER) {
    await openBrowser(url);
  }
}

// ../../packages/server/resolve-file.ts
import { isAbsolute, resolve as resolve2, win32 } from "path";
import { existsSync } from "fs";
var MARKDOWN_PATH_REGEX = /\.mdx?$/i;
var WINDOWS_DRIVE_PATH_PATTERNS = [
  /^\/cygdrive\/([a-zA-Z])\/(.+)$/,
  /^\/([a-zA-Z])\/(.+)$/
];
var IGNORED_DIRS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  "__pycache__/",
  ".obsidian/",
  ".trash/"
];
function normalizeSeparators(input) {
  return input.replace(/\\/g, "/");
}
function stripTrailingSlashes(input) {
  return input.replace(/\/+$/, "");
}
function normalizeComparablePath(input) {
  return stripTrailingSlashes(normalizeSeparators(resolve2(input)));
}
function isWithinProjectRoot(candidate, projectRoot) {
  const normalizedCandidate = normalizeComparablePath(candidate);
  const normalizedProjectRoot = normalizeComparablePath(projectRoot);
  return normalizedCandidate === normalizedProjectRoot || normalizedCandidate.startsWith(`${normalizedProjectRoot}/`);
}
function getLowercaseBasename(input) {
  const normalizedInput = normalizeSeparators(input);
  return normalizedInput.split("/").pop().toLowerCase();
}
function getLookupKey(input, isBareFilename) {
  return isBareFilename ? getLowercaseBasename(input) : input.toLowerCase();
}
function resolveAbsolutePath(input, platform = process.platform) {
  return platform === "win32" || hasWindowsDriveLetter(input) ? win32.resolve(input) : resolve2(input);
}
function isSearchableMarkdownPath(input) {
  return MARKDOWN_PATH_REGEX.test(input.trim());
}
function hasWindowsDriveLetter(input) {
  return /^[a-zA-Z]:[/\\]/.test(input);
}
function fileExists(filePath) {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}
function normalizeMarkdownPathInput(input, platform = process.platform) {
  if (platform !== "win32") {
    return input;
  }
  for (const pattern of WINDOWS_DRIVE_PATH_PATTERNS) {
    const match = input.match(pattern);
    if (!match) {
      continue;
    }
    const [, driveLetter, rest] = match;
    return `${driveLetter.toUpperCase()}:/${rest}`;
  }
  return input;
}
function isAbsoluteMarkdownPath(input, platform = process.platform) {
  const normalizedInput = normalizeMarkdownPathInput(input, platform);
  if (hasWindowsDriveLetter(normalizedInput)) {
    return true;
  }
  return platform === "win32" ? win32.isAbsolute(normalizedInput) : isAbsolute(normalizedInput);
}
async function resolveMarkdownFile(input, projectRoot) {
  input = input.trim();
  const normalizedInput = normalizeMarkdownPathInput(input);
  const searchInput = normalizeSeparators(normalizedInput);
  const isBareFilename = !searchInput.includes("/");
  const targetLookupKey = getLookupKey(searchInput, isBareFilename);
  if (!isSearchableMarkdownPath(normalizedInput)) {
    return { kind: "not_found", input };
  }
  if (isAbsoluteMarkdownPath(normalizedInput)) {
    const absolutePath = resolveAbsolutePath(normalizedInput);
    if (fileExists(absolutePath)) {
      return { kind: "found", path: absolutePath };
    }
    return { kind: "not_found", input };
  }
  const fromRoot = resolve2(projectRoot, searchInput);
  if (isWithinProjectRoot(fromRoot, projectRoot) && fileExists(fromRoot)) {
    return { kind: "found", path: fromRoot };
  }
  const glob = new Bun.Glob("**/*.[mM][dD]{,[xX]}");
  const matches = [];
  for await (const match of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
    const normalizedMatch = normalizeSeparators(match);
    if (IGNORED_DIRS.some((dir) => normalizedMatch.includes(dir)))
      continue;
    const matchLookupKey = getLookupKey(normalizedMatch, isBareFilename);
    if (matchLookupKey === targetLookupKey) {
      const full = resolve2(projectRoot, normalizedMatch);
      if (isWithinProjectRoot(full, projectRoot)) {
        matches.push(full);
      }
    }
  }
  if (matches.length === 1) {
    return { kind: "found", path: matches[0] };
  }
  if (matches.length > 1) {
    const projectRootPrefix = `${normalizeComparablePath(projectRoot)}/`;
    const relative = matches.map((match) => normalizeComparablePath(match).replace(projectRootPrefix, ""));
    return { kind: "ambiguous", input, matches: relative };
  }
  return { kind: "not_found", input };
}
// ../../packages/server/git.ts
var {$: $2 } = globalThis.Bun;
async function getCurrentBranch(cwd) {
  try {
    const command = $2`git rev-parse --abbrev-ref HEAD`.quiet();
    const result = cwd ? await command.cwd(cwd) : await command;
    return result.text().trim();
  } catch {
    return "HEAD";
  }
}
async function getDefaultBranch(cwd) {
  try {
    const command = $2`git symbolic-ref refs/remotes/origin/HEAD`.quiet();
    const result = cwd ? await command.cwd(cwd) : await command;
    const ref = result.text().trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {}
  try {
    const command = $2`git show-ref --verify refs/heads/main`.quiet();
    await (cwd ? command.cwd(cwd) : command);
    return "main";
  } catch {}
  return "master";
}
async function getWorktrees(cwd) {
  try {
    const command = $2`git worktree list --porcelain`.quiet().nothrow();
    const result = cwd ? await command.cwd(cwd) : await command;
    if (result.exitCode !== 0)
      return [];
    const text = result.text();
    const entries = [];
    let current = {};
    for (const line of text.split(`
`)) {
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
    if (current.path) {
      entries.push({ path: current.path, head: current.head || "", branch: current.branch ?? null });
    }
    return entries;
  } catch {
    return [];
  }
}
async function getGitContext(cwd) {
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(cwd),
    getDefaultBranch(cwd)
  ]);
  const diffOptions = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "staged", label: "Staged changes" },
    { id: "unstaged", label: "Unstaged changes" },
    { id: "last-commit", label: "Last commit" }
  ];
  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }
  const [worktrees, currentTreePath] = await Promise.all([
    getWorktrees(cwd),
    (async () => {
      const command = $2`git rev-parse --show-toplevel`.quiet();
      const result = cwd ? await command.cwd(cwd) : await command;
      return result.text().trim();
    })().catch(() => null)
  ]);
  const otherWorktrees = worktrees.filter((wt) => wt.path !== currentTreePath);
  return { currentBranch, defaultBranch, diffOptions, worktrees: otherWorktrees };
}
async function getUntrackedFileDiffs(srcPrefix = "a/", dstPrefix = "b/", cwd) {
  try {
    const lsCmd = $2`git ls-files --others --exclude-standard`.quiet();
    const output = (cwd ? await lsCmd.cwd(cwd) : await lsCmd).text();
    const files = output.trim().split(`
`).filter((f) => f.length > 0);
    if (files.length === 0)
      return "";
    const diffs = await Promise.all(files.map(async (file) => {
      try {
        const diffCmd = $2`git diff --no-index --src-prefix=${srcPrefix} --dst-prefix=${dstPrefix} /dev/null ${file}`.quiet().nothrow();
        const result = cwd ? await diffCmd.cwd(cwd) : await diffCmd;
        return result.text();
      } catch {
        return "";
      }
    }));
    return diffs.join("");
  } catch {
    return "";
  }
}
var WORKTREE_SUB_TYPES = new Set(["uncommitted", "staged", "unstaged", "last-commit", "branch"]);
function parseWorktreeDiffType(diffType) {
  if (!diffType.startsWith("worktree:"))
    return null;
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
async function runGitDiff(diffType, defaultBranch = "main", cwd) {
  let patch;
  let label;
  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) {
      return { patch: "", label: "Worktree error", error: "Could not parse worktree diff type" };
    }
    const { path: wtPath, subType } = parsed;
    try {
      switch (subType) {
        case "uncommitted": {
          const trackedDiff = (await $2`git diff HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          const untrackedDiff = await getUntrackedFileDiffs("a/", "b/", wtPath);
          patch = trackedDiff + untrackedDiff;
          label = "Uncommitted changes";
          break;
        }
        case "last-commit": {
          const hasParent = (await $2`git rev-parse --verify HEAD~1`.quiet().nothrow().cwd(wtPath)).exitCode === 0;
          if (hasParent) {
            patch = (await $2`git diff HEAD~1..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          } else {
            patch = (await $2`git diff --root HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          }
          label = "Last commit";
          break;
        }
        case "staged":
          patch = (await $2`git diff --staged --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          label = "Staged changes";
          break;
        case "unstaged": {
          const trackedDiff = (await $2`git diff --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          const untrackedDiff = await getUntrackedFileDiffs("a/", "b/", wtPath);
          patch = trackedDiff + untrackedDiff;
          label = "Unstaged changes";
          break;
        }
        case "branch":
          patch = (await $2`git diff ${defaultBranch}..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet().cwd(wtPath)).text();
          label = `Changes vs ${defaultBranch}`;
          break;
        default:
          patch = "";
          label = "Unknown worktree diff type";
      }
      try {
        const branch = (await $2`git rev-parse --abbrev-ref HEAD`.quiet().cwd(wtPath)).text().trim();
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
        const diffCommand = $2`git diff HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
        const trackedDiff = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        const untrackedDiff = await getUntrackedFileDiffs("a/", "b/", cwd);
        patch = trackedDiff + untrackedDiff;
        label = "Uncommitted changes";
        break;
      }
      case "staged":
        {
          const diffCommand = $2`git diff --staged --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        }
        label = "Staged changes";
        break;
      case "unstaged": {
        const diffCommand = $2`git diff --src-prefix=a/ --dst-prefix=b/`.quiet();
        const trackedDiff = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        const untrackedDiff = await getUntrackedFileDiffs("a/", "b/", cwd);
        patch = trackedDiff + untrackedDiff;
        label = "Unstaged changes";
        break;
      }
      case "last-commit": {
        const parentCommand = $2`git rev-parse --verify HEAD~1`.quiet().nothrow();
        const hasParent = (cwd ? await parentCommand.cwd(cwd) : await parentCommand).exitCode === 0;
        if (hasParent) {
          const diffCommand = $2`git diff HEAD~1..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        } else {
          const diffCommand = $2`git diff --root HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        }
        label = "Last commit";
        break;
      }
      case "branch":
        {
          const diffCommand = $2`git diff ${defaultBranch}..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet();
          patch = (cwd ? await diffCommand.cwd(cwd) : await diffCommand).text();
        }
        label = `Changes vs ${defaultBranch}`;
        break;
      default:
        patch = "";
        label = "Unknown diff type";
    }
  } catch (error) {
    console.error(`Git diff error for ${diffType}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    patch = "";
    label = `Error: ${diffType}`;
    return { patch, label, error: errorMessage };
  }
  return { patch, label };
}
// ../../packages/shared/compress.ts
async function compress(data) {
  const json = JSON.stringify(data);
  const byteArray = new TextEncoder().encode(json);
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(byteArray);
  writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  const compressed = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0;i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ../../packages/server/share-url.ts
var DEFAULT_SHARE_BASE = "https://share.plannotator.ai";
async function generateRemoteShareUrl(plan, shareBaseUrl) {
  const base = shareBaseUrl || DEFAULT_SHARE_BASE;
  const hash = await compress({ p: plan, a: [] });
  return `${base}/#${hash}`;
}
function formatSize(bytes) {
  if (bytes < 1024)
    return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}
async function writeRemoteShareLink(content, shareBaseUrl, verb, noun) {
  const shareUrl = await generateRemoteShareUrl(content, shareBaseUrl);
  const size = formatSize(new TextEncoder().encode(shareUrl).length);
  process.stderr.write(`
  Open this link on your local machine to ${verb}:
` + `  ${shareUrl}

` + `  (${size} \u2014 ${noun}, annotations added in browser)

`);
}

// ../../packages/server/persistent.ts
var PERSISTENT_SERVER_DEFAULT_PORT = 19432;

// tool-helpers.ts
var REVIEW_TOOL_DIFF_TYPES = [
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch"
];
var defaultReviewToolDependencies = {
  getGitContext,
  runGitDiff,
  startReviewServer: async () => {
    throw new Error("startReviewServer dependency not configured");
  },
  onReady() {},
  sleep: Bun.sleep
};
var defaultAnnotateToolDependencies = {
  resolveMarkdownFile,
  readFile: (filePath) => Bun.file(filePath).text(),
  startAnnotateServer: async () => {
    throw new Error("startAnnotateServer dependency not configured");
  },
  onReady() {},
  sleep: Bun.sleep
};
function buildReviewFeedbackMessage(approved, feedback) {
  return approved ? `# Code Review

Code review completed \u2014 no changes requested.` : `# Code Review Feedback

${feedback}

Please address this feedback.`;
}
function buildAnnotateFeedbackMessage(filePath, feedback) {
  return `# Markdown Annotations

File: ${filePath}

${feedback}

## Mandatory workflow \u2014 follow in order, do not skip steps

**Step 1 \u2014 Read and triage all feedback before touching anything.**
Read every feedback item. For each one, determine:
- Exactly what text needs to change and where.
- Whether the item requires research or outside information before you can address it correctly. If so, do that research now, before editing.
- Whether the item is ambiguous or underspecified. If so, resolve the ambiguity (ask, research, or make a justified decision) before editing.

**Step 2 \u2014 Write out your edit plan.**
Before opening any file for editing, produce an explicit plan: for each feedback item, state what you will change, why, and which lines or sections are affected. Do not begin editing until this plan is complete.

**Step 3 \u2014 Make targeted, surgical edits using edit tools.**
Use edit tools (not write/overwrite tools) to apply each change as a minimal, targeted diff.
- Never rewrite or regenerate the entire file. If you find yourself replacing the whole file, stop \u2014 that is wrong.
- Touch only the lines required to address the feedback. Leave everything else unchanged.
- One feedback item at a time; verify each change before moving to the next.

**Step 4 \u2014 Resubmit for annotation.**
When all feedback items have been addressed, call \`plannotator_annotate\` again with the same file path so the user can review the updated document.`;
}
function buildReviewToolResponse(url, diffType) {
  return `Started code review server at ${url}

Please share this URL with the user and ask them to review the ${diffType} diff. The UI will open in their browser. When they submit feedback, it will be sent back to this session.

Wait for the user's submitted feedback before proceeding with any further implementation or follow-up response.`;
}
function buildAnnotateToolResponse(url, filePath) {
  return `Started annotation server at ${url}

Please share this URL with the user and ask them to review ${filePath}. The UI will open in their browser. When they submit feedback, it will be sent back to this session.

Wait for the user's submitted feedback before proceeding with any further implementation or follow-up response.`;
}
function describeResolutionFailure(resolved) {
  if (resolved.kind === "ambiguous") {
    return `Could not start annotation: "${resolved.input}" matched multiple markdown files.

Candidates:
${resolved.matches.map((match) => `- ${match}`).join(`
`)}

Inspect the candidates and call \`plannotator_annotate\` again with a more specific path.`;
  }
  return `Could not start annotation: no markdown file matched "${resolved.input}".

Search the repository for the correct markdown file and call \`plannotator_annotate\` again with that path.`;
}
async function forwardReviewFeedbackInBackground(server, client, sessionID) {
  const stopServer = () => server.stop();
  (async () => {
    try {
      const result = await server.waitForDecision();
      if (result.cancelled) {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: "Code review cancelled by user." }]
          }
        });
        return;
      }
      if (!result.feedback) {
        return;
      }
      const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== "disabled";
      const targetAgent = result.agentSwitch || "build";
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          ...shouldSwitchAgent && { agent: targetAgent },
          parts: [
            {
              type: "text",
              text: buildReviewFeedbackMessage(result.approved, result.feedback)
            }
          ]
        }
      });
    } catch {} finally {
      setTimeout(() => server.stop(), 1e4);
    }
  })();
  return stopServer;
}
async function forwardAnnotateFeedbackInBackground(server, client, sessionID, filePath) {
  const stopServer = () => server.stop();
  (async () => {
    try {
      const result = await server.waitForDecision();
      if (result.cancelled) {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: `Annotation of ${filePath} cancelled by user.` }]
          }
        });
        return;
      }
      if (!result.feedback) {
        return;
      }
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [
            {
              type: "text",
              text: buildAnnotateFeedbackMessage(filePath, result.feedback)
            }
          ]
        }
      });
    } catch {} finally {
      setTimeout(() => server.stop(), 1e4);
    }
  })();
  return stopServer;
}
async function runPlannotatorReviewTool(args, context, env, deps) {
  const diffType = args.diff_type ?? "uncommitted";
  const gitContext = await deps.getGitContext(env.directory);
  const diff = await deps.runGitDiff(diffType, gitContext.defaultBranch, env.directory);
  const server = await deps.startReviewServer({
    rawPatch: diff.patch,
    gitRef: diff.label,
    error: diff.error,
    origin: "opencode",
    diffType,
    gitContext,
    sharingEnabled: await env.getSharingEnabled(),
    shareBaseUrl: env.getShareBaseUrl(),
    htmlContent: env.htmlContent,
    opencodeClient: env.client,
    cwd: env.directory,
    onReady: deps.onReady
  });
  forwardReviewFeedbackInBackground(server, env.client, context.sessionID);
  return buildReviewToolResponse(server.url, diffType);
}
async function runPlannotatorAnnotateTool(args, context, env, deps) {
  const resolved = await deps.resolveMarkdownFile(args.file_path, env.directory);
  if (resolved.kind !== "found") {
    return describeResolutionFailure(resolved);
  }
  const markdown = await deps.readFile(resolved.path);
  const server = await deps.startAnnotateServer({
    markdown,
    filePath: resolved.path,
    origin: "opencode",
    sharingEnabled: await env.getSharingEnabled(),
    shareBaseUrl: env.getShareBaseUrl(),
    htmlContent: env.htmlContent,
    onReady: deps.onReady
  });
  forwardAnnotateFeedbackInBackground(server, env.client, context.sessionID, resolved.path);
  return buildAnnotateToolResponse(server.url, resolved.path);
}

// index.ts
var DEFAULT_PLAN_TIMEOUT_SECONDS = 345600;
function getPersistentServerPort() {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536)
      return parsed;
  }
  return PERSISTENT_SERVER_DEFAULT_PORT;
}
var SERVER_PORT = getPersistentServerPort();
var SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
async function checkServerHealth() {
  try {
    const resp = await fetch(`${SERVER_URL}/api/health`, {
      signal: AbortSignal.timeout(2000)
    });
    return resp.ok;
  } catch {
    return false;
  }
}
async function waitForServer(maxWaitMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await checkServerHealth())
      return true;
    await Bun.sleep(300);
  }
  return false;
}
async function ensureServerRunning() {
  if (await checkServerHealth())
    return;
  const serverCli = join2(import.meta.dir, "server-cli.js");
  Bun.spawn(["bun", serverCli, "start"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  const ready = await waitForServer(6000);
  if (!ready) {
    throw new Error(`Plannotator server failed to start on port ${SERVER_PORT}. ` + `Try running: bun ${serverCli} start`);
  }
}
async function startReviewServerHTTP(options) {
  const resp = await fetch(`${SERVER_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "review",
      data: {
        rawPatch: options.rawPatch,
        gitRef: options.gitRef,
        error: options.error,
        origin: options.origin,
        diffType: options.diffType,
        gitContext: options.gitContext,
        sharingEnabled: options.sharingEnabled,
        shareBaseUrl: options.shareBaseUrl,
        cwd: options.cwd
      }
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Failed to submit review session: ${err.error ?? resp.statusText}`);
  }
  const { url: serverUrl, port } = await resp.json();
  const remote = isRemoteSession();
  if (options.onReady)
    options.onReady(serverUrl, remote, port);
  return {
    port,
    url: serverUrl,
    isRemote: remote,
    waitForDecision: () => fetch(`${SERVER_URL}/api/wait`).then((r) => r.json()),
    stop: () => {}
  };
}
async function startAnnotateServerHTTP(options) {
  const resp = await fetch(`${SERVER_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "annotate",
      data: {
        markdown: options.markdown,
        filePath: options.filePath,
        origin: options.origin,
        sharingEnabled: options.sharingEnabled,
        shareBaseUrl: options.shareBaseUrl
      }
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Failed to submit annotate session: ${err.error ?? resp.statusText}`);
  }
  const { url: serverUrl, port } = await resp.json();
  const remote = isRemoteSession();
  if (options.onReady)
    options.onReady(serverUrl, remote, port);
  return {
    port,
    url: serverUrl,
    isRemote: remote,
    waitForDecision: () => fetch(`${SERVER_URL}/api/wait`).then((r) => r.json()),
    stop: () => {}
  };
}
var PlannotatorPlugin = async (ctx) => {
  await ensureServerRunning();
  async function getSharingEnabled() {
    try {
      const response = await ctx.client.config.get({
        query: { directory: ctx.directory }
      });
      const share = response?.data?.share;
      if (share !== undefined)
        return share !== "disabled";
    } catch (err) {
      console.error("[Plannotator] Failed to read share config:", err);
    }
    return process.env.PLANNOTATOR_SHARE !== "disabled";
  }
  function getShareBaseUrl() {
    return process.env.PLANNOTATOR_SHARE_URL || undefined;
  }
  function getPlanTimeoutSeconds() {
    const raw = process.env.PLANNOTATOR_PLAN_TIMEOUT_SECONDS?.trim();
    if (!raw)
      return DEFAULT_PLAN_TIMEOUT_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`[Plannotator] Invalid PLANNOTATOR_PLAN_TIMEOUT_SECONDS="${raw}". Using default ${DEFAULT_PLAN_TIMEOUT_SECONDS}s.`);
      return DEFAULT_PLAN_TIMEOUT_SECONDS;
    }
    if (parsed === 0)
      return null;
    return parsed;
  }
  return {
    config: async (opencodeConfig) => {
      const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
      const requiredPrimaryTools = [
        "submit_plan",
        "plannotator_review",
        "plannotator_annotate"
      ];
      const missingPrimaryTools = requiredPrimaryTools.filter((toolName) => !existingPrimaryTools.includes(toolName));
      if (missingPrimaryTools.length > 0) {
        opencodeConfig.experimental = {
          ...opencodeConfig.experimental,
          primary_tools: [...existingPrimaryTools, ...missingPrimaryTools]
        };
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const existingSystem = output.system.join(`
`).toLowerCase();
      if (existingSystem.includes("title generator") || existingSystem.includes("generate a title")) {
        return;
      }
      try {
        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID }
        });
        const messages = messagesResponse.data;
        let lastUserAgent;
        if (messages) {
          for (let i = messages.length - 1;i >= 0; i--) {
            const msg = messages[i];
            if (msg.info.role === "user") {
              lastUserAgent = msg.info.agent;
              break;
            }
          }
        }
        if (!lastUserAgent)
          return;
        if (lastUserAgent === "build")
          return;
        const agentsResponse = await ctx.client.app.agents({
          query: { directory: ctx.directory }
        });
        const agents = agentsResponse.data;
        const agent = agents?.find((a) => a.name === lastUserAgent);
        if (agent?.mode === "subagent")
          return;
      } catch {
        return;
      }
      output.system.push(`
## Plan Submission

When you have completed your plan, you MUST call the \`submit_plan\` tool to submit it for user review.
The user will be able to:
- Review your plan visually in a dedicated UI
- Annotate specific sections with feedback
- Approve the plan to proceed with implementation
- Request changes with detailed feedback

If your plan is rejected, you will receive the user's annotated feedback. Revise your plan
based on their feedback and call submit_plan again.

Do NOT proceed with implementation until your plan is approved.
`);
    },
    event: async ({ event }) => {
      const isCommandEvent = event.type === "command.executed" || event.type === "tui.command.execute";
      const commandName = event.properties?.name || event.command || event.payload?.name;
      const isReviewCommand = commandName === "plannotator-review";
      if (isCommandEvent && isReviewCommand) {
        ctx.client.app.log({ level: "info", message: "Opening code review UI..." });
        const sessionID = event.properties?.sessionID;
        if (!sessionID)
          return;
        const message = await runPlannotatorReviewTool({ diff_type: "uncommitted" }, {
          sessionID,
          messageID: "",
          agent: "build",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {}
        }, {
          client: ctx.client,
          directory: ctx.directory,
          htmlContent: "",
          getSharingEnabled,
          getShareBaseUrl
        }, {
          ...defaultReviewToolDependencies,
          startReviewServer: startReviewServerHTTP,
          onReady: handleServerReady
        });
        ctx.client.app.log({ level: "info", message });
      }
    },
    tool: {
      submit_plan: tool({
        description: "Submit your completed plan for interactive user review. The user can annotate, approve, or request changes. Call this when you have finished creating your implementation plan.",
        args: {
          plan: tool.schema.string().describe("The complete implementation plan in markdown format"),
          summary: tool.schema.string().describe("A brief 1-2 sentence summary of what the plan accomplishes"),
          commit_message: tool.schema.string().describe("A commit message summarizing what has changed since the previous version of this plan. If this is a revision of a previously rejected plan, explain what feedback was addressed.")
        },
        async execute(args, context) {
          const resp = await fetch(`${SERVER_URL}/api/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "plan",
              data: {
                plan: args.plan,
                origin: "opencode",
                sharingEnabled: await getSharingEnabled(),
                shareBaseUrl: getShareBaseUrl(),
                commitMessage: args.commit_message
              }
            })
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            return `[Plannotator] Failed to submit plan: ${err.error ?? resp.statusText}`;
          }
          const {
            url: serverUrl,
            port
          } = await resp.json();
          const remote = isRemoteSession();
          handleServerReady(serverUrl, remote, port);
          if (remote && await getSharingEnabled()) {
            await writeRemoteShareLink(args.plan, getShareBaseUrl(), "review the plan", "plan only").catch(() => {});
          }
          const timeoutSeconds = getPlanTimeoutSeconds();
          let result;
          if (timeoutSeconds === null) {
            const r = await fetch(`${SERVER_URL}/api/wait`);
            result = await r.json();
          } else {
            const r = await fetch(`${SERVER_URL}/api/wait`, { signal: AbortSignal.timeout(timeoutSeconds * 1000) }).catch((err) => {
              if (err.name === "TimeoutError" || err.name === "AbortError")
                return null;
              throw err;
            });
            if (!r) {
              return `[Plannotator] No response within ${timeoutSeconds} seconds. The review session is still open \u2014 please call submit_plan again or open the review UI to cancel.`;
            }
            result = await r.json();
          }
          if (result.cancelled)
            return "Plan review cancelled by user.";
          if (result.approved) {
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== "disabled";
            const targetAgent = result.agentSwitch || "build";
            if (shouldSwitchAgent) {
              try {
                await ctx.client.tui.executeCommand({
                  body: { command: "agent_cycle" }
                });
              } catch {}
              try {
                await ctx.client.session.prompt({
                  path: { id: context.sessionID },
                  body: {
                    agent: targetAgent,
                    noReply: true,
                    parts: [{ type: "text", text: "Proceed with implementation" }]
                  }
                });
              } catch {}
            }
            if (result.feedback) {
              return `Plan approved with notes!

Plan Summary: ${args.summary}
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}

## Implementation Notes

The user approved your plan but added the following notes to consider during implementation:

${result.feedback}

Proceed with implementation, incorporating these notes where applicable.`;
            }
            return `Plan approved!

Plan Summary: ${args.summary}
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}`;
          } else {
            return `Plan needs revision.
${result.savedPath ? `
Saved to: ${result.savedPath}` : ""}

The user has requested changes to your plan. Please review their feedback below and revise your plan accordingly.

## User Feedback

${result.feedback}

---

Please revise your plan based on this feedback and call \`submit_plan\` again when ready.`;
          }
        }
      }),
      plannotator_review: tool({
        description: "Present git diff changes to the user for live code review and feedback. Use this whenever you want to show code changes to the user so they can review and annotate specific lines.",
        args: {
          diff_type: tool.schema.enum(REVIEW_TOOL_DIFF_TYPES).optional().describe("Diff to review: uncommitted, staged, unstaged, last-commit, or branch")
        },
        async execute(args, context) {
          return runPlannotatorReviewTool(args, context, {
            client: ctx.client,
            directory: ctx.directory,
            htmlContent: "",
            getSharingEnabled,
            getShareBaseUrl
          }, {
            ...defaultReviewToolDependencies,
            startReviewServer: startReviewServerHTTP,
            onReady: handleServerReady
          });
        }
      }),
      plannotator_annotate: tool({
        description: "Present a markdown document to the user for live annotation and feedback. Use this whenever you want to show a markdown file to the user so they can review, annotate, and give corrections in real time.",
        args: {
          file_path: tool.schema.string().describe("Path to the markdown file to present for annotation")
        },
        async execute(args, context) {
          return runPlannotatorAnnotateTool(args, context, {
            client: ctx.client,
            directory: ctx.directory,
            htmlContent: "",
            getSharingEnabled,
            getShareBaseUrl
          }, {
            ...defaultAnnotateToolDependencies,
            startAnnotateServer: startAnnotateServerHTTP,
            onReady: handleServerReady
          });
        }
      })
    }
  };
};
var opencode_plugin_default = PlannotatorPlugin;
export {
  opencode_plugin_default as default,
  PlannotatorPlugin
};
