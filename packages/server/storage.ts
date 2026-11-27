
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "fs";
import { sanitizeTag } from "./project";
import { isPlanOrigin } from "./state";
import { $ } from "bun";

export function getPlanDir(customPath?: string | null): string {
  let planDir: string;

  if (customPath) {
    planDir = customPath.startsWith("~")
      ? join(homedir(), customPath.slice(1))
      : customPath;
  } else {
    planDir = join(homedir(), ".plannotator", "plans");
  }

  mkdirSync(planDir, { recursive: true });
  return planDir;
}

function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

export function generateSlug(plan: string): string {
  const date = new Date().toISOString().split("T")[0];

  const heading = extractFirstHeading(plan);
  const slug = heading ? sanitizeTag(heading) : null;

  return slug ? `${slug}-${date}` : `plan-${date}`;
}

export function savePlan(slug: string, content: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function saveAnnotations(slug: string, annotationsContent: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.annotations.md`);
  writeFileSync(filePath, annotationsContent, "utf-8");
  return filePath;
}

export function saveFinalSnapshot(
  slug: string,
  status: "approved" | "denied",
  plan: string,
  annotations: string,
  customPath?: string | null
): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}-${status}.md`);

  let content = plan;
  if (annotations && annotations !== "No changes detected.") {
    content += "\n\n---\n\n" + annotations;
  }

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}


export async function getHistoryDir(project: string): Promise<string> {
  const historyDir = join(homedir(), ".plannotator", "plans", project);
  mkdirSync(historyDir, { recursive: true });

  if (!existsSync(join(historyDir, ".git"))) {
    try {
      await $`git init`.cwd(historyDir).quiet();
      await $`git config user.name "Plannotator"`.cwd(historyDir).quiet();
      await $`git config user.email "bot@plannotator.ai"`.cwd(historyDir).quiet();
    } catch (err) {
      console.error("[Plannotator] Failed to initialize git history repo:", err);
    }
  }

  return historyDir;
}

export async function saveToHistory(
  project: string,
  slug: string,
  plan: string,
  commitMessage?: string,
  origin?: string
): Promise<{ version: number; path: string; isNew: boolean }> {
  const agent = origin ?? "plannotator";
  if (!isPlanOrigin(agent)) {
    throw new Error("Plan origin must be a lowercase agent identifier");
  }
  const historyDir = await getHistoryDir(project);
  const fileName = `${slug}.md`;
  const filePath = join(historyDir, fileName);

  const prevCount = await getVersionCount(project, slug);

  writeFileSync(filePath, plan, "utf-8");

  const status = await $`git status --porcelain ${fileName}`.cwd(historyDir).quiet();
  if (!status.text().trim()) {
    return { version: prevCount || 1, path: filePath, isNew: false };
  }

  const knownAuthors = new Map([
    ["claude-code", "Claude Code"],
    ["opencode", "OpenCode"],
    ["pi", "Pi"],
    ["plannotator", "Plannotator"],
  ]);
  const authorName = knownAuthors.get(agent) ?? agent;
  const authorEmail = agent === "plannotator" ? "bot" : agent;
  const author = `${authorName} <${authorEmail}@plannotator.ai>`;

  await $`git add ${fileName}`.cwd(historyDir).quiet();
  
  const msg = commitMessage || `Update plan ${slug} to version ${prevCount + 1}`;
  await $`git commit --author=${author} -m ${msg}`.cwd(historyDir).quiet().nothrow();

  const newCount = await getVersionCount(project, slug);
  return { version: newCount, path: filePath, isNew: true };
}

export async function getPlanVersion(
  project: string,
  slug: string,
  version: number
): Promise<string | null> {
  const historyDir = join(homedir(), ".plannotator", "plans", project);
  const fileName = `${slug}.md`;
  
  if (!existsSync(join(historyDir, ".git"))) return null;

  try {
    const commitsStr = await $`git log --reverse --format=%H -- ${fileName}`.cwd(historyDir).quiet();
    const commits = commitsStr.text().trim().split("\n").filter(Boolean);
    
    if (version < 1 || version > commits.length) return null;
    
    const targetCommit = commits[version - 1];
    const content = await $`git show ${targetCommit}:${fileName}`.cwd(historyDir).quiet();
    return content.text();
  } catch {
    return null;
  }
}

export async function getPlanVersionPath(
  project: string,
  slug: string,
  version: number
): Promise<string | null> {
  const content = await getPlanVersion(project, slug, version);
  if (content === null) return null;

  const tmpDir = join(homedir(), ".plannotator", "tmp", project, slug);
  mkdirSync(tmpDir, { recursive: true });
  
  const tmpPath = join(tmpDir, `${version}.md`);
  writeFileSync(tmpPath, content, "utf-8");
  return tmpPath;
}

export async function getVersionCount(project: string, slug: string): Promise<number> {
  const historyDir = join(homedir(), ".plannotator", "plans", project);
  const fileName = `${slug}.md`;

  if (!existsSync(join(historyDir, ".git"))) return 0;

  try {
    const res = await $`git rev-list --count HEAD -- ${fileName}`.cwd(historyDir).quiet().nothrow();
    if (res.exitCode !== 0) return 0;
    return parseInt(res.text().trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function listVersions(
  project: string,
  slug: string
): Promise<Array<{ version: number; timestamp: string }>> {
  const historyDir = join(homedir(), ".plannotator", "plans", project);
  const fileName = `${slug}.md`;

  if (!existsSync(join(historyDir, ".git"))) return [];

  try {
    const res = await $`git log --reverse --format=%ad --date=iso -- ${fileName}`.cwd(historyDir).quiet().nothrow();
    if (res.exitCode !== 0) return [];
    
    const dates = res.text().trim().split("\n").filter(Boolean);
    return dates.map((dateStr, idx) => ({
      version: idx + 1,
      timestamp: new Date(dateStr).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listProjectPlans(
  project: string
): Promise<Array<{ slug: string; versions: number; lastModified: string }>> {
  const projectDir = join(homedir(), ".plannotator", "plans", project);
  
  if (!existsSync(projectDir)) return [];

  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    const plans: Array<{ slug: string; versions: number; lastModified: string }> = [];
    
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      
      const slug = entry.name.slice(0, -3);
      const versions = await getVersionCount(project, slug);
      if (versions === 0) continue;

      let lastModified = "";
      try {
        const mtime = statSync(join(projectDir, entry.name)).mtime;
        lastModified = mtime.toISOString();
      } catch {            }

      plans.push({
        slug,
        versions,
        lastModified,
      });
    }
    return plans.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  } catch {
    return [];
  }
}
