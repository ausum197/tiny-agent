import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { INTERNAL_DIR } from "./paths.ts";

/**
 * Levels 2 + 3 — per-tool mutation journal (event-sourced).
 *
 * Every mutating file tool appends a journal record with the full `before`
 * content (inline under 256 KiB, else a content-addressed blob) BEFORE it
 * mutates. `undo_last_edit` restores the most recent not-undone mutation's
 * before-state; `redo_last_edit` re-applies the most recent undone mutation's
 * forward operation. The journal is append-only JSONL — the state of each
 * mutation (applied/undone) is itself an event, so undo/redo survives
 * restarts. `run_ts` side effects are intentionally not journaled per tool;
 * they are covered by the per-run snapshot.
 */

const INLINE_LIMIT = 256 * 1024;

export type MutationTool = "write_file" | "edit_file";

export interface MutationRecord {
  seq: number;
  ts: number;
  kind: "mutation";
  tool: MutationTool;
  path: string; // workspace-relative
  before: { content: string | null; blob?: string }; // content null + no blob = file did not exist
  args: { path: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean };
}

export interface MarkerRecord {
  seq: number;
  ts: number;
  kind: "undo" | "redo";
  target: number; // seq of the mutation record
}

export type JournalRecord = MutationRecord | MarkerRecord;

const journalPath = (root: string): string => path.join(root, INTERNAL_DIR, "journal.jsonl");
const blobsDir = (root: string): string => path.join(root, INTERNAL_DIR, "blobs");

async function readAll(root: string): Promise<JournalRecord[]> {
  try {
    const text = await fs.readFile(journalPath(root), "utf8");
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as JournalRecord);
  } catch {
    return [];
  }
}

type WithoutSeq<T> = T extends unknown ? Omit<T, "seq" | "ts"> : never;

async function append(root: string, record: WithoutSeq<JournalRecord>): Promise<JournalRecord> {
  const all = await readAll(root);
  const seq = all.length === 0 ? 1 : all.at(-1)!.seq + 1;
  const full = { ...record, ts: Date.now(), seq } as JournalRecord;
  await fs.mkdir(path.dirname(journalPath(root)), { recursive: true });
  await fs.appendFile(journalPath(root), `${JSON.stringify(full)}\n`);
  return full;
}

/** Effective applied-state of each mutation after replaying all markers. */
function appliedSeqs(records: JournalRecord[]): Set<number> {
  const applied = new Set<number>();
  for (const record of records) {
    if (record.kind === "mutation") applied.add(record.seq);
    else if (record.kind === "undo") applied.delete(record.target);
    else if (record.kind === "redo") applied.add(record.target);
  }
  return applied;
}

/** Record the pre-mutation state of `relPath`. Call BEFORE the mutation happens. */
export async function recordMutation(
  root: string,
  tool: MutationTool,
  args: MutationRecord["args"],
  relPath: string,
): Promise<void> {
  let before: MutationRecord["before"];
  try {
    const raw = await fs.readFile(path.join(root, relPath), "utf8");
    if (Buffer.byteLength(raw, "utf8") <= INLINE_LIMIT) {
      before = { content: raw };
    } else {
      const blob = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
      await fs.mkdir(blobsDir(root), { recursive: true });
      await fs.writeFile(path.join(blobsDir(root), blob), raw);
      before = { content: null, blob };
    }
  } catch {
    before = { content: null }; // did not exist
  }
  await append(root, { kind: "mutation", tool, path: relPath, before, args });
}

async function readBefore(root: string, record: MutationRecord): Promise<string | null> {
  if (record.before.content !== null) return record.before.content;
  if (record.before.blob !== undefined) {
    try {
      return await fs.readFile(path.join(blobsDir(root), record.before.blob), "utf8");
    } catch {
      return null;
    }
  }
  return null; // did not exist
}

/** Undo the most recent applied mutation. Returns a human summary, or null when nothing to undo. */
export async function undoLastMutation(root: string): Promise<string | null> {
  const records = await readAll(root);
  const applied = appliedSeqs(records);
  const bySeq = new Map(records.filter((r): r is MutationRecord => r.kind === "mutation").map((r) => [r.seq, r]));
  const target = [...applied].sort((a, b) => b - a).map((seq) => bySeq.get(seq)).find((r) => r !== undefined);
  if (target === undefined) return null;

  const before = await readBefore(root, target);
  const abs = path.join(root, target.path);
  if (before === null) {
    await fs.rm(abs, { force: true }); // it did not exist before: remove it again
  } else {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, before, "utf8");
  }
  const marker = await append(root, { kind: "undo", target: target.seq });
  return `undone: ${target.tool} ${target.path} (record ${target.seq})`;
}

/** Re-apply the most recent undone mutation. Returns a human summary, or null. */
export async function redoLastMutation(root: string): Promise<string | null> {
  const records = await readAll(root);
  const applied = appliedSeqs(records);
  const target = records
    .filter((r): r is MutationRecord => r.kind === "mutation")
    .filter((m) => !applied.has(m.seq))
    .at(-1);
  if (target === undefined) return null;

  await applyForward(root, target);
  const marker = await append(root, { kind: "redo", target: target.seq });
  return `redone: ${target.tool} ${target.path} (record ${target.seq})`;
}

/** The forward operation of a mutation, re-appliable. This is the level-3 event source. */
export async function applyForward(root: string, record: MutationRecord): Promise<void> {
  const abs = path.join(root, record.args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (record.tool === "write_file") {
    await fs.writeFile(abs, record.args.content ?? "", "utf8");
    return;
  }
  const current = await fs.readFile(abs, "utf8");
  const updated = record.args.replace_all === true
    ? current.replaceAll(record.args.old_string ?? "", record.args.new_string ?? "")
    : current.replace(record.args.old_string ?? "", record.args.new_string ?? "");
  await fs.writeFile(abs, updated, "utf8");
}
