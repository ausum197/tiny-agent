import fs from "node:fs/promises";
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

/**
 * Symlink-safe resolution. Like `resolveInWorkspace`, but after the string-level
 * check it also real-resolves the target and re-checks containment, so a symlink
 * (or a symlinked ancestor directory) inside the workspace that points outside
 * the root is rejected instead of silently followed.
 *
 * For a not-yet-existing target (e.g. `write_file` of a new file), the nearest
 * existing ancestor is real-resolved and the missing suffix re-checked.
 */
export async function resolveReal(root: string, input: string | undefined): Promise<string> {
  const target = resolveInWorkspace(root, input);
  // The agent must never read or write its own undo history (same rule as .git).
  const rel = path.relative(root, target);
  if (rel === INTERNAL_DIR || rel.startsWith(`${INTERNAL_DIR}${path.sep}`) || rel.split(path.sep)[0] === ".git") {
    throw new SandboxError(`"${input ?? "."}" is internal to the agent and off-limits`);
  }
  const realRoot = await fs.realpath(root);

  let current = target;
  const suffix: string[] = [];
  for (;;) {
    let real: string;
    try {
      real = await fs.realpath(current);
    } catch {
      // Does not exist (yet): real-resolve the nearest existing ancestor instead.
      const parent = path.dirname(current);
      if (parent === current) {
        throw new SandboxError(`cannot resolve "${input ?? "."}" within the workspace`);
      }
      suffix.push(path.basename(current));
      current = parent;
      continue;
    }
    const result = suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
    const rel = path.relative(realRoot, result);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new SandboxError(
        `path escapes the workspace sandbox via symlink: "${input ?? "."}" (workspace: ${root})`,
      );
    }
    return result;
  }
}

/** Directory names never descended into by the tools. */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".selfcheck", ".tinyagent"]);

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name === ".DS_Store";
}

/** Internal directory where reversibility state lives (snapshots, journal, blobs). */
export const INTERNAL_DIR = ".tinyagent";
