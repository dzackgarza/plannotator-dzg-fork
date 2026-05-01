import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export const bunExecutable = Bun.which("bun") ?? "bun";

export function noopBrowserExecutable(): string {
  return Bun.which("true") ?? "/usr/bin/true";
}
