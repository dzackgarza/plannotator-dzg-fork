#!/usr/bin/env bun
/**
 * Plannotator Persistent Server CLI
 *
 * Commands:
 *   start   - Start the persistent server (keeps process alive)
 *   stop    - Stop the running server
 *   status  - Show server status
 */

import {
  startPersistentServer,
  stopServer,
  checkServerHealth,
  PERSISTENT_SERVER_DEFAULT_PORT,
} from "@plannotator/server/persistent";

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

switch (command) {
  case "start": {
    const port = getPort();
    if (await checkServerHealth(port)) {
      console.log(`Plannotator server already running at http://localhost:${port}`);
      process.exit(0);
    }
    console.log(`Starting Plannotator persistent server on port ${port}...`);
    const handle = startPersistentServer({ planHtml, reviewHtml: reviewHtmlContent, port });
    console.log(`Plannotator server ready at ${handle.url}`);
    await new Promise<never>(() => {});
    break;
  }

  case "stop":
    await stopServer();
    break;

  case "status": {
    const port = getPort();
    const status = await checkServerHealth(port);
    if (status) {
      console.log(`Running at http://localhost:${port}`);
      console.log(`Phase: ${status.phase}${status.type ? ` (${status.type})` : ""}`);
    } else {
      console.log("Not running.");
    }
    break;
  }

  default:
    console.error("Usage: server-cli [start|stop|status]");
    process.exit(1);
}
