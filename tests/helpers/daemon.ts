import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { isPidAlive } from "./process";
import { waitForCondition } from "./wait";

export function readLockfilePid(lockfilePath: string): number {
  if (!existsSync(lockfilePath)) {
    throw new Error(`Expected lockfile at ${lockfilePath}.`);
  }

  const parsed = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
    pid?: unknown;
  };

  if (
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    throw new Error(`Expected ${lockfilePath} to contain a positive integer pid.`);
  }

  return parsed.pid;
}

export async function waitForDaemonReady(
  lockfilePath: string,
  readyFilePath: string,
  timeoutMs = 10_000,
): Promise<number> {
  await waitForCondition(
    () => existsSync(readyFilePath) && existsSync(lockfilePath),
    timeoutMs,
    "daemon ready and lockfile creation",
  );
  return readLockfilePid(lockfilePath);
}

export async function killAndWait(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  timeoutMs = 10_000,
): Promise<void> {
  if (!isPidAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Process may have exited between liveness check and signal.
  }

  await waitForCondition(
    () => !isPidAlive(pid),
    timeoutMs,
    `pid ${pid} to exit after ${signal}`,
  );
}

export async function forceCleanupLockedDaemon(
  lockfilePath: string,
  timeoutMs = 10_000,
): Promise<void> {
  if (!existsSync(lockfilePath)) {
    return;
  }

  let pid: number;
  try {
    pid = readLockfilePid(lockfilePath);
  } catch {
    return;
  }

  if (!isPidAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGKILL");
  await waitForCondition(
    () => !isPidAlive(pid),
    timeoutMs,
    `pid ${pid} to exit during cleanup`,
  );
}
