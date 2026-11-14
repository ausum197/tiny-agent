import path from "node:path";

/** Error raised when a tool tries to reach outside the workspace sandbox. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Resolve `input` against the workspace root and refuse paths that escape it.
 * Returns an absolute path that is guaranteed to be inside `root`.
 */
export function resolveInWorkspace(root: string, input: string | undefined): string {
  const raw = (input ?? "").trim();
  const target = path.resolve(root, raw);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SandboxError(
      `path escapes the workspace sandbox: "${raw}" (workspace: ${root})`,
    );
  }
  return target;
}

/** Workspace-relative display path. */
export function displayPath(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/** Directory names never descended into by the tools. */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".selfcheck"]);

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name === ".DS_Store";
}
