/**
 * Code Review Server
 *
 * Provides a server implementation for code review with git diff rendering.
 * Follows the same patterns as the plan server.
 *
 * Environment variables:
 *   PLANNOTATOR_PORT   - Optional fixed port for the local review server
 */

import { getServerPort } from "./port";
import { type DiffType, type GitContext, runGitDiff, getFileContentsForDiff, gitAddFile, gitResetFile, parseWorktreeDiffType, validateFilePath } from "./git";
import { getRepoInfo } from "./repo";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createDaemonRouter, type DaemonRouterEvent } from "./daemon-router";
import { createDaemonEventBus } from "./daemon-events";
import { transition, type DaemonState, type FeedbackPayload } from "./state";

// Re-export utilities
export { getServerPort } from "./port";
export { openBrowser } from "./browser";
export { type DiffType, type DiffOption, type GitContext, type WorktreeInfo } from "./git";
export { handleServerReady as handleReviewServerReady } from "./shared-handlers";

// --- Types ---

export interface ReviewServerOptions {
  /** Raw git diff patch string */
  rawPatch: string;
  /** Git ref used for the diff (e.g., "HEAD", "main..HEAD", "--staged") */
  gitRef: string;
  /** Error message if git diff failed */
  error?: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Origin identifier for UI customization */
  origin?: "opencode" | "claude-code";
  /** Current diff type being displayed */
  diffType?: DiffType;
  /** Git context with branch info and available diff options */
  gitContext?: GitContext;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  /** OpenCode client for querying available agents (OpenCode only) */
  opencodeClient?: OpencodeClient;
  /** Working directory for git and repo operations */
  cwd?: string;
}

export interface ReviewServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user review decision */
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    cancelled?: boolean;
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Code Review server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes (/api/diff, /api/feedback)
 * - Port conflict retries
 */
export async function startReviewServer(
  options: ReviewServerOptions
): Promise<ReviewServerResult> {
  const { htmlContent, origin, gitContext, onReady, cwd } = options;

  const draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";
  let currentError = options.error;
  let currentState: DaemonState = {
    schemaVersion: 1,
    status: "awaiting-response",
    document: {
      id: `review-${crypto.randomUUID()}`,
      mode: "review",
      origin: origin ?? "claude-code",
      content: currentPatch,
      gitRef: currentGitRef,
    },
    feedback: null,
  };

  const configuredPort = getServerPort();

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo(cwd);

  const eventBus = createDaemonEventBus();
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    cancelled?: boolean;
  }>((resolveDecision) => {
    const unsubscribe = eventBus.subscribe((event: DaemonRouterEvent) => {
      if (event.type !== "resolved") {
        return;
      }

      unsubscribe();
      resolveDecision({
        approved: event.feedback.approved,
        feedback: event.feedback.feedback,
        annotations: event.feedback.annotations,
        agentSwitch: event.feedback.agentSwitch,
        cancelled: event.feedback.cancelled,
      });
    });
  });

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  // Handle CLI signals for graceful cancellation
  const handleSignal = () => {
    if (currentState.status !== "awaiting-response") {
      return;
    }

    deleteDraft(draftKey);
    const feedback: FeedbackPayload = {
      approved: false,
      feedback: "Review cancelled by user via CLI signal.",
      annotations: [],
      cancelled: true,
    };
    const nextState = transition(currentState, {
      type: "resolve",
      feedback,
    });

    currentState = nextState;
    eventBus.emit({
      type: "resolved",
      feedback,
      state: nextState,
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const cleanup = () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    server?.stop();
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const router = createDaemonRouter(
        {
          getState: () => currentState,
          setState: (nextState) => {
            currentState = nextState;
          },
          reviewHtml: htmlContent,
          getReviewResponse: () => ({
            origin,
            diffType: currentDiffType,
            gitContext,
            repoInfo,
            ...(currentError && { error: currentError }),
          }),
          onFeedback() {
            deleteDraft(draftKey);
          },
          onCancel() {
            deleteDraft(draftKey);
          },
          onReset() {
            deleteDraft(draftKey);
          },
          async handleFallback(req, url) {
            if (url.pathname === "/api/diff/switch" && req.method === "POST") {
              try {
                const body = (await req.json()) as { diffType: DiffType };
                const newDiffType = body.diffType;

                if (!newDiffType) {
                  return Response.json({ error: "Missing diffType" }, { status: 400 });
                }

                const defaultBranch = gitContext?.defaultBranch || "main";
                const result = await runGitDiff(newDiffType, defaultBranch, cwd);

                currentPatch = result.patch;
                currentGitRef = result.label;
                currentDiffType = newDiffType;
                currentError = result.error;
                currentState = {
                  ...currentState,
                  document: currentState.document
                    ? {
                        ...currentState.document,
                        content: currentPatch,
                        gitRef: currentGitRef,
                      }
                    : currentState.document,
                };

                return Response.json({
                  rawPatch: currentPatch,
                  gitRef: currentGitRef,
                  diffType: currentDiffType,
                  ...(currentError && { error: currentError }),
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "Failed to switch diff";
                return Response.json({ error: message }, { status: 500 });
              }
            }

            if (url.pathname === "/api/file-content" && req.method === "GET") {
              const filePath = url.searchParams.get("path");
              if (!filePath) {
                return Response.json({ error: "Missing path" }, { status: 400 });
              }
              try {
                validateFilePath(filePath);
              } catch {
                return Response.json({ error: "Invalid path" }, { status: 400 });
              }
              const oldPath = url.searchParams.get("oldPath") || undefined;
              if (oldPath) {
                try {
                  validateFilePath(oldPath);
                } catch {
                  return Response.json({ error: "Invalid path" }, { status: 400 });
                }
              }
              const defaultBranch = gitContext?.defaultBranch || "main";
              const result = await getFileContentsForDiff(
                currentDiffType,
                defaultBranch,
                filePath,
                oldPath,
                cwd,
              );
              return Response.json(result);
            }

            if (url.pathname === "/api/git-add" && req.method === "POST") {
              try {
                const body = (await req.json()) as {
                  filePath: string;
                  undo?: boolean;
                };
                if (!body.filePath) {
                  return Response.json({ error: "Missing filePath" }, { status: 400 });
                }

                let targetCwd: string | undefined;
                if (currentDiffType.startsWith("worktree:")) {
                  const parsed = parseWorktreeDiffType(currentDiffType);
                  if (parsed) {
                    targetCwd = parsed.path;
                  }
                }
                if (!targetCwd) {
                  targetCwd = options.cwd;
                }

                if (body.undo) {
                  await gitResetFile(body.filePath, targetCwd);
                } else {
                  await gitAddFile(body.filePath, targetCwd);
                }

                return Response.json({ ok: true });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "Failed to git add";
                return Response.json({ error: message }, { status: 500 });
              }
            }

            if (url.pathname === "/api/image") {
              return handleImage(req);
            }

            if (url.pathname === "/api/upload" && req.method === "POST") {
              return handleUpload(req);
            }

            if (url.pathname === "/api/agents") {
              return handleAgents(options.opencodeClient);
            }

            if (url.pathname === "/api/draft") {
              if (req.method === "POST") return handleDraftSave(req, draftKey);
              if (req.method === "DELETE") return handleDraftDelete(draftKey);
              return handleDraftLoad(draftKey);
            }

            const editorResponse = await editorAnnotations.handle(req, url);
            if (editorResponse) {
              return editorResponse;
            }

            return undefined;
          },
        },
        eventBus,
      );

      server = Bun.serve({
        port: configuredPort,
        fetch: router.fetch,
      });

      break; // Success, exit retry loop
    } catch (err: unknown) {
      const isAddressInUse =
        err instanceof Error && err.message.includes("EADDRINUSE");

      if (isAddressInUse && attempt < MAX_RETRIES) {
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }

      if (isAddressInUse) {
        const hint =
          configuredPort !== 0
            ? " (set PLANNOTATOR_PORT to use different port)"
            : "";
        throw new Error(
          `Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`,
        );
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start server");
  }

  const serverUrl = `http://localhost:${server.port}`;

  // Notify caller that server is ready
  if (onReady) {
    onReady(serverUrl, false, server.port);
  }

  return {
    port: server.port,
    url: serverUrl,
    isRemote: false,
    waitForDecision: () => decisionPromise,
    stop: cleanup,
  };
}
