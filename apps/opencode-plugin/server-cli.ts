#!/usr/bin/env bun
/**
 * Plannotator Persistent Server CLI
 *
 * Commands:
 *   start   - Start the persistent server (keeps process alive)
 *   stop    - Stop the running server
 *   status  - Show server status
 *
 * Built as dist/server-cli.js alongside dist/index.js.
 */

import {
  startPersistentServer,
  PERSISTENT_SERVER_DEFAULT_PORT,
} from "@plannotator/server/persistent";
import { listSessions, unregisterSession } from "@plannotator/server/sessions";

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
// @ts-ignore - Bun import attribute for text
import reviewHtml from "./review-editor.html" with { type: "text" };

const planHtml = indexHtml as unknown as string;
const reviewHtmlContent = reviewHtml as unknown as string;

const command = process.argv[2];

function getPort(): number {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return PERSISTENT_SERVER_DEFAULT_PORT;
}

async function healthCheck(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function cmdStart(): Promise<void> {
  const port = getPort();

  if (await healthCheck(port)) {
    console.log(`Plannotator server already running at http://localhost:${port}`);
    process.exit(0);
  }

  console.log(`Starting Plannotator persistent server on port ${port}...`);

  const handle = startPersistentServer({
    planHtml,
    reviewHtml: reviewHtmlContent,
    port,
  });

  console.log(`Plannotator server ready at ${handle.url}`);

  // Keep process alive until signalled
  await new Promise<never>(() => {});
}

async function cmdStop(): Promise<void> {
  const port = getPort();

  // Try graceful HTTP shutdown first
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.log("Plannotator server stopped.");
      process.exit(0);
    }
  } catch {}

  // Fall back to SIGTERM via session registry
  const sessions = listSessions();
  const session = sessions.find((s) => s.port === port);
  if (session) {
    try {
      process.kill(session.pid, "SIGTERM");
      unregisterSession(session.pid);
      console.log(`Stopped Plannotator server (pid ${session.pid}).`);
    } catch (e) {
      console.error(`Failed to stop server: ${e}`);
      process.exit(1);
    }
  } else {
    console.log("No running Plannotator server found.");
  }
}

async function cmdStatus(): Promise<void> {
  const port = getPort();

  if (await healthCheck(port)) {
    const resp = await fetch(`http://127.0.0.1:${port}/api/health`);
    const data = (await resp.json()) as {
      status: string;
      sessionType?: string;
    };
    console.log(`Running at http://localhost:${port}`);
    console.log(
      `Status: ${data.status}${data.sessionType ? ` (${data.sessionType})` : ""}`
    );
  } else {
    console.log("Not running.");
  }
}

switch (command) {
  case "start":
    await cmdStart();
    break;
  case "stop":
    await cmdStop();
    break;
  case "status":
    await cmdStatus();
    break;
  default:
    console.error("Usage: server-cli [start|stop|status]");
    process.exit(1);
}
