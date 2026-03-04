/**
 * Reference/document route handlers for the plan server.
 *
 * Handles /api/doc, /api/obsidian/vaults, /api/reference/obsidian/files,
 * and /api/reference/obsidian/doc. Extracted from index.ts for modularity.
 */

import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { detectObsidianVaults } from "./integrations";

// --- Vault file tree helpers ---

export interface VaultNode {
  name: string;
  path: string; // relative path within vault
  type: "file" | "folder";
  children?: VaultNode[];
}

/**
 * Build a nested file tree from a sorted list of relative paths.
 * Folders are sorted before files at each level.
 */
export function buildFileTree(relativePaths: string[]): VaultNode[] {
  const root: VaultNode[] = [];

  for (const filePath of relativePaths) {
    const parts = filePath.split("/");
    let current = root;
    let pathSoFar = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const isFile = i === parts.length - 1;

      let node = current.find((n) => n.name === part && n.type === (isFile ? "file" : "folder"));
      if (!node) {
        node = { name: part, path: pathSoFar, type: isFile ? "file" : "folder" };
        if (!isFile) node.children = [];
        current.push(node);
      }
      if (!isFile) {
        current = node.children!;
      }
    }
  }

  // Sort: folders first (alphabetical), then files (alphabetical)
  const sortNodes = (nodes: VaultNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) sortNodes(node.children);
    }
  };
  sortNodes(root);

  return root;
}

// --- Route handlers ---

/** Serve a linked markdown document. Resolves absolute, relative, or bare filename paths. */
export async function handleDoc(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestedPath = url.searchParams.get("path");
  if (!requestedPath) {
    return Response.json({ error: "Missing path parameter" }, { status: 400 });
  }

  const projectRoot = process.cwd();

  // Restrict to markdown files only
  if (!/\.mdx?$/i.test(requestedPath)) {
    return Response.json({ error: "Only .md and .mdx files are supported" }, { status: 400 });
  }

  // Path resolution: 3 strategies in order
  let resolvedPath: string | null = null;

  if (requestedPath.startsWith("/")) {
    // 1. Absolute path
    resolvedPath = requestedPath;
  } else {
    // 2. Relative to project root
    const fromRoot = resolve(projectRoot, requestedPath);
    if (await Bun.file(fromRoot).exists()) {
      resolvedPath = fromRoot;
    }

    // 3. Bare filename — search entire project for unique match
    if (!resolvedPath && !requestedPath.includes("/")) {
      const glob = new Bun.Glob(`**/${requestedPath}`);
      const matches: string[] = [];
      for await (const match of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
        if (match.includes("node_modules/") || match.includes(".git/")) continue;
        if (match.split("/").pop() === requestedPath) {
          matches.push(resolve(projectRoot, match));
        }
      }
      if (matches.length === 1) {
        resolvedPath = matches[0];
      } else if (matches.length > 1) {
        const relativePaths = matches.map((m) => m.replace(projectRoot + "/", ""));
        return Response.json(
          { error: `Ambiguous filename '${requestedPath}': found ${matches.length} matches`, matches: relativePaths },
          { status: 400 },
        );
      }
    }
  }

  if (!resolvedPath) {
    return Response.json({ error: `File not found: ${requestedPath}` }, { status: 404 });
  }

  // Security: path must stay within projectRoot
  const normalised = resolve(resolvedPath);
  if (!normalised.startsWith(projectRoot + "/") && normalised !== projectRoot) {
    return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
  }

  const file = Bun.file(normalised);
  if (!(await file.exists())) {
    return Response.json({ error: `File not found: ${requestedPath}` }, { status: 404 });
  }

  try {
    const markdown = await file.text();
    return Response.json({ markdown, filepath: normalised });
  } catch {
    return Response.json({ error: "Failed to read file" }, { status: 500 });
  }
}

/** Detect available Obsidian vaults. */
export function handleObsidianVaults(): Response {
  const vaults = detectObsidianVaults();
  return Response.json({ vaults });
}

/** List Obsidian vault files as a nested tree. */
export async function handleObsidianFiles(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const vaultPath = url.searchParams.get("vaultPath");
  if (!vaultPath) {
    return Response.json({ error: "Missing vaultPath parameter" }, { status: 400 });
  }

  const resolvedVault = resolve(vaultPath);
  if (!existsSync(resolvedVault) || !statSync(resolvedVault).isDirectory()) {
    return Response.json({ error: "Invalid vault path" }, { status: 400 });
  }

  try {
    const glob = new Bun.Glob("**/*.md");
    const files: string[] = [];
    for await (const match of glob.scan({ cwd: resolvedVault, onlyFiles: true })) {
      if (match.includes(".obsidian/") || match.includes(".trash/")) continue;
      files.push(match);
    }
    files.sort();

    const tree = buildFileTree(files);
    return Response.json({ tree });
  } catch {
    return Response.json({ error: "Failed to list vault files" }, { status: 500 });
  }
}

/** Read an Obsidian vault document. Supports direct path and bare filename search. */
export async function handleObsidianDoc(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const vaultPath = url.searchParams.get("vaultPath");
  const filePath = url.searchParams.get("path");
  if (!vaultPath || !filePath) {
    return Response.json({ error: "Missing vaultPath or path parameter" }, { status: 400 });
  }
  if (!/\.mdx?$/i.test(filePath)) {
    return Response.json({ error: "Only markdown files are supported" }, { status: 400 });
  }

  const resolvedVault = resolve(vaultPath);
  let resolvedFile = resolve(resolvedVault, filePath);

  // If direct path doesn't exist and it's a bare filename, search the vault
  if (!existsSync(resolvedFile) && !filePath.includes("/")) {
    const glob = new Bun.Glob(`**/${filePath}`);
    const matches: string[] = [];
    for await (const match of glob.scan({ cwd: resolvedVault, onlyFiles: true })) {
      if (match.includes(".obsidian/") || match.includes(".trash/")) continue;
      matches.push(resolve(resolvedVault, match));
    }
    if (matches.length === 1) {
      resolvedFile = matches[0];
    } else if (matches.length > 1) {
      const relativePaths = matches.map((m) => m.replace(resolvedVault + "/", ""));
      return Response.json(
        { error: `Ambiguous filename '${filePath}': found ${matches.length} matches`, matches: relativePaths },
        { status: 400 },
      );
    }
  }

  // Security: must be within vault
  if (!resolvedFile.startsWith(resolvedVault + "/")) {
    return Response.json({ error: "Access denied: path is outside vault" }, { status: 403 });
  }

  try {
    const file = Bun.file(resolvedFile);
    if (!(await file.exists())) {
      return Response.json({ error: `File not found: ${filePath}` }, { status: 404 });
    }
    const markdown = await file.text();
    return Response.json({ markdown, filepath: resolvedFile });
  } catch {
    return Response.json({ error: "Failed to read file" }, { status: 500 });
  }
}
