/**
 * Plannotator Shared Server
 *
 * Provides a consistent server implementation for both Claude Code and OpenCode plugins.
 *
 * Environment variables:
 *   PLANNOTATOR_PORT   - Optional fixed port for the local review server
 *   PLANNOTATOR_ORIGIN - Origin identifier ("claude-code" or "opencode")
 */

import { resolve } from "path";
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
  savePlan,
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

// Re-export utilities
export { getServerPort } from "./port";
export { openBrowser } from "./browser";
export * from "./integrations";
export * from "./storage";
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


  // Decision promise
  let resolveDecision: (result: {
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
    cancelled?: boolean;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
    cancelled?: boolean;
  }>((resolve) => {
    resolveDecision = resolve;
  });

  // Handle CLI signals for graceful cancellation
  const handleSignal = () => {
    deleteDraft(draftKey);
    resolveDecision({
      approved: false,
      feedback: "Review cancelled by user via CLI signal.",
      cancelled: true,
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // Cleanup: unregister signal handlers and stop the server.
  // Used by both /api/shutdown (in-request path) and the returned stop() method.
  const cleanup = () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    server?.stop();
  };

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        port: configuredPort,

        async fetch(req) {
          const url = new URL(req.url);

          // API: Get a specific plan version from history
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

          // API: List all versions for the current plan
          if (url.pathname === "/api/plan/versions") {
            return Response.json({
              project,
              slug,
              versions: await listVersions(project, slug),
            });
          }

          // API: List all plans in the current project
          if (url.pathname === "/api/plan/history") {
            return Response.json({
              project,
              plans: await listProjectPlans(project),
            });
          }

          // API: Get plan content
          if (url.pathname === "/api/plan") {
            return Response.json({
              plan,
              origin,
              permissionMode,
              repoInfo,
              previousPlan,
              versionInfo,
            });
          }

          // API: Serve a linked markdown document
          if (url.pathname === "/api/doc" && req.method === "GET") {
            return handleDoc(req);
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            return handleImage(req);
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // API: Open plan diff in VS Code
          if (url.pathname === "/api/plan/vscode-diff" && req.method === "POST") {
            try {
              const body = (await req.json()) as { baseVersion: number };

              if (!body.baseVersion) {
                return Response.json({ error: "Missing baseVersion" }, { status: 400 });
              }

              const basePath = await getPlanVersionPath(project, slug, body.baseVersion);
              if (!basePath) {
                return Response.json({ error: `Version ${body.baseVersion} not found` }, { status: 404 });
              }

              const result = await openEditorDiff(basePath, currentPlanPath);
              if ("error" in result) {
                return Response.json({ error: result.error }, { status: 500 });
              }
              return Response.json({ ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to open VS Code diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Detect Obsidian vaults
          if (url.pathname === "/api/obsidian/vaults") {
            return handleObsidianVaults();
          }

          // API: List Obsidian vault files as a tree
          if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
            return handleObsidianFiles(req);
          }

          // API: Read an Obsidian vault document
          if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
            return handleObsidianDoc(req);
          }

          // API: Get available agents (OpenCode only)
          if (url.pathname === "/api/agents") {
            return handleAgents(options.opencodeClient);
          }

          // API: Annotation draft persistence
          if (url.pathname === "/api/draft") {
            if (req.method === "POST") return handleDraftSave(req, draftKey);
            if (req.method === "DELETE") return handleDraftDelete(draftKey);
            return handleDraftLoad(draftKey);
          }

          // API: Editor annotations (VS Code extension)
          const editorResponse = await editorAnnotations.handle(req, url);
          if (editorResponse) return editorResponse;

          // API: Save to notes (decoupled from approve/deny)
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
            } catch (err) {
              console.error(`[Save Notes] Error:`, err);
              return Response.json({ error: "Save failed" }, { status: 500 });
            }

            return Response.json({ ok: true, results });
          }

          // API: Approve plan
          if (url.pathname === "/api/approve" && req.method === "POST") {
            // Check for note integrations and optional feedback
            let feedback: string | undefined;
            let agentSwitch: string | undefined;
            let requestedPermissionMode: string | undefined;
            let planSaveEnabled = true; // default to enabled for backwards compat
            let planSaveCustomPath: string | undefined;
            try {
              const body = (await req.json().catch(() => ({}))) as {
                obsidian?: ObsidianConfig;
                bear?: BearConfig;
                feedback?: string;
                agentSwitch?: string;
                planSave?: { enabled: boolean; customPath?: string };
                permissionMode?: string;
              };

              // Capture feedback if provided (for "approve with notes")
              if (body.feedback) {
                feedback = body.feedback;
              }

              // Capture agent switch setting for OpenCode
              if (body.agentSwitch) {
                agentSwitch = body.agentSwitch;
              }

              // Capture permission mode from client request (Claude Code)
              if (body.permissionMode) {
                requestedPermissionMode = body.permissionMode;
              }

              // Capture plan save settings
              if (body.planSave !== undefined) {
                planSaveEnabled = body.planSave.enabled;
                planSaveCustomPath = body.planSave.customPath;
              }

              // Obsidian integration
              if (body.obsidian?.vaultPath && body.obsidian?.plan) {
                const result = await saveToObsidian(body.obsidian);
                if (result.success) {
                  console.error(`[Obsidian] Saved plan to: ${result.path}`);
                } else {
                  console.error(`[Obsidian] Save failed: ${result.error}`);
                }
              }

              // Bear integration
              if (body.bear?.plan) {
                const result = await saveToBear(body.bear);
                if (result.success) {
                  console.error(`[Bear] Saved plan to Bear`);
                } else {
                  console.error(`[Bear] Save failed: ${result.error}`);
                }
              }
            } catch (err) {
              // Don't block approval on integration errors
              console.error(`[Integration] Error:`, err);
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              const annotations = feedback || "";
              if (annotations) {
                saveAnnotations(slug, annotations, planSaveCustomPath);
              }
              savedPath = saveFinalSnapshot(slug, "approved", plan, annotations, planSaveCustomPath);
              
              // Add feedback to history if feedback was provided
              if (feedback) {
                try {
                  const historyDir = await getHistoryDir(project);
                  const msg = `Approve plan ${slug} (v${versionInfo.version})\n\nFeedback:\n${feedback}`;
                  await Bun.$`git commit --allow-empty -m ${msg}`.cwd(historyDir).quiet().nothrow();
                } catch (e) {
                  console.error("Failed to commit approval feedback to history", e);
                }
              }
            }

            // Clean up draft on successful submit
            deleteDraft(draftKey);

            // Use permission mode from client request if provided, otherwise fall back to hook input
            const effectivePermissionMode = requestedPermissionMode || permissionMode;
            resolveDecision({ approved: true, feedback, savedPath, agentSwitch, permissionMode: effectivePermissionMode });
            return Response.json({ ok: true, savedPath });
          }

          // API: Deny with feedback
          if (url.pathname === "/api/deny" && req.method === "POST") {
            let feedback = "Plan rejected by user";
            let planSaveEnabled = true; // default to enabled for backwards compat
            let planSaveCustomPath: string | undefined;
            try {
              const body = (await req.json()) as {
                feedback?: string;
                planSave?: { enabled: boolean; customPath?: string };
              };
              feedback = body.feedback || feedback;

              // Capture plan save settings
              if (body.planSave !== undefined) {
                planSaveEnabled = body.planSave.enabled;
                planSaveCustomPath = body.planSave.customPath;
              }
            } catch {
              // Use default feedback
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              saveAnnotations(slug, feedback, planSaveCustomPath);
              savedPath = saveFinalSnapshot(slug, "denied", plan, feedback, planSaveCustomPath);
              
              // Add feedback to history
              try {
                const historyDir = await getHistoryDir(project);
                const msg = `Reject plan ${slug} (v${versionInfo.version})\n\nFeedback:\n${feedback}`;
                await Bun.$`git commit --allow-empty -m ${msg}`.cwd(historyDir).quiet().nothrow();
              } catch (e) {
                console.error("Failed to commit rejection feedback to history", e);
              }
            }

            deleteDraft(draftKey);
            resolveDecision({ approved: false, feedback, savedPath });
            return Response.json({ ok: true, savedPath });
          }

          // API: Cancel review
          if (url.pathname === "/api/cancel" && req.method === "POST") {
            deleteDraft(draftKey);
            resolveDecision({
              approved: false,
              feedback: "Review cancelled by user.",
              cancelled: true,
            });
            return Response.json({ ok: true });
          }

          // API: Reset annotations
          if (url.pathname === "/api/reset" && req.method === "POST") {
            deleteDraft(draftKey);
            return Response.json({ ok: true });
          }

          // API: Explicitly cancel and shutdown the server
          if (url.pathname === "/api/shutdown" && req.method === "POST") {
            setTimeout(cleanup, 10);
            return Response.json({ ok: true });
          }

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
          });
        },
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
