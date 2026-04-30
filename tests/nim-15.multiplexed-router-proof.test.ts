import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  transition,
  type DaemonState,
  type DocumentSnapshot,
  type FeedbackPayload,
} from "../packages/server/state";

type BuiltUiArtifacts = {
  planHtml: string;
  reviewHtml: string;
};

type CommandResult = {
  script: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type DaemonRouterFactory = (
  state: Record<string, unknown>,
  eventBus: Record<string, unknown>,
) => unknown;

type DaemonRouterModule = {
  createDaemonRouter: DaemonRouterFactory;
};

type DaemonRouterGate =
  | {
      available: true;
      module: DaemonRouterModule;
    }
  | {
      available: false;
      reason: string;
    };

type StartedDaemonServer = {
  url: string;
  ui: BuiltUiArtifacts;
  getState: () => DaemonState;
  events: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const daemonRouterModuleUrl = pathToFileURL(
  join(repoRoot, "packages/server/daemon-router.ts"),
).href;
const bunExecutable = Bun.which("bun") ?? "bun";
const tempDirs: string[] = [];
let builtUiPromise: Promise<BuiltUiArtifacts> | undefined;
const ROUTER_CASE_TIMEOUT_MS = 120_000;

const planDocument: DocumentSnapshot = {
  id: "nim-15-plan-doc",
  mode: "plan",
  origin: "claude-code",
  content: "# Multiplex Router Plan\n\n1. Route by active mode.\n2. Remove shutdown endpoint.\n",
};

const reviewDocument: DocumentSnapshot = {
  id: "nim-15-review-doc",
  mode: "review",
  origin: "opencode",
  gitRef: "HEAD",
  content: [
    "diff --git a/src/router.ts b/src/router.ts",
    "--- a/src/router.ts",
    "+++ b/src/router.ts",
    "@@ -1,3 +1,3 @@",
    "-export const router = legacyRouter;",
    "+export const router = daemonRouter;",
  ].join("\n"),
};

const annotateDocument: DocumentSnapshot = {
  id: "nim-15-annotate-doc",
  mode: "annotate",
  origin: "claude-code",
  filePath: "/tmp/plannotator-nim-15-notes.md",
  content: "# Router Notes\n\nConfirm annotate mode reuses the plan editor bundle.\n",
};

const planApproval: FeedbackPayload = {
  approved: true,
  feedback: "Approved after router review.",
  annotations: [{ blockId: "plan-1", type: "COMMENT" }],
  permissionMode: "acceptEdits",
};

const reviewFeedback: FeedbackPayload = {
  approved: false,
  feedback: "The review bundle must stay isolated from plan mode routes.",
  annotations: [{ filePath: "src/router.ts", startLine: 1, type: "COMMENT" }],
  agentSwitch: "build",
};

function readRootFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function createDisposableWorkspace(): string {
  const baseDir = mkdtempSync(join(tmpdir(), "plannotator-nim15-"));
  const workspaceRoot = join(baseDir, "workspace");
  tempDirs.push(baseDir);

  cpSync(repoRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (!rel) {
        return true;
      }

      const topLevel = rel.split("/")[0];
      return topLevel !== ".git" && topLevel !== "node_modules";
    },
  });

  const sourceNodeModules = join(repoRoot, "node_modules");
  if (!existsSync(sourceNodeModules)) {
    throw new Error(
      "Missing local workspace dependencies: run bun install before executing the NIM-15 proof.",
    );
  }

  symlinkSync(sourceNodeModules, join(workspaceRoot, "node_modules"), "dir");
  return workspaceRoot;
}

async function runBunScript(cwd: string, script: string): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [bunExecutable, "run", script],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  return { script, exitCode, stdout, stderr };
}

function assertCommandSucceeded(result: CommandResult): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `bun run ${result.script} failed with exit code ${result.exitCode}.`,
      "",
      "--- stdout ---",
      result.stdout,
      "",
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  );
}

async function ensureBuiltUiArtifacts(): Promise<BuiltUiArtifacts> {
  if (!builtUiPromise) {
    builtUiPromise = (async () => {
      const workspaceRoot = createDisposableWorkspace();
      const reviewBuild = await runBunScript(workspaceRoot, "build:review");
      assertCommandSucceeded(reviewBuild);
      const hookBuild = await runBunScript(workspaceRoot, "build:hook");
      assertCommandSucceeded(hookBuild);

      return {
        planHtml: readRootFile(workspaceRoot, "apps/hook/dist/index.html"),
        reviewHtml: readRootFile(workspaceRoot, "apps/hook/dist/review.html"),
      };
    })();
  }

  return await builtUiPromise;
}

async function probeDaemonRouterModule(): Promise<DaemonRouterGate> {
  let imported: unknown;

  try {
    imported = await import(daemonRouterModuleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: [
        "NIM-15 expects packages/server/daemon-router.ts to exist and export createDaemonRouter(state, eventBus).",
        `Import failed: ${message}`,
      ].join("\n"),
    };
  }

  const candidate = imported as Partial<DaemonRouterModule>;
  if (typeof candidate.createDaemonRouter !== "function") {
    return {
      available: false,
      reason:
        "packages/server/daemon-router.ts must export createDaemonRouter(state, eventBus).",
    };
  }

  return {
    available: true,
    module: candidate as DaemonRouterModule,
  };
}

const daemonRouterGate = await probeDaemonRouterModule();

function createRouterStateHarness(initialState: DaemonState, ui: BuiltUiArtifacts) {
  let currentState = structuredClone(initialState);

  const writeState = (nextState: DaemonState) => {
    currentState = structuredClone(nextState);
  };

  return {
    getState: () => structuredClone(currentState),
    saveState: (nextState: DaemonState) => writeState(nextState),
    setState: (nextState: DaemonState) => writeState(nextState),
    updateState: (nextState: DaemonState) => writeState(nextState),
    loadState: () => structuredClone(currentState),
    readState: () => structuredClone(currentState),
    planHtml: ui.planHtml,
    reviewHtml: ui.reviewHtml,
    assets: {
      planHtml: ui.planHtml,
      reviewHtml: ui.reviewHtml,
    },
    ui,
  };
}

function createEventBusHarness() {
  const events: Array<Record<string, unknown>> = [];
  const record = (event: unknown) => {
    if (event && typeof event === "object" && !Array.isArray(event)) {
      events.push(structuredClone(event as Record<string, unknown>));
      return;
    }

    events.push({ value: event });
  };

  return {
    events,
    eventBus: {
      emit: record,
      dispatch: record,
      publish: record,
    },
  };
}

function resolveFetchHandler(candidate: unknown): (req: Request) => Response | Promise<Response> {
  if (typeof candidate === "function") {
    return candidate as (req: Request) => Response | Promise<Response>;
  }

  if (
    candidate &&
    typeof candidate === "object" &&
    "fetch" in candidate &&
    typeof candidate.fetch === "function"
  ) {
    return candidate.fetch.bind(candidate) as (req: Request) => Response | Promise<Response>;
  }

  throw new Error(
    "createDaemonRouter() must return a fetch handler function or an object with a fetch() method.",
  );
}

async function startDaemonServer(initialState: DaemonState): Promise<StartedDaemonServer> {
  if (!daemonRouterGate.available) {
    throw new Error(daemonRouterGate.reason);
  }

  const ui = await ensureBuiltUiArtifacts();
  const stateHarness = createRouterStateHarness(initialState, ui);
  const eventBusHarness = createEventBusHarness();
  const fetchHandler = resolveFetchHandler(
    daemonRouterGate.module.createDaemonRouter(
      stateHarness as unknown as Record<string, unknown>,
      eventBusHarness.eventBus as unknown as Record<string, unknown>,
    ),
  );

  const server = Bun.serve({
    port: 0,
    fetch: fetchHandler,
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    ui,
    getState: () => stateHarness.getState(),
    events: eventBusHarness.events,
    stop: async () => {
      await server.stop(true);
    },
  };
}

async function fetchText(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { response, text: await response.text() };
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    response,
    text,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("NIM-15 multiplexed router proof", () => {
  test("defines packages/server/daemon-router.ts#createDaemonRouter for daemon-owned fetch routing", () => {
    if (!daemonRouterGate.available) {
      throw new Error(daemonRouterGate.reason);
    }
  });

  if (!daemonRouterGate.available) {
    return;
  }

  test("serves the plan bundle at /, returns /api/plan, and 409s review-only routes when active mode is plan", async () => {
    const initialState: DaemonState = {
      schemaVersion: 1,
      status: "awaiting-response",
      document: planDocument,
      feedback: null,
    };

    const server = await startDaemonServer(initialState);

    try {
      const root = await fetchText(`${server.url}/`);
      expect(root.response.status).toBe(200);
      expect(root.text).toBe(server.ui.planHtml);

      const plan = await fetchJson(`${server.url}/api/plan`);
      expect(plan.response.status).toBe(200);
      expect(plan.json).toMatchObject({
        plan: planDocument.content,
        origin: planDocument.origin,
      });

      const diff = await fetchText(`${server.url}/api/diff`);
      expect(diff.response.status).toBe(409);
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);

  test("serves the review bundle at /, returns /api/diff, and 409s plan-only routes when active mode is review", async () => {
    const initialState: DaemonState = {
      schemaVersion: 1,
      status: "awaiting-response",
      document: reviewDocument,
      feedback: null,
    };

    const server = await startDaemonServer(initialState);

    try {
      const root = await fetchText(`${server.url}/`);
      expect(root.response.status).toBe(200);
      expect(root.text).toBe(server.ui.reviewHtml);

      const diff = await fetchJson(`${server.url}/api/diff`);
      expect(diff.response.status).toBe(200);
      expect(diff.json).toMatchObject({
        rawPatch: reviewDocument.content,
        gitRef: reviewDocument.gitRef,
        origin: reviewDocument.origin,
      });

      const plan = await fetchText(`${server.url}/api/plan`);
      expect(plan.response.status).toBe(409);
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);

  test("reuses the plan bundle for annotate mode and returns annotate-flavored /api/plan", async () => {
    const initialState: DaemonState = {
      schemaVersion: 1,
      status: "awaiting-response",
      document: annotateDocument,
      feedback: null,
    };

    const server = await startDaemonServer(initialState);

    try {
      const root = await fetchText(`${server.url}/`);
      expect(root.response.status).toBe(200);
      expect(root.text).toBe(server.ui.planHtml);

      const plan = await fetchJson(`${server.url}/api/plan`);
      expect(plan.response.status).toBe(200);
      expect(plan.json).toMatchObject({
        plan: annotateDocument.content,
        origin: annotateDocument.origin,
        mode: "annotate",
        filePath: annotateDocument.filePath,
      });

      const diff = await fetchText(`${server.url}/api/diff`);
      expect(diff.response.status).toBe(409);
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);

  test("plan approvals update daemon state without relying on /api/shutdown", async () => {
    const initialState: DaemonState = {
      schemaVersion: 1,
      status: "awaiting-response",
      document: planDocument,
      feedback: null,
    };

    const server = await startDaemonServer(initialState);

    try {
      const shutdown = await fetchText(`${server.url}/api/shutdown`, {
        method: "POST",
      });
      expect(shutdown.response.status).toBeGreaterThanOrEqual(400);

      const approve = await fetchJson(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedback: planApproval.feedback,
          annotations: planApproval.annotations,
          permissionMode: planApproval.permissionMode,
        }),
      });
      expect(approve.response.status).toBe(200);
      expect(server.getState()).toEqual(
        transition(initialState, {
          type: "resolve",
          feedback: planApproval,
        }),
      );

      const root = await fetchText(`${server.url}/`);
      expect(root.response.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);

  test("review feedback updates daemon state without tearing the server down", async () => {
    const initialState: DaemonState = {
      schemaVersion: 1,
      status: "awaiting-response",
      document: reviewDocument,
      feedback: null,
    };

    const server = await startDaemonServer(initialState);

    try {
      const feedback = await fetchJson(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approved: reviewFeedback.approved,
          feedback: reviewFeedback.feedback,
          annotations: reviewFeedback.annotations,
          agentSwitch: reviewFeedback.agentSwitch,
        }),
      });
      expect(feedback.response.status).toBe(200);
      expect(server.getState()).toEqual(
        transition(initialState, {
          type: "resolve",
          feedback: reviewFeedback,
        }),
      );

      const root = await fetchText(`${server.url}/`);
      expect(root.response.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);
});
