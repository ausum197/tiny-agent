import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { diffRun, formatDiff, latestSnapshot, loadSnapshot, restoreRun } from "./snapshots.ts";
import { undoLastMutation, redoLastMutation } from "./journal.ts";

/**
 * Reversibility tools: per-run snapshots (undo_run, diff_run) and the
 * event-sourced per-tool journal (undo_last_edit, redo_last_edit).
 */

type TextResult = { content: [{ type: "text"; text: string }]; details: Record<string, unknown>; isError?: boolean };

function ok(text: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: "text", text }], details };
}

function fail(message: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], details: { ...details, error: message }, isError: true };
}

const snapshotIdParams = obj({
  run_id: opt(str({ description: "Snapshot id to inspect/restore. Default: the most recent one." })),
});

const emptyParams = obj({});

export function makeReversibilityTools(root: string): AgentTool<any>[] {
  const undo_run: AgentTool<typeof snapshotIdParams> = {
    name: "undo_run",
    label: "Undo Run",
    description:
      "Revert the workspace to how it was just before an agent run started (default: the most recent run). Removes files that run created, restores files it changed or deleted. Use when a run made things worse.",
    parameters: snapshotIdParams,
    execute: async (_id, params) => {
      try {
        const snapshot = params.run_id !== undefined ? await loadSnapshot(root, params.run_id) : await latestSnapshot(root);
        if (snapshot === null) return fail("no such snapshot (or none exist) — nothing to undo");
        const diff = await restoreRun(root, snapshot);
        return ok(`reverted to pre-run state.\n${formatDiff(diff)}`, { ...diff });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const diff_run: AgentTool<typeof snapshotIdParams> = {
    name: "diff_run",
    label: "Diff Run",
    description:
      "Show what changed since the snapshot taken before an agent run (default: the most recent one): modified, added, deleted files. Read-only.",
    parameters: snapshotIdParams,
    execute: async (_id, params) => {
      try {
        const snapshot = params.run_id !== undefined ? await loadSnapshot(root, params.run_id) : await latestSnapshot(root);
        if (snapshot === null) return fail("no such snapshot (or none exist)");
        const diff = await diffRun(root, snapshot);
        return ok(formatDiff(diff), { ...diff });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const undo_last_edit: AgentTool<typeof emptyParams> = {
    name: "undo_last_edit",
    label: "Undo Edit",
    description:
      "Revert the most recent write_file/edit_file mutation (steps back one edit; call repeatedly to step back further). Does not cover run_ts side effects — use undo_run for those.",
    parameters: obj({}),
    execute: async () => {
      try {
        const summary = await undoLastMutation(root);
        return summary === null ? fail("nothing to undo") : ok(summary);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const redo_last_edit: AgentTool<typeof emptyParams> = {
    name: "redo_last_edit",
    label: "Redo Edit",
    description: "Re-apply the most recently undone write_file/edit_file mutation.",
    parameters: obj({}),
    execute: async () => {
      try {
        const summary = await redoLastMutation(root);
        return summary === null ? fail("nothing to redo") : ok(summary);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [undo_run, diff_run, undo_last_edit, redo_last_edit];
}
