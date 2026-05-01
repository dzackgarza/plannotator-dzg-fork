import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTempDir } from "./tempdir";

export type PlanFixtureOptions = {
  heading?: string;
  body?: string;
  prefix?: string;
};

export function createPlanMarkdownFixture(
  options: PlanFixtureOptions = {},
): { dir: string; path: string; content: string } {
  const dir = createTempDir(options.prefix ?? "plannotator-plan-fixture-");
  const heading = options.heading ?? "Plannotator proof plan";
  const body =
    options.body ??
    [
      "1. Start the daemon.",
      "2. Submit this plan.",
      "3. Wait for verdict.",
    ].join("\n");
  const content = `# ${heading}\n\n${body}\n`;
  const path = join(dir, "plan.md");
  writeFileSync(path, content, "utf8");
  return { dir, path, content };
}

export function createSubmitPlanStdin(plan: string): string {
  return JSON.stringify({ tool_input: { plan } });
}

export function createMarkdownNoteFixture(
  relPath = "note.md",
  body = "# Note\n\nMarkdown body for annotate sessions.\n",
): { dir: string; path: string; content: string } {
  const dir = createTempDir("plannotator-note-fixture-");
  const path = join(dir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return { dir, path, content: body };
}
