import type { ToolContext } from "@opencode-ai/plugin";
import type {
  AnnotateServerOptions,
  AnnotateServerResult,
} from "@plannotator/server/annotate";
import type {
  GitContext,
  ReviewServerOptions,
  ReviewServerResult,
} from "@plannotator/server/review";
import { getGitContext, runGitDiff } from "@plannotator/server/git";
import { resolveMarkdownFile } from "@plannotator/server/resolve-file";

export const REVIEW_TOOL_DIFF_TYPES = [
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
] as const;

export type ReviewToolDiffType = typeof REVIEW_TOOL_DIFF_TYPES[number];

type SessionPromptClient = {
  session: {
    prompt(input: {
      path: { id: string };
      body: {
        agent?: string;
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string }>;
      };
    }): Promise<unknown>;
  };
};

type ReviewServerStarter = (
  options: ReviewServerOptions,
) => Promise<ReviewServerResult>;

type AnnotateServerStarter = (
  options: AnnotateServerOptions,
) => Promise<AnnotateServerResult>;

export interface ReviewToolEnvironment {
  client: SessionPromptClient;
  directory: string;
  htmlContent: string;
  getSharingEnabled: () => Promise<boolean>;
  getShareBaseUrl: () => string | undefined;
}

export interface AnnotateToolEnvironment {
  client: SessionPromptClient;
  directory: string;
  htmlContent: string;
  getSharingEnabled: () => Promise<boolean>;
  getShareBaseUrl: () => string | undefined;
}

export interface ReviewToolDependencies {
  getGitContext: (cwd?: string) => Promise<GitContext>;
  runGitDiff: (
    diffType: ReviewToolDiffType,
    defaultBranch: string,
    cwd?: string,
  ) => Promise<{ patch: string; label: string; error?: string }>;
  startReviewServer: ReviewServerStarter;
  onReady: (url: string, isRemote: boolean, port: number) => void | Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface AnnotateToolDependencies {
  resolveMarkdownFile: typeof resolveMarkdownFile;
  readFile: (filePath: string) => Promise<string>;
  startAnnotateServer: AnnotateServerStarter;
  onReady: (url: string, isRemote: boolean, port: number) => void | Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export const defaultReviewToolDependencies: ReviewToolDependencies = {
  getGitContext,
  runGitDiff,
  startReviewServer: async () => {
    throw new Error("startReviewServer dependency not configured");
  },
  onReady() {},
  sleep: Bun.sleep,
};

export const defaultAnnotateToolDependencies: AnnotateToolDependencies = {
  resolveMarkdownFile,
  readFile: (filePath) => Bun.file(filePath).text(),
  startAnnotateServer: async () => {
    throw new Error("startAnnotateServer dependency not configured");
  },
  onReady() {},
  sleep: Bun.sleep,
};

function buildReviewFeedbackMessage(
  approved: boolean,
  feedback: string,
): string {
  return approved
    ? "# Code Review\n\nCode review completed — no changes requested."
    : `# Code Review Feedback\n\n${feedback}\n\nPlease address this feedback.`;
}

function buildAnnotateFeedbackMessage(
  filePath: string,
  feedback: string,
): string {
  return `# Markdown Annotations

File: ${filePath}

${feedback}

## Mandatory workflow — follow in order, do not skip steps

**Step 1 — Read and triage all feedback before touching anything.**
Read every feedback item. For each one, determine:
- Exactly what text needs to change and where.
- Whether the item requires research or outside information before you can address it correctly. If so, do that research now, before editing.
- Whether the item is ambiguous or underspecified. If so, resolve the ambiguity (ask, research, or make a justified decision) before editing.

**Step 2 — Write out your edit plan.**
Before opening any file for editing, produce an explicit plan: for each feedback item, state what you will change, why, and which lines or sections are affected. Do not begin editing until this plan is complete.

**Step 3 — Make targeted, surgical edits using edit tools.**
Use edit tools (not write/overwrite tools) to apply each change as a minimal, targeted diff.
- Never rewrite or regenerate the entire file. If you find yourself replacing the whole file, stop — that is wrong.
- Touch only the lines required to address the feedback. Leave everything else unchanged.
- One feedback item at a time; verify each change before moving to the next.

**Step 4 — Resubmit for annotation.**
When all feedback items have been addressed, call \`plannotator_annotate\` again with the same file path so the user can review the updated document.`;
}

function buildReviewToolResponse(url: string, diffType: ReviewToolDiffType): string {
  return `Started code review server at ${url}

Please share this URL with the user and ask them to review the ${diffType} diff. The UI will open in their browser. When they submit feedback, it will be sent back to this session.

Wait for the user's submitted feedback before proceeding with any further implementation or follow-up response.`;
}

function buildAnnotateToolResponse(url: string, filePath: string): string {
  return `Started annotation server at ${url}

Please share this URL with the user and ask them to review ${filePath}. The UI will open in their browser. When they submit feedback, it will be sent back to this session.

Wait for the user's submitted feedback before proceeding with any further implementation or follow-up response.`;
}

function describeResolutionFailure(
  resolved:
    | Awaited<ReturnType<typeof resolveMarkdownFile>>,
): string {
  if (resolved.kind === "ambiguous") {
    return `Could not start annotation: "${resolved.input}" matched multiple markdown files.

Candidates:
${resolved.matches.map((match) => `- ${match}`).join("\n")}

Inspect the candidates and call \`plannotator_annotate\` again with a more specific path.`;
  }

  return `Could not start annotation: no markdown file matched "${resolved.input}".

Search the repository for the correct markdown file and call \`plannotator_annotate\` again with that path.`;
}

async function forwardReviewFeedbackInBackground(
  server: ReviewServerResult,
  client: SessionPromptClient,
  sessionID: string,
): Promise<() => void> {
  // Save stop callback to return immediately
  const stopServer = () => server.stop();

  (async () => {
    try {
      const result = await server.waitForDecision();
      if (result.cancelled) {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: "Code review cancelled by user." }],
          },
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
          ...(shouldSwitchAgent && { agent: targetAgent }),
          parts: [
            {
              type: "text",
              text: buildReviewFeedbackMessage(result.approved, result.feedback),
            },
          ],
        },
      });
    } catch {
      // Session may not be available once the review completes.
    } finally {
      // Graceful shutdown happens via /api/shutdown from the UI
      // This is a fallback to ensure the server eventually stops
      setTimeout(() => server.stop(), 10000);
    }
  })();

  return stopServer;
}

async function forwardAnnotateFeedbackInBackground(
  server: AnnotateServerResult,
  client: SessionPromptClient,
  sessionID: string,
  filePath: string,
): Promise<() => void> {
  const stopServer = () => server.stop();

  (async () => {
    try {
      const result = await server.waitForDecision();
      if (result.cancelled) {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: `Annotation of ${filePath} cancelled by user.` }],
          },
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
              text: buildAnnotateFeedbackMessage(filePath, result.feedback),
            },
          ],
        },
      });
    } catch {
      // Session may not be available once annotation completes.
    } finally {
      // Graceful shutdown happens via /api/shutdown from the UI
      // This is a fallback to ensure the server eventually stops
      setTimeout(() => server.stop(), 10000);
    }
  })();

  return stopServer;
}

export async function runPlannotatorReviewTool(
  args: { diff_type?: ReviewToolDiffType },
  context: ToolContext,
  env: ReviewToolEnvironment,
  deps: ReviewToolDependencies,
): Promise<string> {
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
    onReady: deps.onReady,
  });

  void forwardReviewFeedbackInBackground(
    server,
    env.client,
    context.sessionID,
  );

  return buildReviewToolResponse(server.url, diffType);
}

export async function runPlannotatorAnnotateTool(
  args: { file_path: string },
  context: ToolContext,
  env: AnnotateToolEnvironment,
  deps: AnnotateToolDependencies,
): Promise<string> {
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
    onReady: deps.onReady,
  });

  void forwardAnnotateFeedbackInBackground(
    server,
    env.client,
    context.sessionID,
    resolved.path,
  );

  return buildAnnotateToolResponse(server.url, resolved.path);
}
