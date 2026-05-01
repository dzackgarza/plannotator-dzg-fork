import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { waitForCondition } from "./wait";

export type SessionMode = "plan" | "review" | "annotate";

export type SessionInfo = {
  pid: number;
  port: number;
  url: string;
  mode: SessionMode;
  project: string;
  startedAt: string;
  label: string;
};

export function sessionsDir(homeDir: string): string {
  return join(homeDir, ".plannotator", "sessions");
}

export function readSessions(homeDir: string): SessionInfo[] {
  const dir = sessionsDir(homeDir);
  if (!existsSync(dir)) {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const filePath = join(dir, entry);
    try {
      sessions.push(JSON.parse(readFileSync(filePath, "utf8")) as SessionInfo);
    } catch {
      // Corrupt or partially-written session files are not valid proof evidence.
    }
  }

  return sessions.sort(
    (left, right) =>
      new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
}

export async function waitForActiveSession(
  homeDir: string,
  expectedMode?: SessionMode,
  timeoutMs = 15_000,
): Promise<SessionInfo> {
  await waitForCondition(
    () => {
      const sessions = readSessions(homeDir);
      if (expectedMode) {
        return sessions.some((session) => session.mode === expectedMode);
      }
      return sessions.length > 0;
    },
    timeoutMs,
    `${expectedMode ?? "any"} active session file`,
  );

  const sessions = readSessions(homeDir);
  if (expectedMode) {
    const match = sessions.find((session) => session.mode === expectedMode);
    if (match) {
      return match;
    }
  }

  const [latest] = sessions;
  if (!latest) {
    throw new Error("Expected an active session file, but none were present.");
  }
  return latest;
}
