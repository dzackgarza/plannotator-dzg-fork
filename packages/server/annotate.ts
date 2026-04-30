/**
 * Annotate Server
 *
 * Provides a server for annotating arbitrary markdown files.
 * Follows the same patterns as the review server but serves
 * markdown content via /api/plan so the plan editor UI can
 * render it without modifications.
 *
 * Environment variables:
 *   PLANNOTATOR_PORT   - Optional fixed port for the local review server
 */

import { getServerPort } from "./port";
import { getRepoInfo } from "./repo";
import { handleImage, handleUpload, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete } from "./shared-handlers";
import { handleDoc } from "./reference-handlers";
import { contentHash, deleteDraft } from "./draft";
import { dirname } from "path";
import { createDaemonRouter, type DaemonRouterEvent } from "./daemon-router";
import { createDaemonEventBus } from "./daemon-events";
import { transition, type DaemonState, type FeedbackPayload } from "./state";

// Re-export utilities
export { getServerPort } from "./port";
export { openBrowser } from "./browser";
export { handleServerReady as handleAnnotateServerReady } from "./shared-handlers";

// --- Types ---

export interface AnnotateServerOptions {
  /** Markdown content of the file to annotate */
  markdown: string;
  /** Original file path (for display purposes) */
  filePath: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Origin identifier for UI customization */
  origin?: "opencode" | "claude-code";
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
}

export interface AnnotateServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user feedback submission */
  waitForDecision: () => Promise<{
    feedback: string;
    annotations: unknown[];
    cancelled?: boolean;
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Annotate server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes (/api/plan with mode:"annotate", /api/feedback)
 * - Port conflict retries
 */
export async function startAnnotateServer(
  options: AnnotateServerOptions
): Promise<AnnotateServerResult> {
  const {
    markdown,
    filePath,
    htmlContent,
    origin,
    onReady,
  } = options;

  const configuredPort = getServerPort();
  const draftKey = contentHash(markdown);
  let currentState: DaemonState = {
    schemaVersion: 1,
    status: "awaiting-response",
    document: {
      id: `annotate-${crypto.randomUUID()}`,
      mode: "annotate",
      origin: origin ?? "claude-code",
      content: markdown,
      filePath,
    },
    feedback: null,
  };

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo();

  const eventBus = createDaemonEventBus();
  const decisionPromise = new Promise<{
    feedback: string;
    annotations: unknown[];
    cancelled?: boolean;
  }>((resolveDecision) => {
    const unsubscribe = eventBus.subscribe((event: DaemonRouterEvent) => {
      if (event.type !== "resolved") {
        return;
      }

      unsubscribe();
      resolveDecision({
        feedback: event.feedback.feedback,
        annotations: event.feedback.annotations,
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
          planHtml: htmlContent,
          getAnnotateResponse: () => ({
            repoInfo,
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
          handleFallback(req, url) {
            if (url.pathname === "/api/image") {
              return handleImage(req);
            }

            if (url.pathname === "/api/doc" && req.method === "GET") {
              if (!url.searchParams.has("base")) {
                const docUrl = new URL(req.url);
                docUrl.searchParams.set("base", dirname(filePath));
                return handleDoc(new Request(docUrl.toString()));
              }
              return handleDoc(req);
            }

            if (url.pathname === "/api/upload" && req.method === "POST") {
              return handleUpload(req);
            }

            if (url.pathname === "/api/draft") {
              if (req.method === "POST") return handleDraftSave(req, draftKey);
              if (req.method === "DELETE") return handleDraftDelete(draftKey);
              return handleDraftLoad(draftKey);
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
          `Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`
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
