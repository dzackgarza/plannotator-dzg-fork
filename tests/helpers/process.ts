import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { waitForResult } from "./wait";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
};

export type RunningCommand = {
  pid: number;
  child: ChildProcess;
  result: Promise<CommandResult>;
  terminate: (signal?: NodeJS.Signals) => void;
};

export type SpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinText?: string;
};

export function spawnCommand(
  command: string[],
  options: SpawnOptions = {},
): RunningCommand {
  if (command.length === 0) {
    throw new Error("spawnCommand requires at least one argv element.");
  }

  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  if (options.stdinText !== undefined) {
    child.stdin?.write(options.stdinText);
  }
  child.stdin?.end();

  return {
    pid: child.pid ?? -1,
    child,
    terminate(signal: NodeJS.Signals = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        // Process may have already exited.
      }
    },
    result: new Promise<CommandResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          signal,
        });
      });
    }),
  };
}

export type RunCommandOptions = SpawnOptions & {
  description?: string;
  timeoutMs?: number;
};

export async function runCommand(
  command: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const description = options.description ?? command.join(" ");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const running = spawnCommand(command, options);

  try {
    return await waitForResult(running.result, timeoutMs, description);
  } catch (error) {
    running.terminate("SIGKILL");
    throw error;
  }
}

export function assertCommandSucceeded(result: CommandResult, label: string): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `${label} failed with exit code ${result.exitCode}.`,
      "",
      "--- stdout ---",
      result.stdout,
      "",
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  );
}

export async function terminateIfRunning(
  command: RunningCommand,
  gracefulTimeoutMs = 5_000,
): Promise<CommandResult> {
  command.terminate("SIGTERM");

  try {
    return await waitForResult(
      command.result,
      gracefulTimeoutMs,
      `pid ${command.pid} to exit after SIGTERM`,
    );
  } catch {
    command.terminate("SIGKILL");
    return await waitForResult(
      command.result,
      gracefulTimeoutMs,
      `pid ${command.pid} to exit after SIGKILL`,
    );
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}
