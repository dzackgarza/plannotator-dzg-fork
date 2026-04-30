import {
  transition,
  type DaemonState,
  type DocMode,
  type FeedbackPayload,
} from "./state";

type JsonObject = Record<string, unknown>;

type RouterFallback = (
  req: Request,
  url: URL,
  currentState: DaemonState,
) => Response | Promise<Response | undefined> | undefined;

type TransitionHookArgs = {
  body: JsonObject;
  currentState: DaemonState;
  feedback: FeedbackPayload;
  nextState: DaemonState;
  request: Request;
};

type ResetHookArgs = {
  currentState: DaemonState;
  request: Request;
};

export type DaemonRouterEvent = {
  type: "resolved";
  feedback: FeedbackPayload;
  state: DaemonState;
};

export interface DaemonRouterState {
  annotateResponse?: JsonObject;
  getAnnotateResponse?: () => JsonObject;
  getPlanResponse?: () => JsonObject;
  getReviewResponse?: () => JsonObject;
  getState?: () => DaemonState;
  handleFallback?: RouterFallback;
  loadState?: () => DaemonState;
  onApprove?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onCancel?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onDeny?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onFeedback?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onReset?: (args: ResetHookArgs) => JsonObject | void | Promise<JsonObject | void>;
  planHtml?: string;
  planResponse?: JsonObject;
  readState?: () => DaemonState;
  reviewHtml?: string;
  reviewResponse?: JsonObject;
  saveState?: (state: DaemonState) => void;
  setState?: (state: DaemonState) => void;
  ui?: {
    planHtml?: string;
    reviewHtml?: string;
  };
  updateState?: (state: DaemonState) => void;
}

export interface DaemonRouterEventBus {
  dispatch?: (event: DaemonRouterEvent) => void;
  emit?: (event: DaemonRouterEvent) => void;
  publish?: (event: DaemonRouterEvent) => void;
}

function getBundleHtml(
  stateAdapter: DaemonRouterState,
  mode: DocMode,
): string | undefined {
  if (mode === "review") {
    return stateAdapter.reviewHtml ?? stateAdapter.ui?.reviewHtml;
  }

  return stateAdapter.planHtml ?? stateAdapter.ui?.planHtml;
}

function readDaemonState(stateAdapter: DaemonRouterState): DaemonState {
  const reader =
    stateAdapter.getState ??
    stateAdapter.readState ??
    stateAdapter.loadState;

  if (!reader) {
    throw new Error(
      "createDaemonRouter requires a state adapter with getState(), readState(), or loadState().",
    );
  }

  return reader();
}

function writeDaemonState(
  stateAdapter: DaemonRouterState,
  nextState: DaemonState,
): void {
  const writer =
    stateAdapter.setState ??
    stateAdapter.updateState ??
    stateAdapter.saveState;

  if (!writer) {
    throw new Error(
      "createDaemonRouter requires a state adapter with setState(), updateState(), or saveState().",
    );
  }

  writer(nextState);
}

function publishDaemonEvent(
  eventBus: DaemonRouterEventBus,
  event: DaemonRouterEvent,
): void {
  const publisher = eventBus.emit ?? eventBus.dispatch ?? eventBus.publish;
  if (!publisher) {
    throw new Error(
      "createDaemonRouter requires an event bus with emit(), dispatch(), or publish().",
    );
  }

  publisher(event);
}

function getCurrentMode(currentState: DaemonState): DocMode | null {
  return currentState.document?.mode ?? null;
}

function requireMode(
  currentState: DaemonState,
  expectedModes: DocMode[],
): Response | null {
  const currentMode = getCurrentMode(currentState);

  if (currentMode && expectedModes.includes(currentMode)) {
    return null;
  }

  const expected = expectedModes.join(" or ");
  const actual = currentMode ?? "none";

  return Response.json(
    { error: `Active mode ${actual} does not support this route. Expected ${expected}.` },
    { status: 409 },
  );
}

function getPlanPayload(stateAdapter: DaemonRouterState): JsonObject {
  return stateAdapter.getPlanResponse?.() ?? stateAdapter.planResponse ?? {};
}

function getAnnotatePayload(stateAdapter: DaemonRouterState): JsonObject {
  return (
    stateAdapter.getAnnotateResponse?.() ??
    stateAdapter.annotateResponse ??
    {}
  );
}

function getReviewPayload(stateAdapter: DaemonRouterState): JsonObject {
  return stateAdapter.getReviewResponse?.() ?? stateAdapter.reviewResponse ?? {};
}

function getRequiredDocument(currentState: DaemonState) {
  if (!currentState.document) {
    throw new Error("Daemon router requires an active document.");
  }

  return currentState.document;
}

async function readJsonBody(req: Request): Promise<JsonObject> {
  const body = await req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as JsonObject;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toAnnotations(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function resolveTransition(
  currentState: DaemonState,
  feedback: FeedbackPayload,
): DaemonState | Response {
  try {
    return transition(currentState, {
      type: "resolve",
      feedback,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 409 });
  }
}

async function applyResolution(
  stateAdapter: DaemonRouterState,
  eventBus: DaemonRouterEventBus,
  hook:
    | DaemonRouterState["onApprove"]
    | DaemonRouterState["onDeny"]
    | DaemonRouterState["onFeedback"]
    | DaemonRouterState["onCancel"],
  request: Request,
  body: JsonObject,
  feedback: FeedbackPayload,
): Promise<Response> {
  const currentState = readDaemonState(stateAdapter);
  const nextState = resolveTransition(currentState, feedback);
  if (nextState instanceof Response) {
    return nextState;
  }

  const responsePayload =
    (await hook?.({
      body,
      currentState,
      feedback,
      nextState,
      request,
    })) ?? {};

  writeDaemonState(stateAdapter, nextState);
  publishDaemonEvent(eventBus, {
    type: "resolved",
    feedback,
    state: nextState,
  });

  return Response.json({ ok: true, ...responsePayload });
}

function serveActiveBundle(
  stateAdapter: DaemonRouterState,
  currentState: DaemonState,
): Response {
  const currentMode = getCurrentMode(currentState);
  if (!currentMode) {
    return Response.json(
      { error: "No active document is available." },
      { status: 409 },
    );
  }

  const html = getBundleHtml(stateAdapter, currentMode);
  if (html === undefined) {
    throw new Error(`Missing UI bundle for daemon mode ${currentMode}`);
  }

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

export function createDaemonRouter(
  stateAdapter: DaemonRouterState,
  eventBus: DaemonRouterEventBus,
) {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const currentState = readDaemonState(stateAdapter);

      if (url.pathname === "/") {
        return serveActiveBundle(stateAdapter, currentState);
      }

      if (url.pathname === "/api/plan" && req.method === "GET") {
        const modeMismatch = requireMode(currentState, ["plan", "annotate"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const document = getRequiredDocument(currentState);
        if (document.mode === "annotate") {
          return Response.json({
            plan: document.content,
            origin: document.origin,
            mode: "annotate",
            filePath: document.filePath,
            ...getAnnotatePayload(stateAdapter),
          });
        }

        return Response.json({
          plan: document.content,
          origin: document.origin,
          ...getPlanPayload(stateAdapter),
        });
      }

      if (url.pathname === "/api/diff" && req.method === "GET") {
        const modeMismatch = requireMode(currentState, ["review"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const document = getRequiredDocument(currentState);
        return Response.json({
          rawPatch: document.content,
          gitRef: document.gitRef,
          origin: document.origin,
          ...getReviewPayload(stateAdapter),
        });
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["plan"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const body = await readJsonBody(req).catch(() => ({}));
        const feedback: FeedbackPayload = {
          approved: true,
          feedback: toStringValue(body.feedback) ?? "",
          annotations: toAnnotations(body.annotations),
          agentSwitch: toStringValue(body.agentSwitch),
          permissionMode: toStringValue(body.permissionMode),
        };

        return applyResolution(
          stateAdapter,
          eventBus,
          stateAdapter.onApprove,
          req,
          body,
          feedback,
        );
      }

      if (url.pathname === "/api/deny" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["plan"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const body = await readJsonBody(req).catch(() => ({}));
        const feedback: FeedbackPayload = {
          approved: false,
          feedback: toStringValue(body.feedback) ?? "Plan rejected by user",
          annotations: [],
        };

        return applyResolution(
          stateAdapter,
          eventBus,
          stateAdapter.onDeny,
          req,
          body,
          feedback,
        );
      }

      if (url.pathname === "/api/feedback" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["review", "annotate"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        try {
          const body = await readJsonBody(req);
          const feedback: FeedbackPayload = {
            approved:
              currentState.document?.mode === "review"
                ? Boolean(body.approved)
                : false,
            feedback: toStringValue(body.feedback) ?? "",
            annotations: toAnnotations(body.annotations),
            agentSwitch: toStringValue(body.agentSwitch),
          };

          return applyResolution(
            stateAdapter,
            eventBus,
            stateAdapter.onFeedback,
            req,
            body,
            feedback,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to process feedback";
          return Response.json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/cancel" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["plan", "review", "annotate"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const feedback: FeedbackPayload = {
          approved: false,
          feedback: "Review cancelled by user.",
          annotations: [],
          cancelled: true,
        };

        return applyResolution(
          stateAdapter,
          eventBus,
          stateAdapter.onCancel,
          req,
          {},
          feedback,
        );
      }

      if (url.pathname === "/api/reset" && req.method === "POST") {
        await stateAdapter.onReset?.({
          currentState,
          request: req,
        });

        return Response.json({ ok: true });
      }

      const fallbackResponse = await stateAdapter.handleFallback?.(
        req,
        url,
        currentState,
      );
      if (fallbackResponse) {
        return fallbackResponse;
      }

      if (url.pathname.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      return serveActiveBundle(stateAdapter, currentState);
    },
  };
}
