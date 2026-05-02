import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const trackedDirs: string[] = [];

export function createTempDir(prefix = "plannotator-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedDirs.push(dir);
  return dir;
}

export function cleanupTrackedTempDirs(): void {
  for (const dir of trackedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function trackTempDir(dir: string): string {
  trackedDirs.push(dir);
  return dir;
}
