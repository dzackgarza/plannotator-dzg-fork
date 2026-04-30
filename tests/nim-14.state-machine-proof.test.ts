import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type DocMode = "plan" | "review" | "annotate";

type DocumentSnapshot = {
  id: string;
  mode: DocMode;
  origin: "claude-code" | "opencode";
  content: string;
  filePath?: string;
  gitRef?: string;
};

type FeedbackPayload = {
  approved: boolean;
  feedback: string;
  annotations: Array<Record<string, unknown>>;
  agentSwitch?: string;
  permissionMode?: string;
  cancelled?: boolean;
};

type DaemonState = {
  schemaVersion: 1;
  status: "idle" | "awaiting-response" | "resolved";
  document: DocumentSnapshot | null;
  feedback: FeedbackPayload | null;
};

type StateEvent =
  | { type: "submit"; document: DocumentSnapshot }
  | { type: "resolve"; feedback: FeedbackPayload }
  | { type: "clear" };

type StateModule = {
  transition: (current: DaemonState, event: StateEvent) => DaemonState;
  loadState: () => Promise<DaemonState> | DaemonState;
  saveState: (state: DaemonState) => Promise<void> | void;
};

type StateModuleGate =
  | {
      available: true;
      module: StateModule;
    }
  | {
      available: false;
      reason: string;
    };

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const stateModuleUrl = pathToFileURL(join(repoRoot, "packages/server/state.ts")).href;
const bunExecutable = Bun.which("bun") ?? "bun";
const tempDirs: string[] = [];

const idleState: DaemonState = {
  schemaVersion: 1,
  status: "idle",
  document: null,
  feedback: null,
};

const planDocument: DocumentSnapshot = {
  id: "plan-session-1",
  mode: "plan",
  origin: "opencode",
  content: "# Refactor Plan\n\n1. Remove remote surface\n2. Add daemon state machine\n",
};

const reviewDocument: DocumentSnapshot = {
  id: "review-session-1",
  mode: "review",
  origin: "opencode",
  gitRef: "HEAD",
  content: [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,3 @@",
    "-console.log('old');",
    "+console.log('new');",
  ].join("\n"),
};

const annotateDocument: DocumentSnapshot = {
  id: "annotate-session-1",
  mode: "annotate",
  origin: "claude-code",
  filePath: "/tmp/plannotator/design-notes.md",
  content: "# Notes\n\nPlease tighten the introduction.\n",
};

const approvedPlanFeedback: FeedbackPayload = {
  approved: true,
  feedback: "Approved with notes about permission mode preservation.",
  annotations: [
    {
      blockId: "plan-1",
      type: "COMMENT",
      text: "Keep the current permission mode in the resolved payload.",
    },
  ],
  agentSwitch: "build",
  permissionMode: "acceptEdits",
};

const deniedReviewFeedback: FeedbackPayload = {
  approved: false,
  feedback: "Please keep the old greeting format.",
  annotations: [
    {
      filePath: "src/app.ts",
      startLine: 1,
      type: "REPLACEMENT",
      text: "Restore the old greeting.",
    },
  ],
  agentSwitch: "build",
};

const cancelledAnnotateFeedback: FeedbackPayload = {
  approved: false,
  feedback: "Review cancelled by user.",
  annotations: [],
  cancelled: true,
};

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-nim14-"));
  mkdirSync(join(dir, ".plannotator"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function stateFilePath(homeDir: string): string {
  return join(homeDir, ".plannotator", "state.json");
}

async function probeStateModule(): Promise<StateModuleGate> {
  let imported: unknown;

  try {
    imported = await import(stateModuleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: [
        "NIM-14 proof expects packages/server/state.ts to exist and export transition(), loadState(), and saveState().",
        `Import failed: ${message}`,
      ].join("\n"),
    };
  }

  const candidate = imported as Partial<StateModule>;

  if (
    typeof candidate.transition !== "function" ||
    typeof candidate.loadState !== "function" ||
    typeof candidate.saveState !== "function"
  ) {
    return {
      available: false,
      reason:
        "packages/server/state.ts must export transition(), loadState(), and saveState().",
    };
  }

  return {
    available: true,
    module: candidate as StateModule,
  };
}

const stateModuleGate = await probeStateModule();

async function runStateProgram(homeDir: string, source: string): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [
      bunExecutable,
      "--eval",
      [
        "(async () => {",
        `  const mod = await import(${JSON.stringify(stateModuleUrl)});`,
        source,
        "})().catch((error) => {",
        "  console.error(error instanceof Error ? error.stack ?? error.message : String(error));",
        "  process.exit(1);",
        "});",
      ].join("\n"),
    ],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function saveStateViaChild(homeDir: string, state: DaemonState): Promise<void> {
  const result = await runStateProgram(
    homeDir,
    `await Promise.resolve(mod.saveState(${JSON.stringify(state)}));`,
  );

  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      "saveState() failed in isolated HOME.",
      "",
      "--- stdout ---",
      result.stdout,
      "",
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  );
}

async function loadStateViaChild(homeDir: string): Promise<DaemonState> {
  const result = await runStateProgram(
    homeDir,
    [
      "const state = await Promise.resolve(mod.loadState());",
      "console.log(JSON.stringify(state));",
    ].join("\n"),
  );

  if (result.exitCode !== 0) {
    throw new Error(
      [
        "loadState() failed in isolated HOME.",
        "",
        "--- stdout ---",
        result.stdout,
        "",
        "--- stderr ---",
        result.stderr,
      ].join("\n"),
    );
  }

  return JSON.parse(result.stdout.trim()) as DaemonState;
}

async function expectChildFailure(
  homeDir: string,
  source: string,
  errorPattern: RegExp,
): Promise<void> {
  const result = await runStateProgram(homeDir, source);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  expect(result.exitCode).not.toBe(0);
  expect(combinedOutput).not.toMatch(/cannot find module|ResolveMessage/i);
  expect(combinedOutput).toMatch(errorPattern);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

describe("NIM-14 daemon state-machine proof", () => {
  if (!stateModuleGate.available) {
    test("requires packages/server/state.ts before the semantic proof cases activate", () => {
      throw new Error(stateModuleGate.reason);
    });
    return;
  }

  const stateModule = stateModuleGate.module;

  test.each([
    {
      name: "plan review submission",
      document: planDocument,
    },
    {
      name: "code review submission",
      document: reviewDocument,
    },
    {
      name: "markdown annotation submission",
      document: annotateDocument,
    },
  ])("accepts idle -> submit for $name", async ({ document }) => {
    const current = deepClone(idleState);
    const before = deepClone(current);

    const next = stateModule.transition(current, { type: "submit", document });

    expect(current).toEqual(before);
    expect(next).toEqual({
      schemaVersion: 1,
      status: "awaiting-response",
      document,
      feedback: null,
    });
  });

  test.each([
    {
      name: "plan approve-with-notes resolution",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: planDocument,
        feedback: null,
      } satisfies DaemonState,
      feedback: approvedPlanFeedback,
    },
    {
      name: "review change-request resolution",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: reviewDocument,
        feedback: null,
      } satisfies DaemonState,
      feedback: deniedReviewFeedback,
    },
    {
      name: "annotate cancellation resolution",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: annotateDocument,
        feedback: null,
      } satisfies DaemonState,
      feedback: cancelledAnnotateFeedback,
    },
  ])("accepts awaiting-response -> resolve for $name", async ({ current, feedback }) => {
    const frozenCurrent = deepClone(current);
    const before = deepClone(frozenCurrent);

    const next = stateModule.transition(frozenCurrent, { type: "resolve", feedback });

    expect(frozenCurrent).toEqual(before);
    expect(next).toEqual({
      schemaVersion: 1,
      status: "resolved",
      document: current.document,
      feedback,
    });
  });

  test("accepts resolved -> clear so later submit/wait flows can reuse the daemon", async () => {
    const current: DaemonState = {
      schemaVersion: 1,
      status: "resolved",
      document: planDocument,
      feedback: approvedPlanFeedback,
    };
    const before = deepClone(current);

    const next = stateModule.transition(current, { type: "clear" });

    expect(current).toEqual(before);
    expect(next).toEqual(idleState);
  });

  test.each([
    {
      name: "idle cannot resolve before any document is submitted",
      current: idleState,
      event: { type: "resolve", feedback: approvedPlanFeedback } satisfies StateEvent,
    },
    {
      name: "idle cannot clear without a resolved result",
      current: idleState,
      event: { type: "clear" } satisfies StateEvent,
    },
    {
      name: "awaiting-response cannot accept a second submit before the first is resolved",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: planDocument,
        feedback: null,
      } satisfies DaemonState,
      event: { type: "submit", document: reviewDocument } satisfies StateEvent,
    },
    {
      name: "awaiting-response cannot clear before a result exists",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: reviewDocument,
        feedback: null,
      } satisfies DaemonState,
      event: { type: "clear" } satisfies StateEvent,
    },
    {
      name: "resolved cannot be overwritten by a new submit before clear",
      current: {
        schemaVersion: 1,
        status: "resolved",
        document: reviewDocument,
        feedback: deniedReviewFeedback,
      } satisfies DaemonState,
      event: { type: "submit", document: annotateDocument } satisfies StateEvent,
    },
    {
      name: "resolved cannot accept a second result after the first has been persisted",
      current: {
        schemaVersion: 1,
        status: "resolved",
        document: annotateDocument,
        feedback: cancelledAnnotateFeedback,
      } satisfies DaemonState,
      event: { type: "resolve", feedback: approvedPlanFeedback } satisfies StateEvent,
    },
  ])("rejects illegal transitions: $name", async ({ current, event }) => {
    const frozenCurrent = deepClone(current);
    const before = deepClone(frozenCurrent);

    expect(() => stateModule.transition(frozenCurrent, event)).toThrow(
      /illegal|invalid|conflict|state/i,
    );
    expect(frozenCurrent).toEqual(before);
  });

  test("loads an explicit idle snapshot when no persisted daemon state exists yet", async () => {
    const homeDir = createTempHome();

    const loaded = await loadStateViaChild(homeDir);

    expect(loaded).toEqual(idleState);
  });

  test("persists an awaiting-response review snapshot across fresh processes", async () => {
    const homeDir = createTempHome();
    const awaitingReviewState: DaemonState = {
      schemaVersion: 1,
      status: "awaiting-response",
      document: reviewDocument,
      feedback: null,
    };

    await saveStateViaChild(homeDir, awaitingReviewState);

    expect(existsSync(stateFilePath(homeDir))).toBe(true);
    expect(JSON.parse(readFileSync(stateFilePath(homeDir), "utf8"))).toEqual(
      awaitingReviewState,
    );
    expect(await loadStateViaChild(homeDir)).toEqual(awaitingReviewState);
  });

  test("persists a resolved plan result until an explicit clear happens later", async () => {
    const homeDir = createTempHome();
    const resolvedPlanState: DaemonState = {
      schemaVersion: 1,
      status: "resolved",
      document: planDocument,
      feedback: approvedPlanFeedback,
    };

    await saveStateViaChild(homeDir, resolvedPlanState);

    expect(await loadStateViaChild(homeDir)).toEqual(resolvedPlanState);
  });

  test("ignores stray temp siblings and loads the last committed state.json snapshot", async () => {
    const homeDir = createTempHome();
    const committedState: DaemonState = {
      schemaVersion: 1,
      status: "resolved",
      document: annotateDocument,
      feedback: cancelledAnnotateFeedback,
    };

    await saveStateViaChild(homeDir, committedState);
    writeFileSync(
      `${stateFilePath(homeDir)}.tmp`,
      JSON.stringify({
        schemaVersion: 1,
        status: "resolved",
        document: reviewDocument,
        feedback: deniedReviewFeedback,
      }),
      "utf8",
    );

    expect(await loadStateViaChild(homeDir)).toEqual(committedState);
  });

  test("rejects corrupt JSON instead of inventing fallback state", async () => {
    const homeDir = createTempHome();
    const statePath = stateFilePath(homeDir);

    writeFileSync(statePath, '{"schemaVersion":1,"status":"awaiting-response"', "utf8");

    await expectChildFailure(
      homeDir,
      "await Promise.resolve(mod.loadState());",
      /json|parse|state/i,
    );
  });

  test("rejects structurally impossible persisted snapshots that would break wait/clear flows", async () => {
    const homeDir = createTempHome();

    writeFileSync(
      stateFilePath(homeDir),
      JSON.stringify({
        schemaVersion: 1,
        status: "resolved",
        document: planDocument,
        feedback: null,
      }),
      "utf8",
    );

    await expectChildFailure(
      homeDir,
      "await Promise.resolve(mod.loadState());",
      /invalid|state|feedback/i,
    );
  });

  test("rejects unknown schema versions so recovery is explicit instead of silent", async () => {
    const homeDir = createTempHome();

    writeFileSync(
      stateFilePath(homeDir),
      JSON.stringify({
        schemaVersion: 99,
        status: "idle",
        document: null,
        feedback: null,
      }),
      "utf8",
    );

    await expectChildFailure(
      homeDir,
      "await Promise.resolve(mod.loadState());",
      /schema|version|state/i,
    );
  });
});
