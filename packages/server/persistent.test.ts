import { afterEach, describe, expect, test } from "bun:test";
import { startPersistentServer, type PersistentServerHandle } from "./persistent";

const servers: PersistentServerHandle[] = [];

// Remove SIGINT/SIGTERM handlers added by startPersistentServer between tests
// to avoid "too many listeners" warnings.
const listenerCleanup: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
  for (const cleanup of listenerCleanup.splice(0)) {
    cleanup();
  }
});

function makeServer(): PersistentServerHandle {
  const server = startPersistentServer({
    planHtml: "<html>plan</html>",
    reviewHtml: "<html>review</html>",
    port: 0, // random available port
  });
  servers.push(server);
  return server;
}

async function get(server: PersistentServerHandle, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`);
}

async function post(
  server: PersistentServerHandle,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("startPersistentServer", () => {
  test("starts in idle phase — /api/health returns { phase: 'idle' }", async () => {
    const server = makeServer();
    const resp = await get(server, "/api/health");
    expect(resp.ok).toBe(true);
    const data = await resp.json() as { phase: string };
    expect(data.phase).toBe("idle");
  });

  test("/api/plan returns { phase: 'idle' } (200) when idle", async () => {
    const server = makeServer();
    const resp = await get(server, "/api/plan");
    expect(resp.status).toBe(200);
    const data = await resp.json() as { phase: string };
    expect(data.phase).toBe("idle");
  });

  test("/api/wait returns 404 when idle", async () => {
    const server = makeServer();
    const resp = await get(server, "/api/wait");
    expect(resp.status).toBe(404);
  });

  test("POST /api/session transitions to annotating phase", async () => {
    const server = makeServer();

    const sessionResp = await post(server, "/api/session", {
      type: "annotate",
      data: {
        markdown: "# Hello\n\nThis is a test.",
        filePath: "/tmp/test.md",
        origin: "test",
      },
    });
    expect(sessionResp.ok).toBe(true);
    const sessionData = await sessionResp.json() as { ok: boolean; url: string; port: number };
    expect(sessionData.ok).toBe(true);
    expect(typeof sessionData.url).toBe("string");
    expect(typeof sessionData.port).toBe("number");

    // Health should now show annotating
    const health = await get(server, "/api/health");
    const healthData = await health.json() as { phase: string; type: string };
    expect(healthData.phase).toBe("annotating");
    expect(healthData.type).toBe("annotate");
  });

  test("POST /api/session while annotating returns 409 with error and URL", async () => {
    const server = makeServer();

    await post(server, "/api/session", {
      type: "annotate",
      data: {
        markdown: "# First annotation",
        filePath: "/tmp/test.md",
        origin: "test",
      },
    });

    const conflictResp = await post(server, "/api/session", {
      type: "annotate",
      data: {
        markdown: "# Second annotation",
        filePath: "/tmp/test2.md",
        origin: "test",
      },
    });

    expect(conflictResp.status).toBe(409);
    const conflictData = await conflictResp.json() as { error: string; url: string };
    expect(conflictData.error).toContain("already in progress");
    expect(typeof conflictData.url).toBe("string");
    expect(conflictData.url).toMatch(/^http:\/\//);
  });

  test("POST /api/cancel transitions back to idle", async () => {
    const server = makeServer();

    await post(server, "/api/session", {
      type: "annotate",
      data: {
        markdown: "# Test",
        filePath: "/tmp/test.md",
        origin: "test",
      },
    });

    // Start wait in background — should resolve once cancel fires
    const waitPromise = get(server, "/api/wait").then((r) => r.json());

    const cancelResp = await post(server, "/api/cancel", {});
    expect(cancelResp.ok).toBe(true);

    // Wait should now resolve with cancelled decision
    const decision = await waitPromise as { cancelled: boolean; feedback: string };
    expect(decision.cancelled).toBe(true);
    expect(decision.feedback).toContain("cancelled");

    // Server should be idle again
    const health = await get(server, "/api/health");
    const healthData = await health.json() as { phase: string };
    expect(healthData.phase).toBe("idle");
  });

  test("POST /api/feedback finalizes annotate session and returns to idle", async () => {
    const server = makeServer();

    await post(server, "/api/session", {
      type: "annotate",
      data: {
        markdown: "# Test",
        filePath: "/tmp/test.md",
        origin: "test",
      },
    });

    const waitPromise = get(server, "/api/wait").then((r) => r.json());

    const feedbackResp = await post(server, "/api/feedback", {
      feedback: "This is great, fix section 2.",
      annotations: [],
    });
    expect(feedbackResp.ok).toBe(true);

    const decision = await waitPromise as { feedback: string; annotations: unknown[] };
    expect(decision.feedback).toBe("This is great, fix section 2.");
    expect(Array.isArray(decision.annotations)).toBe(true);

    const health = await get(server, "/api/health");
    const healthData = await health.json() as { phase: string };
    expect(healthData.phase).toBe("idle");
  });

  test("second session succeeds after first is cancelled", async () => {
    const server = makeServer();

    // First session
    await post(server, "/api/session", {
      type: "annotate",
      data: { markdown: "# First", filePath: "/tmp/first.md", origin: "test" },
    });
    await post(server, "/api/cancel", {});

    // Second session should now be accepted (not 409)
    const secondResp = await post(server, "/api/session", {
      type: "annotate",
      data: { markdown: "# Second", filePath: "/tmp/second.md", origin: "test" },
    });
    expect(secondResp.ok).toBe(true);
    expect(secondResp.status).toBe(200);
  });

  test("plan session: /api/plan returns plan data", async () => {
    const server = makeServer();

    await post(server, "/api/session", {
      type: "plan",
      data: {
        plan: "## Step 1\n\nDo the thing.",
        origin: "test",
        sharingEnabled: false,
      },
    });

    const resp = await get(server, "/api/plan");
    expect(resp.ok).toBe(true);
    const data = await resp.json() as { plan: string; origin: string };
    expect(data.plan).toBe("## Step 1\n\nDo the thing.");
    expect(data.origin).toBe("test");
  });

  test("review session: /api/diff returns diff data", async () => {
    const server = makeServer();

    await post(server, "/api/session", {
      type: "review",
      data: {
        rawPatch: "diff --git a/x.ts b/x.ts\n+added line",
        gitRef: "abc123",
        diffType: "uncommitted",
        origin: "test",
        sharingEnabled: false,
      },
    });

    const resp = await get(server, "/api/diff");
    expect(resp.ok).toBe(true);
    const data = await resp.json() as { rawPatch: string; diffType: string };
    expect(data.rawPatch).toBe("diff --git a/x.ts b/x.ts\n+added line");
    expect(data.diffType).toBe("uncommitted");
  });

  test("session response does not include sessionId", async () => {
    const server = makeServer();

    const resp = await post(server, "/api/session", {
      type: "annotate",
      data: { markdown: "# Hi", filePath: "/tmp/x.md", origin: "test" },
    });
    expect(resp.ok).toBe(true);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.sessionId).toBeUndefined();
    expect(data.id).toBeUndefined();
  });
});
