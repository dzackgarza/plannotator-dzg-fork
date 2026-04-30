/**
 * Plannotator Shared Server
 *
 * Provides a consistent server implementation for both Claude Code and OpenCode plugins.
 *
 * Environment variables:
 *   PLANNOTATOR_PORT   - Optional fixed port for the local review server
 *   PLANNOTATOR_ORIGIN - Origin identifier ("claude-code" or "opencode")
 */

import { getServerPort } from "./port";
import { openEditorDiff } from "./ide";
import {
  saveToObsidian,
  saveToBear,
  type ObsidianConfig,
  type BearConfig,
  type IntegrationResult,
} from "./integrations";
import {
  generateSlug,
  saveAnnotations,
  saveFinalSnapshot,
  saveToHistory,
  getPlanVersion,
  getPlanVersionPath,
  getVersionCount,
  listVersions,
  listProjectPlans,
  getHistoryDir,
} from "./storage";
import { getRepoInfo } from "./repo";
import { detectProjectName } from "./project";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { handleDoc, handleObsidianVaults, handleObsidianFiles, handleObsidianDoc } from "./reference-handlers";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createDaemonRouter, type DaemonRouterEvent } from "./daemon-router";
import { createDaemonEventBus } from "./daemon-events";
import { transition, type DaemonState, type FeedbackPayload } from "./state";

// Re-export utilities
export { getServerPort } from "./port";
export { openBrowser } from "./browser";
export * from "./integrations";
export * from "./storage";
export * from "./daemon";
export { handleServerReady } from "./shared-handlers";
export { type VaultNode, buildFileTree } from "./reference-handlers";

// --- Types ---

export interface ServerOptions {
  /** The plan markdown content */
  plan: string;
  /** Origin identifier (e.g., "claude-code", "opencode") */
  origin: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Current permission mode to preserve (Claude Code only) */
  permissionMode?: string;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  /** OpenCode client for querying available agents (OpenCode only) */
  opencodeClient?: OpencodeClient;
  /** Commit message provided by the agent for the plan version */
  commitMessage?: string;
}

export interface ServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user decision (approve/deny) */
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
    cancelled?: boolean;
  }>;
  /** Stop the server */
  stop: () => void;
}

type PlanDecisionResult = {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
  cancelled?: boolean;
};

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Plannotator server
 *
 * Handles:
 * - Remote detection and port configuration
 * - All API routes (/api/plan, /api/approve, /api/deny, etc.)
 * - Obsidian/Bear integrations
 * - Port conflict retries
 */
export async function startPlannotatorServer(
  options: ServerOptions
): Promise<ServerResult> {
  const { plan, origin, htmlContent, permissionMode, onReady, commitMessage } =
    options;

  const configuredPort = getServerPort();
  const draftKey = contentHash(plan);
  const editorAnnotations = createEditorAnnotationHandler();

  // Generate slug for potential saving (actual save happens on decision)
  const slug = generateSlug(plan);

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo();

  // Version history: save plan and detect previous version
  const project = (await detectProjectName()) ?? "_unknown";
  const historyResult = await saveToHistory(project, slug, plan, commitMessage, origin);
  const currentPlanPath = historyResult.path;
  const previousPlan =
    historyResult.version > 1
      ? await getPlanVersion(project, slug, historyResult.version - 1)
      : null;
  const versionInfo = {
    version: historyResult.version,
    totalVersions: await getVersionCount(project, slug),
    project,
  };

  let currentState: DaemonState = {
    schemaVersion: 1,
    status: "awaiting-response",
    document: {
      id: slug,
      mode: "plan",
      origin: origin as "claude-code" | "opencode",
      content: plan,
    },
    feedback: null,
  };

  const eventBus = createDaemonEventBus();
  let decisionMeta: Pick<
    PlanDecisionResult,
    "savedPath" | "agentSwitch" | "permissionMode"
  > = {};
  const decisionPromise = new Promise<PlanDecisionResult>((resolveDecision) => {
    const unsubscribe = eventBus.subscribe((event: DaemonRouterEvent) => {
      if (event.type !== "resolved") {
        return;
      }

      unsubscribe();
      resolveDecision({
        approved: event.feedback.approved,
        feedback: event.feedback.feedback,
        savedPath: decisionMeta.savedPath,
        agentSwitch: decisionMeta.agentSwitch ?? event.feedback.agentSwitch,
        permissionMode:
          decisionMeta.permissionMode ?? event.feedback.permissionMode,
        cancelled: event.feedback.cancelled,
      });
    });
  });

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

    decisionMeta = {};
    currentState = nextState;
    eventBus.emit({
      type: "resolved",
      feedback,
      state: nextState,
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // Cleanup: unregister signal handlers and stop the server.
  const cleanup = () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    server?.stop();
  };

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const router = createDaemonRouter(
        {
          getState: () => currentState,
          setState: (nextState) => {
            currentState = nextState;
          },
          planHtml: htmlContent,
          getPlanResponse: () => ({
            permissionMode,
            repoInfo,
            previousPlan,
            versionInfo,
          }),
          async onApprove({ body, feedback }) {
            decisionMeta = {
              agentSwitch: feedback.agentSwitch,
              permissionMode: feedback.permissionMode,
            };
            let savedPath: string | undefined;
            let planSaveEnabled = true;
            let planSaveCustomPath: string | undefined;

            try {
              const approveBody = body as {
                obsidian?: ObsidianConfig;
                bear?: BearConfig;
                planSave?: { enabled: boolean; customPath?: string };
              };

              if (approveBody.planSave !== undefined) {
                planSaveEnabled = approveBody.planSave.enabled;
                planSaveCustomPath = approveBody.planSave.customPath;
              }

              if (approveBody.obsidian?.vaultPath && approveBody.obsidian?.plan) {
                const result = await saveToObsidian(approveBody.obsidian);
                if (result.success) {
                  console.error(`[Obsidian] Saved plan to: ${result.path}`);
                } else {
                  console.error(`[Obsidian] Save failed: ${result.error}`);
                }
              }

              if (approveBody.bear?.plan) {
                const result = await saveToBear(approveBody.bear);
                if (result.success) {
                  console.error(`[Bear] Saved plan to Bear`);
                } else {
                  console.error(`[Bear] Save failed: ${result.error}`);
                }
              }
            } catch (error) {
              console.error(`[Integration] Error:`, error);
            }

            if (planSaveEnabled) {
              if (feedback.feedback) {
                saveAnnotations(slug, feedback.feedback, planSaveCustomPath);
              }

              savedPath = saveFinalSnapshot(
                slug,
                "approved",
                plan,
                feedback.feedback,
                planSaveCustomPath,
              );

              if (feedback.feedback) {
                try {
                  const historyDir = await getHistoryDir(project);
                  const msg = `Approve plan ${slug} (v${versionInfo.version})\n\nFeedback:\n${feedback.feedback}`;
                  await Bun.$`git commit --allow-empty -m ${msg}`.cwd(historyDir).quiet().nothrow();
                } catch (error) {
                  console.error("Failed to commit approval feedback to history", error);
                }
              }
            }

            deleteDraft(draftKey);
            decisionMeta.savedPath = savedPath;
            return { savedPath };
          },
          async onDeny({ body, feedback }) {
            decisionMeta = {};
            const denyBody = body as {
              planSave?: { enabled: boolean; customPath?: string };
            };

            let savedPath: string | undefined;
            const planSaveEnabled =
              denyBody.planSave === undefined ? true : denyBody.planSave.enabled;
            const planSaveCustomPath = denyBody.planSave?.customPath;

            if (planSaveEnabled) {
              saveAnnotations(slug, feedback.feedback, planSaveCustomPath);
              savedPath = saveFinalSnapshot(
                slug,
                "denied",
                plan,
                feedback.feedback,
                planSaveCustomPath,
              );

              try {
                const historyDir = await getHistoryDir(project);
                const msg = `Reject plan ${slug} (v${versionInfo.version})\n\nFeedback:\n${feedback.feedback}`;
                await Bun.$`git commit --allow-empty -m ${msg}`.cwd(historyDir).quiet().nothrow();
              } catch (error) {
                console.error("Failed to commit rejection feedback to history", error);
              }
            }

            deleteDraft(draftKey);
            decisionMeta.savedPath = savedPath;
            return { savedPath };
          },
          onCancel() {
            decisionMeta = {};
            deleteDraft(draftKey);
          },
          onReset() {
            deleteDraft(draftKey);
          },
          async handleFallback(req, url) {
            if (url.pathname === "/api/plan/version") {
              const vParam = url.searchParams.get("v");
              if (!vParam) {
                return new Response("Missing v parameter", { status: 400 });
              }
              const v = parseInt(vParam, 10);
              if (isNaN(v) || v < 1) {
                return new Response("Invalid version number", { status: 400 });
              }
              const content = await getPlanVersion(project, slug, v);
              if (content === null) {
                return Response.json({ error: "Version not found" }, { status: 404 });
              }
              return Response.json({ plan: content, version: v });
            }

            if (url.pathname === "/api/plan/versions") {
              return Response.json({
                project,
                slug,
                versions: await listVersions(project, slug),
              });
            }

            if (url.pathname === "/api/plan/history") {
              return Response.json({
                project,
                plans: await listProjectPlans(project),
              });
            }

            if (url.pathname === "/api/doc" && req.method === "GET") {
              return handleDoc(req);
            }

            if (url.pathname === "/api/image") {
              return handleImage(req);
            }

            if (url.pathname === "/api/upload" && req.method === "POST") {
              return handleUpload(req);
            }

            if (url.pathname === "/api/plan/vscode-diff" && req.method === "POST") {
              try {
                const body = (await req.json()) as { baseVersion: number };

                if (!body.baseVersion) {
                  return Response.json({ error: "Missing baseVersion" }, { status: 400 });
                }

                const basePath = await getPlanVersionPath(project, slug, body.baseVersion);
                if (!basePath) {
                  return Response.json(
                    { error: `Version ${body.baseVersion} not found` },
                    { status: 404 },
                  );
                }

                const result = await openEditorDiff(basePath, currentPlanPath);
                if ("error" in result) {
                  return Response.json({ error: result.error }, { status: 500 });
                }
                return Response.json({ ok: true });
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : "Failed to open VS Code diff";
                return Response.json({ error: message }, { status: 500 });
              }
            }

            if (url.pathname === "/api/obsidian/vaults") {
              return handleObsidianVaults();
            }

            if (
              url.pathname === "/api/reference/obsidian/files" &&
              req.method === "GET"
            ) {
              return handleObsidianFiles(req);
            }

            if (
              url.pathname === "/api/reference/obsidian/doc" &&
              req.method === "GET"
            ) {
              return handleObsidianDoc(req);
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

            if (url.pathname === "/api/save-notes" && req.method === "POST") {
              const results: { obsidian?: IntegrationResult; bear?: IntegrationResult } = {};

              try {
                const body = (await req.json()) as {
                  obsidian?: ObsidianConfig;
                  bear?: BearConfig;
                };

                if (body.obsidian?.vaultPath && body.obsidian?.plan) {
                  results.obsidian = await saveToObsidian(body.obsidian);
                  if (results.obsidian.success) {
                    console.error(`[Obsidian] Saved plan to: ${results.obsidian.path}`);
                  } else {
                    console.error(`[Obsidian] Save failed: ${results.obsidian.error}`);
                  }
                }

                if (body.bear?.plan) {
                  results.bear = await saveToBear(body.bear);
                  if (results.bear.success) {
                    console.error(`[Bear] Saved plan to Bear`);
                  } else {
                    console.error(`[Bear] Save failed: ${results.bear.error}`);
                  }
                }
              } catch (error) {
                console.error(`[Save Notes] Error:`, error);
                return Response.json({ error: "Save failed" }, { status: 500 });
              }

              return Response.json({ ok: true, results });
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
