import process from "node:process";
import { bunExecutable, noopBrowserExecutable, repoRoot } from "./paths";
import {
  runCommand,
  spawnCommand,
  type CommandResult,
  type RunningCommand,
} from "./process";

const HOOK_ENTRY = "apps/hook/server/index.ts";

export type CliEnvOverrides = {
  homeDir: string;
  workspaceRoot: string;
  extra?: NodeJS.ProcessEnv;
};

export function cliEnv(options: CliEnvOverrides): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: options.homeDir,
    PLANNOTATOR_BROWSER: noopBrowserExecutable(),
    PLANNOTATOR_CWD: options.workspaceRoot,
    ...(options.extra ?? {}),
  };
}

export type RunCliOptions = {
  workspaceRoot?: string;
  homeDir: string;
  args: string[];
  stdinText?: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
};

export async function runCli(options: RunCliOptions): Promise<CommandResult> {
  const cwd = options.workspaceRoot ?? repoRoot;
  return await runCommand([bunExecutable, "run", HOOK_ENTRY, ...options.args], {
    cwd,
    env: cliEnv({
      homeDir: options.homeDir,
      workspaceRoot: cwd,
      extra: options.extraEnv,
    }),
    description: `plannotator ${options.args.join(" ") || "<default>"}`,
    stdinText: options.stdinText,
    timeoutMs: options.timeoutMs,
  });
}

export function spawnCli(options: RunCliOptions): RunningCommand {
  const cwd = options.workspaceRoot ?? repoRoot;
  return spawnCommand([bunExecutable, "run", HOOK_ENTRY, ...options.args], {
    cwd,
    env: cliEnv({
      homeDir: options.homeDir,
      workspaceRoot: cwd,
      extra: options.extraEnv,
    }),
    stdinText: options.stdinText,
  });
}
