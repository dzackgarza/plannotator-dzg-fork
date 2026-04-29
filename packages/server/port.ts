/**
 * Local-only server port configuration.
 *
 * NIM-2 removes the remote/share runtime surface. The surviving server path
 * still allows an explicit fixed port through PLANNOTATOR_PORT, otherwise it
 * binds an ephemeral local port.
 */

export function isRemoteSession(): boolean {
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

  return 0;
}
