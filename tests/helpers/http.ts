export type ApprovePlanBody = {
  feedback?: string;
  annotations?: ReadonlyArray<Record<string, unknown>>;
  permissionMode?: string;
  planSave?: { enabled: boolean; path?: string };
  agentSwitch?: string;
  obsidian?: Record<string, unknown>;
  bear?: Record<string, unknown>;
};

export type DenyPlanBody = {
  feedback: string;
  annotations?: ReadonlyArray<Record<string, unknown>>;
  planSave?: { enabled: boolean; path?: string };
};

export type ReviewFeedbackBody = {
  feedback: string;
  annotations?: ReadonlyArray<Record<string, unknown>>;
  agentSwitch?: string;
};

export async function postPlanApproval(
  url: string,
  body: ApprovePlanBody = {},
): Promise<Response> {
  return await fetch(`${url}/api/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback: "",
      annotations: [],
      permissionMode: "acceptEdits",
      planSave: { enabled: false },
      ...body,
    }),
  });
}

export async function postPlanDenial(
  url: string,
  body: DenyPlanBody,
): Promise<Response> {
  return await fetch(`${url}/api/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      annotations: [],
      planSave: { enabled: false },
      ...body,
    }),
  });
}

export async function postReviewFeedback(
  url: string,
  body: ReviewFeedbackBody,
): Promise<Response> {
  return await fetch(`${url}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      annotations: [],
      ...body,
    }),
  });
}

export async function getPlan(url: string): Promise<Response> {
  return await fetch(`${url}/api/plan`);
}

export async function getDiff(url: string): Promise<Response> {
  return await fetch(`${url}/api/diff`);
}
