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
  return `# Markdown Annotations\n\nFile: ${filePath}\n\n${feedback}\n\nPlease address the annotation feedback above.`;
}

function buildReviewToolResponse(url: string, diffType: ReviewToolDiffType): string {
  return `Started code review server at ${url}

Please share this URL with the user and ask them to review the ${diffType} diff. The UI will open in their browser. When they submit feedback, it will be sent back to this session.`;
}

function buildAnnotateToolResponse(url: string, filePath: string): string {
  return `Started annotation server at ${url}

Please share this URL with the user and ask them to review ${filePath}. The UI will open in their browser. When they submit feedback, it will be sent back to this session.`;
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
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    const result = await server.waitForDecision();
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
    await sleep(1500);
    server.stop();
  }
}

async function forwardAnnotateFeedbackInBackground(
  server: AnnotateServerResult,
  client: SessionPromptClient,
  sessionID: string,
  filePath: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    const result = await server.waitForDecision();
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
    await sleep(1500);
    server.stop();
  }
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
    deps.sleep,
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
    deps.sleep,
  );

  return buildAnnotateToolResponse(server.url, resolved.path);
}
