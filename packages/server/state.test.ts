import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IDLE_STATE, loadState, saveState, transition, type DaemonState, type DocumentSnapshot, type FeedbackPayload, type StateEvent } from "./state";

const tempDirs: string[] = [];
const stateModuleUrl = pathToFileURL(join(import.meta.dir, "state.ts")).href;
const bunExecutable = Bun.which("bun") ?? "bun";

const planDocument: DocumentSnapshot = {
  id: "plan-doc",
  mode: "plan",
  origin: "opencode",
  content: "# Plan\n\n1. Keep the proof\n",
};

const reviewDocument: DocumentSnapshot = {
  id: "review-doc",
  mode: "review",
  origin: "claude-code",
  gitRef: "HEAD",
  content: "diff --git a/file.ts b/file.ts",
};

const annotateDocument: DocumentSnapshot = {
  id: "annotate-doc",
  mode: "annotate",
  origin: "claude-code",
  filePath: "/tmp/notes.md",
  content: "# Notes\n",
};

const approvedFeedback: FeedbackPayload = {
  approved: true,
  feedback: "Approved.",
  annotations: [{ blockId: "p1", type: "COMMENT" }],
  agentSwitch: "build",
  permissionMode: "acceptEdits",
};

const deniedFeedback: FeedbackPayload = {
  approved: false,
  feedback: "Needs revision.",
  annotations: [{ filePath: "src/app.ts", startLine: 1, type: "REPLACEMENT" }],
  cancelled: false,
};

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-state-test-"));
  mkdirSync(join(dir, ".plannotator"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function statePath(homeDir: string): string {
  return join(homeDir, ".plannotator", "state.json");
}

async function runStateProgram(homeDir: string, source: string) {
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
    cwd: import.meta.dir,
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

  return { stdout, stderr, exitCode };
}

async function saveStateViaChild(homeDir: string, state: DaemonState): Promise<void> {
  const result = await runStateProgram(
    homeDir,
    `await Promise.resolve(mod.saveState(${JSON.stringify(state)}));`,
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
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
    throw new Error(result.stderr || result.stdout);
  }

  return JSON.parse(result.stdout.trim()) as DaemonState;
}

async function expectChildFailure(
  homeDir: string,
  source: string,
  errorPattern: RegExp,
): Promise<void> {
  const result = await runStateProgram(homeDir, source);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(errorPattern);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("transition", () => {
  test.each([
    {
      name: "idle -> submit",
      current: IDLE_STATE,
      event: { type: "submit", document: planDocument } satisfies StateEvent,
      expected: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: planDocument,
        feedback: null,
      } satisfies DaemonState,
    },
    {
      name: "awaiting-response -> resolve",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: reviewDocument,
        feedback: null,
      } satisfies DaemonState,
      event: { type: "resolve", feedback: deniedFeedback } satisfies StateEvent,
      expected: {
        schemaVersion: 1,
        status: "resolved",
        document: reviewDocument,
        feedback: deniedFeedback,
      } satisfies DaemonState,
    },
    {
      name: "resolved -> clear",
      current: {
        schemaVersion: 1,
        status: "resolved",
        document: annotateDocument,
        feedback: approvedFeedback,
      } satisfies DaemonState,
      event: { type: "clear" } satisfies StateEvent,
      expected: IDLE_STATE,
    },
  ])("accepts legal transition $name", ({ current, event, expected }) => {
    const next = transition(structuredClone(current), event);
    expect(next).toEqual(expected);
  });

  test.each([
    {
      name: "idle -> resolve",
      current: IDLE_STATE,
      event: { type: "resolve", feedback: approvedFeedback } satisfies StateEvent,
    },
    {
      name: "idle -> clear",
      current: IDLE_STATE,
      event: { type: "clear" } satisfies StateEvent,
    },
    {
      name: "awaiting-response -> submit",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: planDocument,
        feedback: null,
      } satisfies DaemonState,
      event: { type: "submit", document: reviewDocument } satisfies StateEvent,
    },
    {
      name: "awaiting-response -> clear",
      current: {
        schemaVersion: 1,
        status: "awaiting-response",
        document: reviewDocument,
        feedback: null,
      } satisfies DaemonState,
      event: { type: "clear" } satisfies StateEvent,
    },
    {
      name: "resolved -> submit",
      current: {
        schemaVersion: 1,
        status: "resolved",
        document: reviewDocument,
        feedback: deniedFeedback,
      } satisfies DaemonState,
      event: { type: "submit", document: annotateDocument } satisfies StateEvent,
    },
    {
      name: "resolved -> resolve",
      current: {
        schemaVersion: 1,
        status: "resolved",
        document: annotateDocument,
        feedback: approvedFeedback,
      } satisfies DaemonState,
      event: { type: "resolve", feedback: deniedFeedback } satisfies StateEvent,
    },
  ])("rejects illegal transition $name", ({ current, event }) => {
    expect(() => transition(structuredClone(current), event)).toThrow(
      /illegal|state|invalid/i,
    );
  });
});

describe("state persistence", () => {
  test("returns idle state when no persisted file exists", async () => {
    const homeDir = createTempHome();

    const loaded = await loadStateViaChild(homeDir);

    expect(loaded).toEqual(IDLE_STATE);
  });

  test("saves and reloads a resolved snapshot atomically from state.json", async () => {
    const homeDir = createTempHome();
    const resolvedState: DaemonState = {
      schemaVersion: 1,
      status: "resolved",
      document: planDocument,
      feedback: approvedFeedback,
    };

    await saveStateViaChild(homeDir, resolvedState);

    expect(existsSync(statePath(homeDir))).toBe(true);
    expect(JSON.parse(readFileSync(statePath(homeDir), "utf8"))).toEqual(resolvedState);
    expect(await loadStateViaChild(homeDir)).toEqual(resolvedState);
  });

  test("reads the committed snapshot and ignores stray temp siblings", async () => {
    const homeDir = createTempHome();
    const committedState: DaemonState = {
      schemaVersion: 1,
      status: "awaiting-response",
      document: reviewDocument,
      feedback: null,
    };

    await saveStateViaChild(homeDir, committedState);

    writeFileSync(
      `${statePath(homeDir)}.tmp`,
      JSON.stringify({
        schemaVersion: 1,
        status: "resolved",
        document: annotateDocument,
        feedback: deniedFeedback,
      }),
      "utf8",
    );

    expect(await loadStateViaChild(homeDir)).toEqual(committedState);
  });

  test("rejects corrupt persisted JSON loudly", async () => {
    const homeDir = createTempHome();
    writeFileSync(
      statePath(homeDir),
      '{"schemaVersion":1,"status":"awaiting-response"',
      "utf8",
    );

    await expectChildFailure(
      homeDir,
      "await Promise.resolve(mod.loadState());",
      /parse|json|state/i,
    );
  });

  test("rejects impossible resolved snapshots without feedback", async () => {
    const homeDir = createTempHome();
    writeFileSync(
      statePath(homeDir),
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
      /resolved|feedback|state/i,
    );
  });

  test("rejects invalid states before writing them to disk", async () => {
    const homeDir = createTempHome();
    const invalidState = {
      schemaVersion: 1,
      status: "resolved",
      document: planDocument,
      feedback: null,
    } as unknown as DaemonState;

    await expectChildFailure(
      homeDir,
      `await Promise.resolve(mod.saveState(${JSON.stringify(invalidState)}));`,
      /resolved|feedback|state/i,
    );
    expect(existsSync(statePath(homeDir))).toBe(false);
  });
});
