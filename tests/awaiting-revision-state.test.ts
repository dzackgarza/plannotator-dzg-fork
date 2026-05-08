import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDaemonEventBus } from "../packages/server/daemon-events";
import type { DaemonState, DocumentSnapshot, FeedbackPayload } from "../packages/server/state";

const TIMEOUT_MS = 30_000;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const daemonRouterModuleUrl = pathToFileURL(
  join(__dirname, "../packages/server/daemon-router.ts"),
);

type DaemonRouterFactory = (
  state: Record<string, unknown>,
  eventBus: Record<string, unknown>,
) => unknown;

type DaemonRouterModule = {
  createDaemonRouter: DaemonRouterFactory;
};

type StartedDaemonServer = {
  url: string;
  getState: () => DaemonState;
  stop: () => Promise<void>;
};

const idleState: DaemonState = {
  schemaVersion: 1,
  status: "idle",
  document: null,
  feedback: null,
};

const planDocument: DocumentSnapshot = {
  id: "awaiting-revision-test",
  mode: "plan",
  origin: "claude-code",
  content: "# Test Plan\n\nTest awaiting-revision state handling",
};

const deniedFeedback: FeedbackPayload = {
  approved: false,
  feedback: "Please add more detail",
  annotations: [],
  permissionMode: "acceptEdits",
};

function createRouterStateHarness(initialState: DaemonState) {
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
    planHtml: "<html><body>plan</body></html>",
    reviewHtml: "<html><body>review</body></html>",
    ui: {
      planHtml: "<html><body>plan</body></html>",
      reviewHtml: "<html><body>review</body></html>",
    },
  };
}

function resolveFetchHandler(maybeHandler: unknown): (req: Request) => Response | Promise<Response> {
  if (typeof maybeHandler === "function") {
    return maybeHandler as (req: Request) => Response | Promise<Response>;
  }

  if (
    typeof maybeHandler === "object" &&
    maybeHandler !== null &&
    "fetch" in maybeHandler &&
    typeof (maybeHandler as { fetch: unknown }).fetch === "function"
  ) {
    return (maybeHandler as { fetch: (req: Request) => Response | Promise<Response> }).fetch;
  }

  throw new Error(
    "createDaemonRouter() must return a fetch handler function or an object with a fetch() method.",
  );
}

async function startDaemonServer(initialState: DaemonState): Promise<StartedDaemonServer> {
  const daemonRouterModule = (await import(daemonRouterModuleUrl)) as DaemonRouterModule;

  const stateHarness = createRouterStateHarness(initialState);
  const eventBus = createDaemonEventBus();
  const fetchHandler = resolveFetchHandler(
    daemonRouterModule.createDaemonRouter(
      stateHarness as unknown as Record<string, unknown>,
      eventBus as unknown as Record<string, unknown>,
    ),
  );

  const server = Bun.serve({
    port: 0,
    fetch: fetchHandler,
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    getState: () => stateHarness.getState(),
    stop: async () => {
      await server.stop(true);
    },
  };
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Ignore parse errors
  }
  return { response, text, json };
}

describe("Awaiting revision state", () => {
  test("GET /api/plan in awaiting-revision should return feedback-sent response", async () => {
    const server = await startDaemonServer(idleState);

    try {
      // Submit plan
      await fetchJson(`${server.url}/api/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: planDocument }),
      });

      // Deny to transition to awaiting-revision
      await fetchJson(`${server.url}/api/deny`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedback: deniedFeedback.feedback,
          annotations: deniedFeedback.annotations,
        }),
      });

      // Verify state is awaiting-revision
      const state = server.getState();
      expect(state.status).toBe("awaiting-revision");

      // NOW: GET /api/plan should return special response for awaiting-revision
      // This should tell the user:
      // - Feedback was already sent
      // - What document is being revised
      // - What feedback was given
      // - Cannot take further action until agent resubmits
      const planResponse = await fetchJson(`${server.url}/api/plan`);

      expect(planResponse.response.status).toBe(200);
      expect(planResponse.json).toBeTruthy();

      const data = planResponse.json as Record<string, unknown>;

      // Should indicate awaiting revision state
      expect(data.status).toBe("awaiting-revision");

      // Should include the document being revised
      expect(data.document).toBeTruthy();
      const doc = data.document as Record<string, unknown>;
      expect(doc.id).toBe(planDocument.id);
      expect(doc.content).toBe(planDocument.content);

      // Should include the feedback that was sent
      expect(data.feedback).toBeTruthy();
      const feedback = data.feedback as Record<string, unknown>;
      expect(feedback.approved).toBe(false);
      expect(feedback.feedback).toBe(deniedFeedback.feedback);

      // Should have a clear message about the state
      expect(data.message || data.error).toMatch(
        /feedback.*sent|awaiting.*revision|waiting.*agent/i,
      );
    } finally {
      await server.stop();
    }
  }, TIMEOUT_MS);
});
