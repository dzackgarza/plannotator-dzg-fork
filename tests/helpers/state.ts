import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonState } from "../../packages/server/state";

export function statePathForHome(homeDir: string): string {
  return join(homeDir, ".plannotator", "state.json");
}

export function readPersistedState(homeDir: string): DaemonState {
  return JSON.parse(readFileSync(statePathForHome(homeDir), "utf8")) as DaemonState;
}

export function writePersistedState(homeDir: string, state: DaemonState): void {
  const stateDir = join(homeDir, ".plannotator");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePathForHome(homeDir), JSON.stringify(state), "utf8");
}
