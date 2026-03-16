/**
 * Persistent Plannotator Server
 *
 * A single long-running Bun.serve instance that handles all three session types
 * (plan, review, annotate). Tracks one active session at a time.
 *
 * Environment variables:
 *   PLANNOTATOR_PORT   - Fixed port (default: 19432)
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote/devcontainer mode
 *   OPENCODE_BASE_URL  - OpenCode API base URL for agent listing (default: http://127.0.0.1:4096)
 */

import { dirname } from "path";
import { isRemoteSession } from "./remote";
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
import {
  handleImage,
  handleUpload,
  handleDraftSave,
  handleDraftLoad,
  handleDraftDelete,
} from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import {
  handleDoc,
  handleObsidianVaults,
  handleObsidianFiles,
  handleObsidianDoc,
} from "./reference-handlers";
import { createEditorAnnotationHandler } from "./editor-annotations";
import {
  type DiffType,
  type GitContext,
  runGitDiff,
  getFileContentsForDiff,
  gitAddFile,
  gitResetFile,
  parseWorktreeDiffType,
  validateFilePath,
} from "./git";
import { registerSession, unregisterSession } from "./sessions";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const PERSISTENT_SERVER_DEFAULT_PORT = 19432;

/** Serializable plan session data sent by the plugin over HTTP. */
export interface PlanSessionData {
  plan: string;
  origin: string;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  permissionMode?: string;
  commitMessage?: string;
}

/** Serializable review session data sent by the plugin over HTTP. */
export interface ReviewSessionData {
  rawPatch: string;
  gitRef: string;
  error?: string;
  origin?: string;
  diffType?: DiffType;
  gitContext?: GitContext;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  cwd?: string;
}

/** Serializable annotate session data sent by the plugin over HTTP. */
export interface AnnotateSessionData {
  markdown: string;
  filePath: string;
  origin?: string;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
}

export type SessionSubmission =
  | { type: "plan"; data: PlanSessionData }
  | { type: "review"; data: ReviewSessionData }
  | { type: "annotate"; data: AnnotateSessionData };

export type PlanDecision = {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
  cancelled?: boolean;
};

export type ReviewDecision = {
  approved: boolean;
  feedback: string;
  annotations: unknown[];
  agentSwitch?: string;
  cancelled?: boolean;
};

export type AnnotateDecision = {
  feedback: string;
  annotations: unknown[];
  cancelled?: boolean;
};

export type AnyDecision = PlanDecision | ReviewDecision | AnnotateDecision;

export interface PersistentServerOptions {
  planHtml: string;
  reviewHtml: string;
  /** Port to bind (default: PLANNOTATOR_PORT env var or 19432). */
  port?: number;
}

export interface PersistentServerHandle {
  port: number;
  url: string;
  isRemote: boolean;
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Internal phase state
// ---------------------------------------------------------------------------

type ServerPhase =
  | { phase: "idle" }
  | {
      phase: "annotating";
      submission: SessionSubmission;
      draftKey: string;
      editorAnnotations: ReturnType<typeof createEditorAnnotationHandler>;
      resolve: (decision: AnyDecision) => void;
      promise: Promise<AnyDecision>;
      // Plan-specific derived state (populated during POST /api/session)
      slug?: string;
      project?: string;
      versionInfo?: { version: number; totalVersions: number; project: string };
      currentPlanPath?: string;
      repoInfo?: Awaited<ReturnType<typeof getRepoInfo>>;
      previousPlan?: string | null;
      // Review-specific mutable state
      currentPatch?: string;
      currentGitRef?: string;
      currentDiffType?: DiffType;
      currentError?: string;
    };

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function startPersistentServer(
  options: PersistentServerOptions
): PersistentServerHandle {
  const { planHtml, reviewHtml } = options;
  const isRemote = isRemoteSession();

  const port =
    options.port ??
    (process.env.PLANNOTATOR_PORT
      ? parseInt(process.env.PLANNOTATOR_PORT, 10)
      : PERSISTENT_SERVER_DEFAULT_PORT);

  let serverPhase: ServerPhase = { phase: "idle" };

  const server = Bun.serve({
    port,

    async fetch(req) {
      const url = new URL(req.url);

      // ── Health check ───────────────────────────────────────────────────────
      if (url.pathname === "/api/health" && req.method === "GET") {
        return Response.json({
          phase: serverPhase.phase,
          ...(serverPhase.phase === "annotating" && {
            type: serverPhase.submission.type,
          }),
        });
      }

      // ── Submit new session ─────────────────────────────────────────────────
      if (url.pathname === "/api/session" && req.method === "POST") {
        if (serverPhase.phase === "annotating") {
          return Response.json(
            {
              error:
                "An annotation is already in progress. Open the review UI to submit feedback or cancel before starting a new annotation.",
              url: `http://localhost:${server.port}`,
            },
            { status: 409 }
          );
        }

        let submission: SessionSubmission;
        try {
          submission = (await req.json()) as SessionSubmission;
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        let resolve!: (decision: AnyDecision) => void;
        const promise = new Promise<AnyDecision>((r) => {
          resolve = r;
        });

        const draftKey =
          submission.type === "plan"
            ? contentHash(submission.data.plan)
            : submission.type === "review"
              ? contentHash(submission.data.rawPatch ?? "")
              : contentHash(submission.data.markdown);

        serverPhase = {
          phase: "annotating",
          submission,
          draftKey,
          editorAnnotations: createEditorAnnotationHandler(),
          resolve,
          promise,
        };

        // Initialize session-type-specific derived state
        if (submission.type === "plan") {
          const d = submission.data;
          const repoInfo = await getRepoInfo().catch(() => undefined);
          const slug = generateSlug(d.plan);
          const project =
            (await detectProjectName().catch(() => null)) ?? "_unknown";
          const historyResult = await saveToHistory(
            project,
            slug,
            d.plan,
            d.commitMessage,
            d.origin
          ).catch(() => ({ path: "", version: 1 }));
          const previousPlan =
            historyResult.version > 1
              ? await getPlanVersion(
                  project,
                  slug,
                  historyResult.version - 1
                ).catch(() => null)
              : null;
          const totalVersions = await getVersionCount(project, slug).catch(
            () => 1
          );
          if (serverPhase.phase === "annotating") {
            serverPhase.slug = slug;
            serverPhase.project = project;
            serverPhase.currentPlanPath = historyResult.path;
            serverPhase.repoInfo = repoInfo;
            serverPhase.previousPlan = previousPlan;
            serverPhase.versionInfo = {
              version: historyResult.version,
              totalVersions,
              project,
            };
          }
        } else if (submission.type === "review") {
          const d = submission.data;
          const repoInfo = await getRepoInfo(d.cwd).catch(() => undefined);
          if (serverPhase.phase === "annotating") {
            serverPhase.repoInfo = repoInfo;
            serverPhase.currentPatch = d.rawPatch;
            serverPhase.currentGitRef = d.gitRef;
            serverPhase.currentDiffType = d.diffType ?? "uncommitted";
            serverPhase.currentError = d.error;
          }
        } else {
          const repoInfo = await getRepoInfo().catch(() => undefined);
          if (serverPhase.phase === "annotating") {
            serverPhase.repoInfo = repoInfo;
          }
        }

        return Response.json({
          ok: true,
          url: `http://localhost:${server.port}`,
          port: server.port,
        });
      }

      // ── Long-poll for decision ─────────────────────────────────────────────
      if (url.pathname === "/api/wait" && req.method === "GET") {
        if (serverPhase.phase !== "annotating") {
          return Response.json({ error: "No active annotation" }, { status: 404 });
        }
        const result = await serverPhase.promise;
        return Response.json(result);
      }

      // ── Plan routes ────────────────────────────────────────────────────────

      if (url.pathname === "/api/plan" && req.method === "GET") {
        if (serverPhase.phase !== "annotating")
          return Response.json({ phase: "idle" });
        const s = serverPhase;
        if (s.submission.type === "plan") {
          const d = s.submission.data;
          return Response.json({
            plan: d.plan,
            origin: d.origin,
            permissionMode: d.permissionMode,
            sharingEnabled: d.sharingEnabled ?? true,
            shareBaseUrl: d.shareBaseUrl,
            pasteApiUrl: d.pasteApiUrl,
            repoInfo: s.repoInfo,
            previousPlan: s.previousPlan,
            versionInfo: s.versionInfo,
          });
        }
        if (s.submission.type === "annotate") {
          const d = s.submission.data;
          return Response.json({
            plan: d.markdown,
            origin: d.origin,
            mode: "annotate",
            filePath: d.filePath,
            sharingEnabled: d.sharingEnabled ?? true,
            shareBaseUrl: d.shareBaseUrl,
            repoInfo: s.repoInfo,
          });
        }
        return Response.json({ error: "Wrong session type" }, { status: 400 });
      }

      if (url.pathname === "/api/plan/version" && req.method === "GET") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "plan")
          return Response.json({ error: "No plan session" }, { status: 404 });
        const vParam = url.searchParams.get("v");
        if (!vParam) return new Response("Missing v parameter", { status: 400 });
        const v = parseInt(vParam, 10);
        if (isNaN(v) || v < 1)
          return new Response("Invalid version number", { status: 400 });
        const { slug, project } = serverPhase;
        if (!slug || !project)
          return Response.json(
            { error: "Session not initialized" },
            { status: 500 }
          );
        const content = await getPlanVersion(project, slug, v);
        if (content === null)
          return Response.json({ error: "Version not found" }, { status: 404 });
        return Response.json({ plan: content, version: v });
      }

      if (url.pathname === "/api/plan/versions" && req.method === "GET") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "plan")
          return Response.json({ error: "No plan session" }, { status: 404 });
        const { slug, project } = serverPhase;
        if (!slug || !project)
          return Response.json(
            { error: "Session not initialized" },
            { status: 500 }
          );
        return Response.json({
          project,
          slug,
          versions: await listVersions(project, slug),
        });
      }

      if (url.pathname === "/api/plan/history" && req.method === "GET") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "plan")
          return Response.json({ error: "No plan session" }, { status: 404 });
        const { project } = serverPhase;
        if (!project)
          return Response.json(
            { error: "Session not initialized" },
            { status: 500 }
          );
        return Response.json({
          project,
          plans: await listProjectPlans(project),
        });
      }

      if (url.pathname === "/api/plan/vscode-diff" && req.method === "POST") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "plan")
          return Response.json({ error: "No plan session" }, { status: 404 });
        try {
          const body = (await req.json()) as { baseVersion: number };
          if (!body.baseVersion)
            return Response.json(
              { error: "Missing baseVersion" },
              { status: 400 }
            );
          const { slug, project, currentPlanPath } = serverPhase;
          if (!slug || !project || !currentPlanPath)
            return Response.json(
              { error: "Session not initialized" },
              { status: 500 }
            );
          const basePath = await getPlanVersionPath(
            project,
            slug,
            body.baseVersion
          );
          if (!basePath)
            return Response.json(
              { error: `Version ${body.baseVersion} not found` },
              { status: 404 }
            );
          const result = await openEditorDiff(basePath, currentPlanPath);
          if ("error" in result)
            return Response.json({ error: result.error }, { status: 500 });
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed" },
            { status: 500 }
          );
        }
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "plan")
          return Response.json({ error: "No plan session" }, { status: 404 });
        const { slug, project, versionInfo, draftKey } = serverPhase;
        const d = serverPhase.submission.data;
        let feedback: string | undefined;
        let agentSwitch: string | undefined;
        let requestedPermissionMode: string | undefined;
        let planSaveEnabled = true;
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
          if (body.feedback) feedback = body.feedback;
          if (body.agentSwitch) agentSwitch = body.agentSwitch;
          if (body.permissionMode) requestedPermissionMode = body.permissionMode;
          if (body.planSave !== undefined) {
            planSaveEnabled = body.planSave.enabled;
            planSaveCustomPath = body.planSave.customPath;
          }
          if (body.obsidian?.vaultPath && body.obsidian?.plan)
            await saveToObsidian(body.obsidian).catch(() => {});
          if (body.bear?.plan) await saveToBear(body.bear).catch(() => {});
        } catch {}

        let savedPath: string | undefined;
        if (planSaveEnabled && slug) {
          const annotations = feedback || "";
          if (annotations) saveAnnotations(slug, annotations, planSaveCustomPath);
          savedPath = saveFinalSnapshot(
            slug,
            "approved",
            d.plan,
            annotations,
            planSaveCustomPath
          );
          if (feedback && project && versionInfo) {
            try {
              const historyDir = await getHistoryDir(project);
              const msg = `Approve plan ${slug} (v${versionInfo.version})\n\nFeedback:\n${feedback}`;
              await Bun.$`git commit --allow-empty -m ${msg}`
                .cwd(historyDir)
                .quiet()
                .nothrow();
            } catch {}
          }
        }

        deleteDraft(draftKey);
        const effectivePermissionMode =
          requestedPermissionMode || d.permissionMode;
        const snap = serverPhase;
        serverPhase = { phase: "idle" };
        if (snap.phase === "annotating") snap.resolve({
          approved: true,
          feedback,
          savedPath,
          agentSwitch,
          permissionMode: effectivePermissionMode,
        });
        return Response.json({ ok: true, savedPath });
      }

      if (url.pathname === "/api/deny" && req.method === "POST") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "plan")
          return Response.json({ error: "No plan session" }, { status: 404 });
        const { slug, project, versionInfo, draftKey } = serverPhase;
        const d = serverPhase.submission.data;
        let feedback = "Plan rejected by user";
        let planSaveEnabled = true;
        let planSaveCustomPath: string | undefined;
        try {
          const body = (await req.json()) as {
            feedback?: string;
            planSave?: { enabled: boolean; customPath?: string };
          };
          feedback = body.feedback || feedback;
          if (body.planSave !== undefined) {
            planSaveEnabled = body.planSave.enabled;
            planSaveCustomPath = body.planSave.customPath;
          }
        } catch {}

        let savedPath: string | undefined;
        if (planSaveEnabled && slug) {
          saveAnnotations(slug, feedback, planSaveCustomPath);
          savedPath = saveFinalSnapshot(
            slug,
            "denied",
            d.plan,
            feedback,
            planSaveCustomPath
          );
          if (project && versionInfo) {
            try {
              const historyDir = await getHistoryDir(project);
              const msg = `Reject plan ${slug} (v${versionInfo.version})\n\nFeedback:\n${feedback}`;
              await Bun.$`git commit --allow-empty -m ${msg}`
                .cwd(historyDir)
                .quiet()
                .nothrow();
            } catch {}
          }
        }

        deleteDraft(draftKey);
        const snap2 = serverPhase;
        serverPhase = { phase: "idle" };
        if (snap2.phase === "annotating") snap2.resolve({ approved: false, feedback, savedPath });
        return Response.json({ ok: true, savedPath });
      }

      // ── Review routes ──────────────────────────────────────────────────────

      if (url.pathname === "/api/diff" && req.method === "GET") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "review")
          return Response.json({ error: "No review session" }, { status: 404 });
        const {
          currentPatch,
          currentGitRef,
          currentDiffType,
          currentError,
          repoInfo,
        } = serverPhase;
        const d = serverPhase.submission.data;
        return Response.json({
          rawPatch: currentPatch,
          gitRef: currentGitRef,
          origin: d.origin,
          diffType: currentDiffType,
          gitContext: d.gitContext,
          sharingEnabled: d.sharingEnabled ?? true,
          shareBaseUrl: d.shareBaseUrl,
          repoInfo,
          ...(currentError && { error: currentError }),
        });
      }

      if (url.pathname === "/api/diff/switch" && req.method === "POST") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "review")
          return Response.json({ error: "No review session" }, { status: 404 });
        try {
          const body = (await req.json()) as { diffType: DiffType };
          if (!body.diffType)
            return Response.json(
              { error: "Missing diffType" },
              { status: 400 }
            );
          const d = serverPhase.submission.data;
          const defaultBranch = d.gitContext?.defaultBranch || "main";
          const result = await runGitDiff(body.diffType, defaultBranch, d.cwd);
          serverPhase.currentPatch = result.patch;
          serverPhase.currentGitRef = result.label;
          serverPhase.currentDiffType = body.diffType;
          serverPhase.currentError = result.error;
          return Response.json({
            rawPatch: serverPhase.currentPatch,
            gitRef: serverPhase.currentGitRef,
            diffType: serverPhase.currentDiffType,
            ...(serverPhase.currentError && {
              error: serverPhase.currentError,
            }),
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed" },
            { status: 500 }
          );
        }
      }

      if (url.pathname === "/api/file-content" && req.method === "GET") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "review")
          return Response.json({ error: "No review session" }, { status: 404 });
        const filePath = url.searchParams.get("path");
        if (!filePath)
          return Response.json({ error: "Missing path" }, { status: 400 });
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
        const d = serverPhase.submission.data;
        const defaultBranch = d.gitContext?.defaultBranch || "main";
        const result = await getFileContentsForDiff(
          serverPhase.currentDiffType ?? "uncommitted",
          defaultBranch,
          filePath,
          oldPath,
          d.cwd
        );
        return Response.json(result);
      }

      if (url.pathname === "/api/git-add" && req.method === "POST") {
        if (serverPhase.phase !== "annotating" || serverPhase.submission.type !== "review")
          return Response.json({ error: "No review session" }, { status: 404 });
        try {
          const body = (await req.json()) as {
            filePath: string;
            undo?: boolean;
          };
          if (!body.filePath)
            return Response.json(
              { error: "Missing filePath" },
              { status: 400 }
            );
          const d = serverPhase.submission.data;
          let cwd = d.cwd;
          const dt = serverPhase.currentDiffType;
          if (dt?.startsWith("worktree:")) {
            const parsed = parseWorktreeDiffType(dt as DiffType);
            if (parsed) cwd = parsed.path;
          }
          if (body.undo) await gitResetFile(body.filePath, cwd);
          else await gitAddFile(body.filePath, cwd);
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed" },
            { status: 500 }
          );
        }
      }

      // ── Common feedback / cancel routes ────────────────────────────────────

      if (url.pathname === "/api/feedback" && req.method === "POST") {
        if (serverPhase.phase !== "annotating")
          return Response.json({ error: "No active session" }, { status: 404 });
        const { draftKey } = serverPhase;
        try {
          const body = (await req.json()) as {
            feedback?: string;
            annotations?: unknown[];
            approved?: boolean;
            agentSwitch?: string;
          };
          deleteDraft(draftKey);
          const snap3 = serverPhase;
          serverPhase = { phase: "idle" };
          if (snap3.phase === "annotating") {
            if (snap3.submission.type === "review") {
              snap3.resolve({
                approved: body.approved ?? false,
                feedback: body.feedback ?? "",
                annotations: body.annotations ?? [],
                agentSwitch: body.agentSwitch,
              });
            } else {
              snap3.resolve({
                feedback: body.feedback ?? "",
                annotations: body.annotations ?? [],
              });
            }
          }
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed" },
            { status: 500 }
          );
        }
      }

      if (url.pathname === "/api/cancel" && req.method === "POST") {
        if (serverPhase.phase === "annotating") {
          const { draftKey, submission } = serverPhase;
          deleteDraft(draftKey);
          const snap4 = serverPhase;
          serverPhase = { phase: "idle" };
          if (snap4.phase === "annotating") {
            if (submission.type === "plan") {
              snap4.resolve({
                approved: false,
                feedback: "Review cancelled by user.",
                cancelled: true,
              });
            } else if (submission.type === "review") {
              snap4.resolve({
                approved: false,
                feedback: "Review cancelled by user.",
                annotations: [],
                cancelled: true,
              });
            } else {
              snap4.resolve({
                feedback: "Annotation cancelled by user.",
                annotations: [],
                cancelled: true,
              });
            }
          }
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/reset" && req.method === "POST") {
        if (serverPhase.phase === "annotating") deleteDraft(serverPhase.draftKey);
        return Response.json({ ok: true });
      }

      // ── Shared handlers ────────────────────────────────────────────────────

      if (url.pathname === "/api/image") return handleImage(req);

      if (url.pathname === "/api/upload" && req.method === "POST")
        return handleUpload(req);

      if (url.pathname === "/api/doc" && req.method === "GET") {
        if (
          serverPhase.phase === "annotating" &&
          serverPhase.submission.type === "annotate" &&
          !url.searchParams.has("base")
        ) {
          const docUrl = new URL(req.url);
          docUrl.searchParams.set(
            "base",
            dirname(serverPhase.submission.data.filePath)
          );
          return handleDoc(new Request(docUrl.toString()));
        }
        return handleDoc(req);
      }

      if (url.pathname === "/api/draft") {
        if (serverPhase.phase !== "annotating")
          return Response.json({ error: "No active session" }, { status: 404 });
        const { draftKey } = serverPhase;
        if (req.method === "POST") return handleDraftSave(req, draftKey);
        if (req.method === "DELETE") return handleDraftDelete(draftKey);
        return handleDraftLoad(draftKey);
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        const baseUrl = (
          process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096"
        ).replace(/\/$/, "");
        try {
          const resp = await fetch(`${baseUrl}/v1/agent`);
          const data = await resp.json();
          return Response.json(data);
        } catch {
          return Response.json([]);
        }
      }

      if (url.pathname === "/api/obsidian/vaults")
        return handleObsidianVaults();

      if (
        url.pathname === "/api/reference/obsidian/files" &&
        req.method === "GET"
      )
        return handleObsidianFiles(req);

      if (
        url.pathname === "/api/reference/obsidian/doc" &&
        req.method === "GET"
      )
        return handleObsidianDoc(req);

      if (url.pathname === "/api/save-notes" && req.method === "POST") {
        const results: {
          obsidian?: IntegrationResult;
          bear?: IntegrationResult;
        } = {};
        try {
          const body = (await req.json()) as {
            obsidian?: ObsidianConfig;
            bear?: BearConfig;
          };
          if (body.obsidian?.vaultPath && body.obsidian?.plan)
            results.obsidian = await saveToObsidian(body.obsidian);
          if (body.bear?.plan) results.bear = await saveToBear(body.bear);
        } catch {}
        return Response.json({ ok: true, results });
      }

      // Editor annotations (VS Code extension)
      if (serverPhase.phase === "annotating") {
        const editorResponse = await serverPhase.editorAnnotations.handle(
          req,
          url
        );
        if (editorResponse) return editorResponse;
      }

      // SPA catch-all: serve planHtml regardless of phase (UI handles idle state)
      const html =
        serverPhase.phase === "annotating" && serverPhase.submission.type === "review"
          ? reviewHtml
          : planHtml;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    },
  });

  const serverUrl = `http://localhost:${server.port}`;

  registerSession({
    pid: process.pid,
    port: server.port,
    url: serverUrl,
    mode: "plan",
    project: "_unknown",
    startedAt: new Date().toISOString(),
    label: "Persistent Plannotator Server",
  });

  const cleanup = () => {
    unregisterSession(process.pid);
    server.stop();
  };

  process.on("exit", () => unregisterSession(process.pid));
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  return { port: server.port, url: serverUrl, isRemote, stop: cleanup };
}
