import { $, type ShellOutput } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import {
  runPlannotatorAnnotateTool,
  runPlannotatorReviewTool,
  type AnnotateToolEnvironment,
  type ReviewToolEnvironment,
} from "./tool-helpers";

type PromptRequest = {
  path: { id: string };
  body: {
    agent?: string;
    noReply?: boolean;
    parts: Array<{ type: "text"; text: string }>;
  };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const tempDirs: string[] = [];

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createToolContext(sessionID = "session-1"): ToolContext {
  return {
    sessionID,
    messageID: "message-1",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

function createPromptCollector() {
  const prompts: PromptRequest[] = [];
  return {
    prompts,
    client: {
      session: {
        async prompt(request: PromptRequest) {
          prompts.push(request);
          return {};
        },
      },
    },
  };
}

function createTempProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-opencode-plugin-"));
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return root;
}

async function createTempGitRepo(): Promise<string> {
  const root = createTempProject({
    "src/app.ts": "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
  });

  await runGit($`git init -b main`.cwd(root));
  await runGit($`git config user.name Plannotator Tests`.cwd(root));
  await runGit($`git config user.email tests@example.com`.cwd(root));
  await runGit($`git add src/app.ts`.cwd(root));
  await runGit($`git commit -m initial`.cwd(root));

  writeFileSync(
    join(root, "src/app.ts"),
    "export function greet(name: string) {\n  return `hello, ${name}!`;\n}\n",
  );

  return root;
}

async function runGit(command: ShellOutput): Promise<void> {
  const result = await command.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

async function flushTasks(): Promise<void> {
  await Promise.resolve();
  await Bun.sleep(0);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runPlannotatorAnnotateTool", () => {
  test("starts the annotate server and relays feedback back into the session", async () => {
    const projectRoot = createTempProject({
      "docs/design.md": "# Design\n\nInitial draft.\n",
    });
    const { client, prompts } = createPromptCollector();
    const decision = createDeferred<{
      feedback: string;
      annotations: unknown[];
    }>();
    const started: { markdown?: string; filePath?: string; stopped: boolean } = {
      stopped: false,
    };

    const result = await runPlannotatorAnnotateTool(
      { file_path: "docs/design.md" },
      createToolContext("annotate-session"),
      {
        client,
        directory: projectRoot,
        htmlContent: "<html></html>",
        getSharingEnabled: async () => false,
        getShareBaseUrl: () => undefined,
      } satisfies AnnotateToolEnvironment,
      {
        resolveMarkdownFile: async () => ({
          kind: "found",
          path: resolve(projectRoot, "docs/design.md"),
        }),
        readFile: async (filePath) => Bun.file(filePath).text(),
        startAnnotateServer: async (options) => {
          started.markdown = options.markdown;
          started.filePath = options.filePath;
          return {
            port: 19432,
            url: "http://localhost:19432/annotate",
            isRemote: false,
            waitForDecision: () => decision.promise,
            stop: () => {
              started.stopped = true;
            },
          };
        },
        onReady() {},
        sleep: async () => {},
      },
    );

    expect(result).toContain("Started annotation server at http://localhost:19432/annotate");
    expect(result).toContain("Wait for the user's submitted feedback before proceeding");
    expect(started.filePath).toBe(resolve(projectRoot, "docs/design.md"));
    expect(started.markdown).toContain("Initial draft.");

    decision.resolve({
      feedback: "Please tighten the introduction.",
      annotations: [],
    });
    await flushTasks();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({
      path: { id: "annotate-session" },
      body: {
        parts: [
          {
            type: "text",
            text: "# Markdown Annotations\n\nFile: " +
              `${resolve(projectRoot, "docs/design.md")}` +
              "\n\nPlease tighten the introduction.\n\nPlease address the annotation feedback above.",
          },
        ],
      },
    });
    expect(started.stopped).toBe(true);
  });

  test("returns actionable guidance when the file description is ambiguous", async () => {
    const projectRoot = createTempProject();
    const { client } = createPromptCollector();

    const result = await runPlannotatorAnnotateTool(
      { file_path: "design.md" },
      createToolContext(),
      {
        client,
        directory: projectRoot,
        htmlContent: "<html></html>",
        getSharingEnabled: async () => false,
        getShareBaseUrl: () => undefined,
      },
      {
        resolveMarkdownFile: async () => ({
          kind: "ambiguous",
          input: "design.md",
          matches: ["docs/design.md", "notes/design.md"],
        }),
        readFile: async () => "",
        startAnnotateServer: async () => {
          throw new Error("server should not start");
        },
        onReady() {},
        sleep: async () => {},
      },
    );

    expect(result).toContain('Could not start annotation: "design.md" matched multiple markdown files.');
    expect(result).toContain("- docs/design.md");
    expect(result).toContain("- notes/design.md");
  });
});

describe("runPlannotatorReviewTool", () => {
  test("captures a real git diff, starts review, and relays feedback", async () => {
    const projectRoot = await createTempGitRepo();
    const { client, prompts } = createPromptCollector();
    const decision = createDeferred<{
      approved: boolean;
      feedback: string;
      annotations: unknown[];
      agentSwitch?: string;
    }>();
    const started: {
      rawPatch?: string;
      gitRef?: string;
      diffType?: string;
      defaultBranch?: string;
      stopped: boolean;
    } = { stopped: false };

    const result = await runPlannotatorReviewTool(
      { diff_type: "uncommitted" },
      createToolContext("review-session"),
      {
        client,
        directory: projectRoot,
        htmlContent: "<html></html>",
        getSharingEnabled: async () => false,
        getShareBaseUrl: () => undefined,
      } satisfies ReviewToolEnvironment,
      {
        getGitContext: async (cwd) => {
          const { getGitContext } = await import("@plannotator/server/git");
          return await getGitContext(cwd);
        },
        runGitDiff: async (diffType, defaultBranch, cwd) => {
          const { runGitDiff } = await import("@plannotator/server/git");
          return await runGitDiff(diffType, defaultBranch, cwd);
        },
        startReviewServer: async (options) => {
          started.rawPatch = options.rawPatch;
          started.gitRef = options.gitRef;
          started.diffType = options.diffType;
          started.defaultBranch = options.gitContext?.defaultBranch;
          return {
            port: 19432,
            url: "http://localhost:19432/review",
            isRemote: false,
            waitForDecision: () => decision.promise,
            stop: () => {
              started.stopped = true;
            },
          };
        },
        onReady() {},
        sleep: async () => {},
      },
    );

    expect(result).toContain("Started code review server at http://localhost:19432/review");
    expect(result).toContain("Wait for the user's submitted feedback before proceeding");
    expect(started.diffType).toBe("uncommitted");
    expect(started.defaultBranch).toBe("main");
    expect(started.gitRef).toBe("Uncommitted changes");
    expect(started.rawPatch).toContain("return `hello, ${name}!`;");
    expect(started.rawPatch).toContain("return `hello ${name}`;");

    decision.resolve({
      approved: false,
      feedback: "Please keep the old greeting format.",
      annotations: [],
      agentSwitch: "build",
    });
    await flushTasks();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({
      path: { id: "review-session" },
      body: {
        agent: "build",
        parts: [
          {
            type: "text",
            text: "# Code Review Feedback\n\nPlease keep the old greeting format.\n\nPlease address this feedback.",
          },
        ],
      },
    });
    expect(started.stopped).toBe(true);
  });
});

describe("plannotator annotate slash command", () => {
  test("passes the plain-text description through to the agent tool prompt", async () => {
    const command = await Bun.file(
      join(import.meta.dir, "commands", "plannotator-annotate.md"),
    ).text();

    expect(command).toContain("The Plannotator Annotate UI has been triggered.");
    expect(command).toContain("plannotator_annotate");
    expect(command).toContain("Description: $ARGUMENTS");
  });
});
