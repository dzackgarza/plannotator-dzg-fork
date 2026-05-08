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
  id: "clear-race-test",
  mode: "plan",
  origin: "claude-code",
  content: "# Clear Race Test\n\nTesting clear race condition",
};

const deniedFeedback: FeedbackPayload = {
  approved: false,
  feedback: "Please revise.",
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
  return { response, text };
}

describe("Clear race condition", () => {
  test("clear should synchronously update state (no race condition)", async () => {
    const server = await startDaemonServer(idleState);

    try {
      // Submit plan
      const submitResponse = await fetchJson(`${server.url}/api/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: planDocument }),
      });

      if (submitResponse.response.status !== 200 && submitResponse.response.status !== 202) {
        console.error("Submit failed:", submitResponse.text);
      }
      expect([200, 202]).toContain(submitResponse.response.status);

      // Verify transition to awaiting-response
      let state = server.getState();
      expect(state.status).toBe("awaiting-response");

      // Deny to get to awaiting-revision
      await fetchJson(`${server.url}/api/deny`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedback: deniedFeedback.feedback,
          annotations: deniedFeedback.annotations,
        }),
      });

      // Verify deny transitioned to awaiting-revision
      state = server.getState();
      expect(state.status).toBe("awaiting-revision");

      // Clear
      const clearResponse = await fetchJson(`${server.url}/api/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(clearResponse.response.status).toBe(200);

      // CRITICAL: State should be idle IMMEDIATELY after clear returns
      // If there's a race condition, this will fail
      state = server.getState();
      expect(state.status).toBe("idle");
      expect(state.document).toBe(null);
      expect(state.feedback).toBe(null);
    } finally {
      await server.stop();
    }
  }, TIMEOUT_MS);
});
