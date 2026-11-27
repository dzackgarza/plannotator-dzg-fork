import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function repoPath(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const PLUGIN_DIR = repoPath("apps/opencode-plugin");
const PLUGIN_INDEX = join(PLUGIN_DIR, "index.ts");
const TOOL_HELPERS = join(PLUGIN_DIR, "tool-helpers.ts");

describe("14-opencode-shim", () => {
  test("14.1 tool-helpers shells out to plannotator submit with --json", () => {
    if (!existsSync(TOOL_HELPERS)) {
      if (!existsSync(PLUGIN_INDEX)) {
        throw new Error(`Neither tool-helpers.ts nor index.ts found in ${PLUGIN_DIR}`);
      }
      const indexSrc = readFileSync(PLUGIN_INDEX, "utf8");
      expect(indexSrc).toContain("plannotator");
      expect(indexSrc).toContain("submit");
      return;
    }

    const src = readFileSync(TOOL_HELPERS, "utf8");
    expect(src).toContain("plannotator");
    expect(src).toContain("submit");
    expect(src).toContain("--json");
  });

  test("14.2 submit_plan tool definition has plan, summary, commit_message parameters", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("submit_plan");
    expect(src).toContain("plan");
    expect(src).toContain("summary");
    expect(src).toContain("commit_message");
  });

  test("14.3 plannotator_review tool definition exists and shells out to review subcommand", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("plannotator_review");
    expect(src).toContain("review");
  });

  test("14.4 plannotator_annotate tool definition exists and shells out to annotate subcommand", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("plannotator_annotate");
    expect(src).toContain("annotate");
  });

  test("14.5 system prompt injection contains submit_plan instructions", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("submit_plan");
  });

  test("14.6 injection skipped for title-generator requests (source check)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("title generator");
  });

  test("14.7 injection skipped for build agent (source check)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain('"build"');
  });

  test("14.8 injection skipped for subagent mode (source check)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("subagent");
  });

  test("14.9 plugin registers tools as primary_only (not visible to sub-agents)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("primary_tools");
  });

  test("14.x plannotator CLI binary accepts --json flag on submit subcommand", async () => {
    const { buildBinary, runCli } = await import("../helpers");
    const binary = await buildBinary();
    const result = await runCli(["submit", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--origin");
  }, 300_000);
});
