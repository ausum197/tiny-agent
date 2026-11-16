import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { INTERNAL_DIR, SKIP_DIRS, shouldSkipDir } from "./paths.ts";

/**
 * Level 1 — per-run snapshots. Before every agent run the workspace is captured
 * into `.tinyagent/runs/<id>/` (APFS clonefile via fs.cp, so copies are
 * copy-on-write and effectively free) with a content-hashed manifest. The agent
 * gets `undo_run` (revert the most recent run's changes) and `diff_run` (what
 * did that run change). `.tinyagent` is off-limits to the file tools, so the
 * agent can not eat its own undo history.
 */

const MAX_FILE_BYTES = 8 * 1024 * 1024; // snapshots are for source, not datasets
const KEEP_RUNS = 5;

export interface SnapshotEntry {
  path: string; // workspace-relative, /-separated
  hash: string; // sha256 of content
  size: number;
}

export interface RunSnapshot {
  id: string;
  ts: number;
  entries: SnapshotEntry[];
  skipped: { path: string; reason: string }[];
}

const runsDir = (root: string): string => path.join(root, INTERNAL_DIR, "runs");

function hashContent(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/** Walk the workspace (same skip rules as the file tools) and return file entries. */
async function walkWorkspace(root: string): Promise<{ abs: string; rel: string }[]> {
  const out: { abs: string; rel: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name);
        out.push({ abs, rel: path.relative(root, abs).split(path.sep).join("/") });
      }
    }
  };
  await walk(root);
  return out;
}

async function entryFor(root: string, abs: string, rel: string): Promise<SnapshotEntry | { skipped: { path: string; reason: string } }> {
  const stat = await fs.stat(abs);
  if (stat.size > MAX_FILE_BYTES) {
    return { skipped: { path: rel, reason: `too large (${stat.size} bytes, limit ${MAX_FILE_BYTES})` } };
  }
  const buffer = await fs.readFile(abs);
  return { path: rel, hash: hashContent(buffer), size: stat.size };
}

/** Capture a pre-run snapshot. Call before each agent run (one prompt = one run). */
export async function snapshotRun(root: string): Promise<RunSnapshot> {
  const id = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "-" + crypto.randomBytes(3).toString("hex");
  const dir = path.join(runsDir(root), id);
  const dataDir = path.join(dir, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const entries: SnapshotEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const { abs, rel } of await walkWorkspace(root)) {
    const result = await entryFor(root, abs, rel);
    if ("skipped" in result) {
      skipped.push(result.skipped);
      continue;
    }
    entries.push(result);
    const dest = path.join(dataDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(abs, dest); // clonefile on APFS: CoW, no data copied until write
  }

  const snapshot: RunSnapshot = { id, ts: Date.now(), entries, skipped };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(snapshot, null, 2));
  await pruneRuns(root);
  return snapshot;
}

async function pruneRuns(root: string): Promise<void> {
  const dir = runsDir(root);
  const runs = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  while (runs.length > KEEP_RUNS) {
    const oldest = runs.shift();
    if (oldest !== undefined) await fs.rm(path.join(dir, oldest), { recursive: true, force: true });
  }
}

export interface RunDiff {
  snapshotId: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[]; // skipped from the snapshot (size cap) — state unknown
}

/** Compare a snapshot manifest with the current workspace. */
export async function diffRun(root: string, snapshot: RunSnapshot): Promise<RunDiff> {
  const before = new Map(snapshot.entries.map((entry) => [entry.path, entry.hash]));
  const diff: RunDiff = { snapshotId: snapshot.id, modified: [], added: [], deleted: [], untracked: snapshot.skipped.map((s) => s.path) };
  const seen = new Set<string>();
  for (const { abs, rel } of await walkWorkspace(root)) {
    seen.add(rel);
    const entry = await entryFor(root, abs, rel);
    if ("skipped" in entry) continue;
    if (!before.has(rel)) diff.added.push(rel);
    else if (before.get(rel) !== entry.hash) diff.modified.push(rel);
  }
  for (const entryPath of before.keys()) {
    if (!seen.has(entryPath)) diff.deleted.push(entryPath);
  }
  return diff;
}

/** Restore the workspace to a snapshot: revert modified/deleted, remove agent-created files. */
export async function restoreRun(root: string, snapshot: RunSnapshot): Promise<RunDiff> {
  const diff = await diffRun(root, snapshot);
  const dataDir = path.join(runsDir(root), snapshot.id, "data");

  for (const rel of [...diff.modified, ...diff.deleted]) {
    const dest = path.join(dataDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(dest, path.join(root, rel));
  }
  for (const rel of diff.added) {
    // Agent-created: remove. Walked paths only — never rm -rf anything we did not walk.
    await fs.rm(path.join(root, rel), { force: true });
  }
  return diff;
}

/** Load the newest snapshot manifest, or null when none exists. */
export async function latestSnapshot(root: string): Promise<RunSnapshot | null> {
  const dir = runsDir(root);
  let runs: string[];
  try {
    runs = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return null;
  }
  const newest = runs.at(-1);
  if (newest === undefined) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(dir, newest, "manifest.json"), "utf8")) as RunSnapshot;
  } catch {
    return null;
  }
}

/** Load a snapshot manifest by id, or null. */
export async function loadSnapshot(root: string, id: string): Promise<RunSnapshot | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(runsDir(root), id, "manifest.json"), "utf8")) as RunSnapshot;
  } catch {
    return null;
  }
}

export function formatDiff(diff: RunDiff): string {
  const lines = [`run ${diff.snapshotId}: ${diff.modified.length} modified, ${diff.added.length} added, ${diff.deleted.length} deleted`];
  for (const rel of diff.modified) lines.push(`  M ${rel}`);
  for (const rel of diff.added) lines.push(`  A ${rel}`);
  for (const rel of diff.deleted) lines.push(`  D ${rel}`);
  for (const rel of diff.untracked) lines.push(`  ? ${rel} (untracked)`);
  return lines.join("\n");
}

export { SKIP_DIRS };
