import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlannotatorSubmitCli } from "../../../apps/opencode-plugin/tool-helpers";
import { withEnv } from "../../../apps/opencode-plugin/test-helpers";
import {
  buildBinary,
  createSandbox,
  getFreePort,
  runCli,
  runCliBackground,
  startDaemon,
  type Sandbox,
} from "../helpers";


const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  "fixtures/plans",
);

const REPOS_DIR = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  "fixtures/repos",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("09-history-storage", () => {
  let sandbox: Sandbox;
  let port: number;

  beforeEach(async () => {
    sandbox = createSandbox();
    port = await getFreePort();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      HOME: sandbox.home,
      PLANNOTATOR_PORT: String(port),
      PLANNOTATOR_BROWSER: "/usr/bin/true",
      ...extra,
    };
  }

  function daemonUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  async function submitAndApprove(plan: string, commitMessage?: string): Promise<void> {
    const args = ["submit", plan, "--no-browser"];
    if (commitMessage) {
      args.push("--commit-message", commitMessage);
    }
    const submitHandle = runCliBackground(args, { env: env() });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const resp = await fetch(daemonUrl("/api/state"));
      const body = (await resp.json()) as { status: string };
      if (body.status === "awaiting-response") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await fetch(daemonUrl("/api/approve"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "", annotations: [] }),
    });

    await submitHandle.waitForExit();
  }

  test("9.1 approved plan creates git repo with slug.md in plans/{project}/", async () => {
    const testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: { ...env(), HOME: sandbox.home }, cwd: testRepo },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      await submitHandle.waitForExit();

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      expect(existsSync(plansRoot)).toBe(true);

      const projects = readdirSync(plansRoot);
      expect(projects.length).toBeGreaterThan(0);

      const projectDir = join(plansRoot, projects[0]);
      expect(existsSync(join(projectDir, ".git"))).toBe(true);

      const files = readdirSync(projectDir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);

      const today = new Date().toISOString().slice(0, 10);
      expect(files.some((f) => f.endsWith(`${today}.md`))).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  test("9.2 git log in plans dir contains commit-message string", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const commitMsg = "addressed error-handling review feedback";
      await submitAndApprove(join(FIXTURES_DIR, "small.md"), commitMsg);

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      const projects = readdirSync(plansRoot);
      expect(projects.length).toBeGreaterThan(0);

      const projectDir = join(plansRoot, projects[0]);
      const gitLog = execSync("git log --format=%B", {
        cwd: projectDir,
        encoding: "utf8",
      });
      expect(gitLog).toContain(commitMsg);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  test("records the submitting agent in each plan history commit", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    const planFile = join(sandbox.home, "plan.md");
    const plansRoot = join(sandbox.home, ".plannotator", "plans");
    const authors = () => {
      const project = readdirSync(plansRoot)[0];
      return execFileSync("git", ["log", "--reverse", "--format=%an%x09%ae"], {
        cwd: join(plansRoot, project),
        encoding: "utf8",
      }).trim().split("\n").map((line) => line.split("\t"));
    };

    async function rejectSubmission(): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const state = await (await fetch(daemonUrl("/api/state"))).json();
        if (state.status === "awaiting-response") {
          const response = await fetch(daemonUrl("/api/deny"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ feedback: "Revise the plan" }),
          });
          expect(response.ok).toBe(true);
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("Submission did not enter review");
    }

    try {
      await withEnv({
        ...env(),
        PLANNOTATOR_CLI_ENTRYPOINT: fileURLToPath(new URL("../../../apps/hook/server/index.ts", import.meta.url)),
      }, async () => {
        const [verdict] = await Promise.all([
          runPlannotatorSubmitCli(
            { plan: "# Attribution\nOpenCode", commit_message: "first plan" },
            { directory: sandbox.home, client: { session: { async prompt() {} } } },
            15_000,
          ),
          rejectSubmission(),
        ]);
        expect(verdict.approved).toBe(false);
      });
      expect(authors()).toEqual([["OpenCode", "opencode@plannotator.ai"]]);

      const [hook] = await Promise.all([
        runCli(["submit", "--json", "--no-browser"], {
          env: env(),
          stdin: JSON.stringify({ tool_input: { plan: "# Attribution\nClaude Code" } }),
        }),
        rejectSubmission(),
      ]);
      expect(hook.exitCode).toBe(1);

      for (const origin of ["pi", "other-agent"]) {
        writeFileSync(planFile, `# Attribution\n${origin}`);
        const [result] = await Promise.all([
          runCli(["submit", planFile, "--origin", origin, "--no-browser"], { env: env() }),
          rejectSubmission(),
        ]);
        expect(result.exitCode).toBe(1);
      }

      writeFileSync(planFile, "# Attribution\nUnspecified caller");
      const [direct] = await Promise.all([
        runCli(["submit", planFile, "--no-browser"], { env: env() }),
        rejectSubmission(),
      ]);
      expect(direct.exitCode).toBe(1);

      const expectedAuthors = [
        ["OpenCode", "opencode@plannotator.ai"],
        ["Claude Code", "claude-code@plannotator.ai"],
        ["Pi", "pi@plannotator.ai"],
        ["other-agent", "other-agent@plannotator.ai"],
        ["Plannotator", "bot@plannotator.ai"],
      ];
      expect(authors()).toEqual(expectedAuthors);

      const [duplicate] = await Promise.all([
        runCli(["submit", planFile, "--origin", "pi", "--no-browser"], { env: env() }),
        rejectSubmission(),
      ]);
      expect(duplicate.exitCode).toBe(1);
      expect(authors()).toEqual(expectedAuthors);

      const previousState = await (await fetch(daemonUrl("/api/state"))).json();
      const invalidOrigin = "bad<author@example.com>";
      const invalidCli = await runCli(
        ["submit", planFile, "--origin", invalidOrigin, "--no-browser"],
        { env: env() },
      );
      expect(invalidCli.exitCode).toBe(2);
      const invalidApi = await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: { ...previousState.document, origin: invalidOrigin, content: "# Attribution\nInvalid" },
        }),
      });
      expect(invalidApi.status).toBe(400);
      expect(await (await fetch(daemonUrl("/api/state"))).json()).toEqual(previousState);
      expect(authors()).toEqual(expectedAuthors);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("9.3 project name derives from git repo root name", async () => {
    const testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env(), cwd: testRepo },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      await submitHandle.waitForExit();

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      const projects = readdirSync(plansRoot);
      expect(projects.length).toBeGreaterThan(0);
      const projectName = projects[0];
      expect(projectName).toMatch(/plannotator/);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  test("9.5 deny-resubmit-approve cycle produces correct git history", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const firstSubmit = runCliBackground(
        ["submit", join(FIXTURES_DIR, "revision-base.md"), "--no-browser", "--commit-message", "initial plan"],
        { env: env() },
      );
      let deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "needs more sections" }),
      });
      await firstSubmit.waitForExit();

      const secondSubmit = runCliBackground(
        ["submit", join(FIXTURES_DIR, "revision-revised.md"), "--no-browser", "--commit-message", "addressed feedback: added sections"],
        { env: env() },
      );
      deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM", annotations: [] }),
      });
      await secondSubmit.waitForExit();

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      const projects = readdirSync(plansRoot);
      const projectDir = join(plansRoot, projects[0]);
      const gitLog = execSync("git log --format=%B", {
        cwd: projectDir,
        encoding: "utf8",
      });

      expect(gitLog).toContain("initial plan");
      expect(gitLog).toContain("addressed feedback");
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("9.4 project name falls back to cwd directory name when not in a git repo", async () => {
    const { mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const nonGitDir = join(tmpdir(), `plannotator-e2e-nongit-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env(), cwd: nonGitDir },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      await submitHandle.waitForExit();

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      if (existsSync(plansRoot)) {
        const projects = readdirSync(plansRoot);
        expect(projects.length).toBeGreaterThan(0);
        const lastName = nonGitDir.split("/").pop() ?? "";
        const sanitized = lastName.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
        expect(projects.some((p) => p.includes(sanitized.slice(0, 10)))).toBe(true);
      }
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  test("9.6 annotation draft saved to /api/draft persists between requests", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const draft = { annotations: [{ id: "a1", type: "COMMENT", text: "test note", originalText: "foo" }] };

      const saveResp = await fetch(daemonUrl("/api/draft"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      expect(saveResp.ok).toBe(true);

      const getResp = await fetch(daemonUrl("/api/draft"));
      expect(getResp.ok).toBe(true);
      const retrieved = (await getResp.json()) as { annotations?: unknown[] };
      expect(Array.isArray(retrieved.annotations)).toBe(true);
      expect((retrieved.annotations ?? []).length).toBeGreaterThan(0);

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  test("9.7 /api/obsidian/vaults endpoint responds without crashing daemon", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const resp = await fetch(daemonUrl("/api/obsidian/vaults"));
      expect([200, 404]).toContain(resp.status);
      if (resp.ok) {
        const body = (await resp.json()) as unknown;
        expect(Array.isArray(body)).toBe(true);
      }
    } finally {
      await daemon.stop();
    }
  });

  test("9.4 plan with no heading uses fallback slug plan-YYYY-MM-DD", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await submitAndApprove(join(FIXTURES_DIR, "plan-no-heading.md"));

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      const projects = readdirSync(plansRoot);
      const projectDir = join(plansRoot, projects[0]);
      const files = readdirSync(projectDir).filter((f) => f.endsWith(".md"));

      const today = new Date().toISOString().slice(0, 10);
      expect(files.some((f) => f.startsWith("plan-") && f.includes(today))).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 40_000);
});
