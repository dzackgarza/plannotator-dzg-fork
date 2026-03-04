/**
 * Shared route handlers used by plan, review, and annotate servers.
 *
 * Eliminates duplication of /api/image, /api/upload, and the server-ready
 * handler across all three server files. Also shares /api/agents for plan + review.
 */

import { mkdirSync } from "fs";
import { openBrowser } from "./browser";
import { validateImagePath, validateUploadExtension, UPLOAD_DIR } from "./image";

/** Serve images from local paths or temp uploads. Used by all 3 servers. */
export async function handleImage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const imagePath = url.searchParams.get("path");
  if (!imagePath) {
    return new Response("Missing path parameter", { status: 400 });
  }
  const validation = validateImagePath(imagePath);
  if (!validation.valid) {
    return new Response(validation.error!, { status: 403 });
  }
  try {
    const file = Bun.file(validation.resolved);
    if (!(await file.exists())) {
      return new Response("File not found", { status: 404 });
    }
    return new Response(file);
  } catch {
    return new Response("Failed to read file", { status: 500 });
  }
}

/** Upload image to temp dir, return path. Used by all 3 servers. */
export async function handleUpload(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) {
      return new Response("No file provided", { status: 400 });
    }

    const extResult = validateUploadExtension(file.name);
    if (!extResult.valid) {
      return Response.json({ error: extResult.error }, { status: 400 });
    }
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const tempPath = `${UPLOAD_DIR}/${crypto.randomUUID()}.${extResult.ext}`;

    await Bun.write(tempPath, file);
    return Response.json({ path: tempPath, originalName: file.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** OpenCode agent client interface (subset of OpenCode SDK) */
export interface OpencodeClient {
  app: {
    agents: (options?: object) => Promise<{
      data?: Array<{ name: string; description?: string; mode: string; hidden?: boolean }>;
    }>;
  };
}

/** List available agents. Used by plan + review servers (OpenCode only). */
export async function handleAgents(opencodeClient?: OpencodeClient): Promise<Response> {
  if (!opencodeClient) {
    return Response.json({ agents: [] });
  }

  try {
    const result = await opencodeClient.app.agents({});
    const agents = (result.data ?? [])
      .filter((a) => a.mode === "primary" && !a.hidden)
      .map((a) => ({ id: a.name, name: a.name, description: a.description }));

    return Response.json({ agents });
  } catch {
    return Response.json({ agents: [], error: "Failed to fetch agents" });
  }
}

/** Open browser for local sessions. Used by all 3 servers. */
export async function handleServerReady(
  url: string,
  isRemote: boolean,
  _port: number,
): Promise<void> {
  if (!isRemote) {
    await openBrowser(url);
  }
}
