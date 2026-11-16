/**
 * Line diff — Myers O(ND) algorithm, zero dependencies.
 * Same algorithm git uses. Caps: the caller enforces file size; the algorithm
 * bails when the edit distance exceeds `MAX_EFFORT` (files too different to
 * diff cheaply) instead of grinding through O((N+M)²).
 */

export type DiffOp =
  | { type: "same"; aIndex: number; bIndex: number; line: string }
  | { type: "del"; aIndex: number; line: string }
  | { type: "add"; bIndex: number; line: string };

const MAX_EFFORT = 3000;

/**
 * Diff two sequences (e.g. lines of two files). Throws when the edit distance
 * exceeds MAX_EFFORT — deterministic, cheap, fail-closed.
 */
export function diffSequence(a: string[], b: string[]): DiffOp[] {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  if (max === 0) return [];
  if (max > MAX_EFFORT * 2) {
    throw new Error(`files too different to diff cheaply (${N}+${M} lines, limit ${MAX_EFFORT * 2})`);
  }

  // V array, offset by max so k ∈ [-max, max] maps to [0, 2*max]
  const v = new Int32Array(2 * max + 3);
  const base = max + 1;
  const trace: Int32Array[] = [];

  let finishD = -1;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[base + k - 1]! < v[base + k + 1]!)) x = v[base + k + 1]!;
      else x = v[base + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[base + k] = x;
      if (x >= N && y >= M) {
        finishD = d;
        break;
      }
    }
    if (finishD >= 0) break;
  }
  if (finishD < 0) throw new Error("diff failed to converge");

  // backtrack the path into ops
  const ops: DiffOp[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[base + k - 1]! < vd[base + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[base + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: "same", aIndex: x, bIndex: y, line: a[x] ?? "" });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ type: "add", bIndex: y, line: b[y] ?? "" });
      } else {
        x -= 1;
        ops.push({ type: "del", aIndex: x, line: a[x] ?? "" });
      }
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface UnifiedDiff {
  text: string; // "" when identical
  additions: number;
  deletions: number;
}

/** Format ops as a unified diff with `context` lines of context (git-style headers). */
export function unifiedDiff(a: string[], b: string[], aName: string, bName: string, context: number): UnifiedDiff {
  const ops = diffSequence(a, b);
  const additions = ops.filter((op) => op.type === "add").length;
  const deletions = ops.filter((op) => op.type === "del").length;
  if (additions === 0 && deletions === 0) return { text: "", additions: 0, deletions: 0 };

  const changed = ops.map((op, i) => (op.type === "same" ? -1 : i)).filter((i) => i >= 0);
  const groups: Array<[number, number]> = [];
  let groupStart = changed[0]!;
  let groupEnd = changed[0]!;
  for (const i of changed.slice(1)) {
    if (i - groupEnd <= context * 2) groupEnd = i;
    else {
      groups.push([groupStart, groupEnd]);
      groupStart = groupEnd = i;
    }
  }
  groups.push([groupStart, groupEnd]);

  const out: string[] = [`--- ${aName}`, `+++ ${bName}`];
  for (const [gs, ge] of groups) {
    const from = Math.max(0, gs - context);
    const to = Math.min(ops.length - 1, ge + context);
    // single pass to the end of the hunk, capturing header positions
    let pa = 1;
    let pb = 1;
    let headerA = 1;
    let headerB = 1;
    let countA = 0;
    let countB = 0;
    for (let i = 0; i <= to; i += 1) {
      const op = ops[i]!;
      if (i === from) {
        headerA = pa;
        headerB = pb;
      }
      if (i >= from) {
        if (op.type !== "add") countA += 1;
        if (op.type !== "del") countB += 1;
      }
      if (op.type !== "add") pa += 1;
      if (op.type !== "del") pb += 1;
    }
    out.push(`@@ -${headerA},${countA} +${headerB},${countB} @@`);
    for (let i = from; i <= to; i += 1) {
      const op = ops[i]!;
      if (op.type === "same") out.push(` ${op.line}`);
      else if (op.type === "del") out.push(`-${op.line}`);
      else out.push(`+${op.line}`);
    }
  }
  return { text: out.join("\n"), additions, deletions };
}
