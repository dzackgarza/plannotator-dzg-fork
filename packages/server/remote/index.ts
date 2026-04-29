/**
 * Legacy compatibility module.
 *
 * Production code now uses ./port.ts after NIM-2 removed the remote runtime
 * surface. This directory keeps the historical import path available for
 * existing tests and downstream callers until they migrate.
 */

const DEFAULT_REMOTE_PORT = 19432;

export function isRemoteSession(): boolean {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === "1" || remote?.toLowerCase() === "true") {
    return true;
  }

  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }

  return false;
}

export function getServerPort(): number {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }

    console.error(
      `[Plannotator] Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default`,
    );
  }

  return isRemoteSession() ? DEFAULT_REMOTE_PORT : 0;
}
