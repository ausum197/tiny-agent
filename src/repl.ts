import process from "node:process";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Config, ProviderId } from "./config.ts";
import { providerName } from "./agent.ts";
import { snapshotRun } from "./snapshots.ts";
import type { Sidecar } from "./sidecar.ts";

interface PlanDrafter {
  draft: (request: string, files: string[]) => Promise<string>;
  abort: () => void;
}

/**
 * Fullscreen REPL — fixed-grid full-repaint loop, no framework.
 *
 * Alternate screen (scrollback restored on exit); every 80 ms the entire grid
 * is rewritten from state with absolute positioning + synchronized output:
 * nothing can persist between frames, so residue is mathematically impossible.
 *
 * Composer: bracketed-paste aware. Large pastes collapse to `[Pasted #N +L lines]`
 * tokens; moving the cursor onto a token expands it inline; editing inside it
 * dissolves it back to raw text (OpenCode behavior). Enter submits with all
 * tokens expanded.
 *
 * Keys: Enter send · ↑/↓ input history · PgUp/PgDn scroll transcript ·
 * Ctrl+C abort run (twice exits) · Ctrl+D exit.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;
const DOUBLE_CTRL_C_MS = 600;
const INPUT_ROWS = 5; // fixed composer height (constant frame ⇒ no shifts)
const PASTE_COLLAPSE_LINES = 3; // pastes bigger than this collapse to a token
const PASTE_COLLAPSE_CHARS = 300;
const CLEAR = "\x1b[2K";

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function compactArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const text = typeof value === "string" ? (value.length > 60 ? `${value.slice(0, 57)}…` : value) : value;
    parts.push(`${key}=${JSON.stringify(text)}`);
  }
  return parts.join(" ");
}

interface Block {
  kind: "user" | "assistant" | "tool" | "seconds" | "info";
  text: string;
}

/** ANSI helpers. */
const CYAN = (s: string) => `\x1b[36m${s}\x1b[22m`;
const GRAY = (s: string) => `\x1b[90m${s}\x1b[22m`;
const WHITE = (s: string) => `\x1b[37m${s}\x1b[22m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[22m`;
const FAINT = (s: string) => `\x1b[2;90m${s}\x1b[22m`; // faint + gray = ultra dim

/** Display width of one code point (wide CJK/fullwidth/emoji ranges count as 2 columns). */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  ) return 2;
  return 1;
}

/** Wrap `text` to `cols` display columns, preserving explicit newlines. */
function wrapLines(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    let width = 0;
    for (const ch of paragraph) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (width + w > cols && line !== "") {
        out.push(line);
        line = "";
        width = 0;
      }
      line += ch;
      width += w;
    }
    out.push(line);
  }
  return out;
}

export async function runRepl(
  agent: Agent,
  cfg: Config,
  provider: ProviderId,
  sidecar?: Sidecar,
  planDrafter?: PlanDrafter,
): Promise<void> {
  const state = {
    blocks: [] as Block[],
    streamText: "",
    status: null as string | null,
    startedAt: null as number | null,
    frame: 0,
    scrollUp: 0,
    running: false,
    sidecarLine: null as string | null,
    sidecarRoute: null as string | null,
    prerender: null as { plan: string; draft: string } | null,
    prerenderBusy: false,
    prerenderRequest: "",
    lastPrerenderAt: 0,
    stableTicks: 0,
    lastBufSeen: "",
    fileList: [] as string[],
  };

  // composer state: raw buffer + cursor (code-point offset) + paste slots
  const ed = {
    buf: "",
    cur: 0,
    history: [] as string[],
    historyIndex: -1,
    pastes: new Map<number, string>(),
    seq: 0,
  };
  let lastCtrlC = 0;

  const cols = (): number => process.stdout.columns || 80;
  const rows = (): number => process.stdout.rows || 24;

  const say = (text: string): void => {
    state.blocks.push({ kind: "info", text });
  };

  const endTurn = (): void => {
    if (state.startedAt !== null) {
      state.blocks.push({ kind: "seconds", text: formatSeconds(Date.now() - state.startedAt) });
      state.startedAt = null;
    }
    state.streamText = "";
    state.status = null;
    state.running = false;
  };

  agent.subscribe((event: any) => {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") state.streamText += e.delta;
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant" && state.streamText !== "") {
          state.blocks.push({ kind: "assistant", text: state.streamText });
          state.streamText = "";
        }
        break;
      }
      case "tool_execution_start": {
        state.blocks.push({ kind: "tool", text: `⚙ ${event.toolName} ${compactArgs(event.args)}` });
        state.status = `${event.toolName}…`;
        break;
      }
      case "tool_execution_end": {
        const mark = event.isError ? RED("✗") : `\x1b[32m✓\x1b[22m`;
        const dur = event.durationMs !== undefined ? GRAY(` (${formatSeconds(event.durationMs)})`) : "";
        const last = [...state.blocks].reverse().find((b) => b.kind === "tool");
        if (last !== undefined) last.text = `${last.text} ${mark}${dur}`;
        state.status = "thinking…";
        break;
      }
      case "turn_end":
        endTurn();
        break;
      default:
        break;
    }
  });

  // ——— editor helpers ———

  interface TokenRange { start: number; end: number; id: number }

  /** Code-point ranges of paste tokens in `buf` (ordered). */
  const tokenRanges = (buf: string): TokenRange[] => {
    const ranges: TokenRange[] = [];
    const re = /\[Pasted #(\d+) \+[^\]]*\]/g;
    const cpLen = (s: string): number => [...s].length;
    let rawOffset = 0;
    let cpOffset = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf)) !== null) {
      cpOffset += cpLen(buf.slice(rawOffset, m.index));
      rawOffset = m.index + m[0].length;
      const start = cpOffset;
      ranges.push({ start, end: start + cpLen(m[0]), id: Number(m[1]) });
      cpOffset += cpLen(m[0]);
    }
    return ranges;
  };

  /** Replace the buffer content, code-point safe. */
  const setBuf = (points: string[]): void => {
    ed.buf = points.join("");
  };
  const pointsOf = (s: string): string[] => [...s];

  /** Insert raw text at the cursor (typed characters). Dissolves a paste token if the cursor is inside one. */
  const insertAtCursor = (text: string): void => {
    const pts = pointsOf(ed.buf);
    for (const range of tokenRanges(ed.buf)) {
      if (ed.cur > range.start && ed.cur < range.end) {
        const content = ed.pastes.get(range.id);
        if (content !== undefined) {
          pts.splice(range.start, range.end - range.start, ...pointsOf(content));
          ed.pastes.delete(range.id);
          ed.cur = range.start + [...content].length;
          setBuf(pts);
          return insertAtCursor(text); // re-locate cursor position after dissolve
        }
      }
    }
    pts.splice(ed.cur, 0, ...pointsOf(text));
    ed.cur += pointsOf(text).length;
    setBuf(pts);
  };

  /** Expand every paste token in `buf` to its raw content (what the agent receives). */
  const expandAll = (buf: string): string =>
    buf.replace(/\[Pasted #(\d+) \+[^\]]*\]/g, (match, id: string) => ed.pastes.get(Number(id)) ?? match);

  /** Collapse marker used in the transcript for submitted pastes. */
  const collapseForTranscript = (text: string): string =>
    text.replace(/\[Pasted #(\d+) \+[^\]]*\]/g, (_m, id: string) => {
      const content = ed.pastes.get(Number(id));
      const lines = content !== undefined ? content.split("\n").length : 0;
      return `[paste #${id}: ${lines} lines]`;
    });

  const handlePaste = (text: string): void => {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const lineCount = normalized.split("\n").length;
    if (lineCount >= PASTE_COLLAPSE_LINES || normalized.length > PASTE_COLLAPSE_CHARS) {
      ed.seq += 1;
      ed.pastes.set(ed.seq, normalized);
      insertAtCursor(`[Pasted #${ed.seq} +${lineCount} lines]`);
    } else {
      insertAtCursor(normalized);
    }
  };

  // ——— run loop ———

  const runPrompt = async (input: string): Promise<void> => {
    state.running = true;
    state.scrollUp = 0;
    state.status = "snapshotting…";
    state.startedAt = Date.now();
    try {
      await snapshotRun(cfg.workspace);
    } catch {
      // snapshot failure must not block the run
    }
    state.status = "thinking…";
    try {
      await agent.prompt(input);
      await agent.waitForIdle();
    } catch (err) {
      if (agent.signal?.aborted) say("[aborted]");
      else say(`error: ${err instanceof Error ? err.message : String(err)}`);
      endTurn();
    }
  };

  const exit = (): void => {
    process.stdout.write("\x1b[r\x1b[?2026l\x1b[?25h\x1b[?2004l\x1b[?1049l"); // reset region/sync/cursor/paste, leave alt screen
    process.stdin.setRawMode(false);
    process.stdin.pause();
    setTimeout(() => process.exit(0), 100);
  };

  const submit = (): void => {
    const expanded = expandAll(ed.buf).trim();
    const displayText = collapseForTranscript(ed.buf);
    if (expanded === "" || state.running) return;
    ed.history.push(expanded);
    ed.historyIndex = -1;
    ed.buf = "";
    ed.cur = 0;
    if (expanded.startsWith("/")) {
      const [command] = expanded.split(/\s+/);
      switch (command) {
        case "/quit":
        case "/exit":
          exit();
          return;
        case "/help":
          say("/tools  /reset  /pwd  /quit");
          break;
        case "/pwd":
          say(cfg.workspace);
          break;
        case "/tools":
          for (const tool of agent.state.tools) say(`${tool.name.padEnd(18)} ${tool.description}`);
          break;
        case "/reset":
          agent.reset();
          say("conversation cleared");
          break;
        case "/model":
          say(`model is chosen at startup via --model (current: ${agent.state.model.id})`);
          break;
        default:
          say(`unknown command ${command} (try /help)`);
      }
      return;
    }
    // attach a prerendered plan when it matches this exact draft
    let toSend = expanded;
    if (state.prerender !== null && state.prerender.draft === expanded) {
      const plan = state.prerender.plan;
      toSend = `${expanded}\n\n---\nA plan has already been prepared for this request (sidecar preview). Verify it, correct anything wrong, then follow it instead of re-exploring:\n${plan}`;
      state.blocks.push({ kind: "info", text: `◇ prerendered plan attached (${plan.split("\n").length} steps)` });
      state.prerender = null;
    }
    // transcript shows the collapsed form; the agent receives the expanded text
    state.blocks.push({ kind: "user", text: displayText });
    state.sidecarLine = null; // stale assertion — the draft it described is gone
    void runPrompt(toSend);
  };

  const handleKey = (key: string): void => {
    // Ctrl+C: legacy \x03, or CSI-u under the kitty keyboard protocol (\x1b[99;5u)
    const isCtrlC = key === "\x03" || key === "\x1b[99;5u";
    const isCtrlD = key === "\x04" || key === "\x1b[100;5u";
    if (isCtrlC) {
      // Ctrl+C: abort a running turn; double-press to exit when idle
      if (state.running) {
        agent.abort();
        state.status = "aborting…";
        return;
      }
      const now = Date.now();
      if (now - lastCtrlC < DOUBLE_CTRL_C_MS) exit();
      else {
        lastCtrlC = now;
        say("(press Ctrl+C again to exit)");
      }
      return;
    }
    if (isCtrlD) {
      exit();
      return;
    }
    if (key === "\x1b[5~") {
      state.scrollUp += Math.max(3, Math.floor(rows() / 2));
      return;
    }
    if (key === "\x1b[6~") {
      state.scrollUp = Math.max(0, state.scrollUp - Math.max(3, Math.floor(rows() / 2)));
      return;
    }
    // Shift+Enter (kitty protocol CSI-u): steer mid-run, newline when idle
    if (key === "\x1b[13;2u") {
      if (state.running) {
        const expanded = expandAll(ed.buf).trim();
        if (expanded === "") return;
        const displayText = collapseForTranscript(ed.buf);
        agent.steer({ role: "user", content: expanded, timestamp: Date.now() });
        state.blocks.push({ kind: "info", text: `↳ steered: ${displayText}` });
        ed.buf = "";
        ed.cur = 0;
        return;
      }
      insertAtCursor("\n");
      return;
    }
    if (key === "\r" || key === "\n") {
      if (state.running) {
        // Enter mid-run queues the message: delivered when the agent would stop
        const expanded = expandAll(ed.buf).trim();
        if (expanded === "") return;
        const displayText = collapseForTranscript(ed.buf);
        agent.followUp({ role: "user", content: expanded, timestamp: Date.now() });
        state.blocks.push({ kind: "info", text: `⤺ queued: ${displayText}` });
        ed.buf = "";
        ed.cur = 0;
        return;
      }
      submit();
      return;
    }
    if (key === "\x7f" && !state.running) {
      // backspace: dissolve a paste token if the cursor is inside one, else delete a char
      const pts = pointsOf(ed.buf);
      for (const range of tokenRanges(ed.buf)) {
        if (ed.cur > range.start && ed.cur <= range.end) {
          const content = ed.pastes.get(range.id);
          pts.splice(range.start, range.end - range.start, ...(content !== undefined ? pointsOf(content) : []));
          if (content !== undefined) ed.pastes.delete(range.id);
          ed.cur = range.start + (content !== undefined ? pointsOf(content).length : 0);
          setBuf(pts);
          return;
        }
      }
      if (ed.cur > 0) {
        pts.splice(ed.cur - 1, 1);
        ed.cur -= 1;
        setBuf(pts);
      }
      return;
    }
    if (key === "\x1b[D") {
      if (ed.cur > 0) ed.cur -= 1;
      return;
    }
    if (key === "\x1b[C") {
      if (ed.cur < pointsOf(ed.buf).length) ed.cur += 1;
      return;
    }
    if (key === "\x1b[A") {
      if (state.running) return;
      if (ed.history.length === 0) return;
      if (ed.historyIndex === -1) ed.historyIndex = ed.history.length;
      ed.historyIndex = Math.max(0, ed.historyIndex - 1);
      ed.buf = ed.history[ed.historyIndex] ?? "";
      ed.cur = pointsOf(ed.buf).length;
      return;
    }
    if (key === "\x1b[B") {
      if (state.running) return;
      if (ed.historyIndex === -1) return;
      ed.historyIndex += 1;
      if (ed.historyIndex >= ed.history.length) {
        ed.historyIndex = -1;
        ed.buf = "";
      } else {
        ed.buf = ed.history[ed.historyIndex] ?? "";
      }
      ed.cur = pointsOf(ed.buf).length;
      return;
    }
    if (key.startsWith("\x1b")) return; // other escapes ignored
    if (key < " " && key !== "\t") return; // other control chars (tab inserts nothing)
    insertAtCursor(key === "\t" ? "  " : key);
  };

  // ——— bracketed paste ———
  let pasteMode = false;
  let pasteBuf = "";
  const onData = (chunk: string): void => {
    if (pasteMode) {
      pasteBuf += chunk;
      const end = pasteBuf.indexOf("\x1b[201~");
      if (end === -1) return;
      handlePaste(pasteBuf.slice(0, end));
      const rest = pasteBuf.slice(end + 6);
      pasteMode = false;
      pasteBuf = "";
      if (rest !== "") onData(rest);
      return;
    }
    const marker = chunk.indexOf("\x1b[200~");
    if (marker === -1) {
      for (const key of parseKeys(chunk)) handleKey(key);
      return;
    }
    for (const key of parseKeys(chunk.slice(0, marker))) handleKey(key);
    const rest = chunk.slice(marker + 6);
    const end = rest.indexOf("\x1b[201~");
    if (end === -1) {
      pasteMode = true;
      pasteBuf = rest;
      return;
    }
    handlePaste(rest.slice(0, end));
    const after = rest.slice(end + 6);
    if (after !== "") onData(after);
  };

  /** Split a raw stdin chunk into single keys; escape sequences stay whole. */
  function parseKeys(data: string): string[] {
    const keys: string[] = [];
    let i = 0;
    while (i < data.length) {
      if (data[i] === "\x1b") {
        const rest = data.slice(i);
        const match = rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
        if (match) {
          keys.push(match[0]);
          i += match[0].length;
        } else {
          keys.push("\x1b");
          i += 1;
        }
      } else {
        keys.push(data[i]!);
        i += 1;
      }
    }
    return keys;
  }

  const onResize = (): void => {
    // no clear needed: the next full-repaint frame rewrites every row in place
  };

  // workspace file list for the plan drafter (cheap, deterministic, read-only)
  void (async (): Promise<void> => {
    const { shouldSkipDir } = await import("./paths.ts");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= 400) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (shouldSkipDir(entry.name) || entry.name === ".tmp") continue;
          await walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          out.push(path.relative(cfg.workspace, path.join(dir, entry.name)).split(path.sep).join("/"));
        }
      }
    };
    try {
      await walk(cfg.workspace);
    } catch {
      /* file list is best-effort */
    }
    state.fileList = out;
  })();

  // ——— drawing ———

  const draw = (): void => {
    const width = cols() - 1; // safety column: no line ever hits auto-wrap
    const height = rows();

    // transcript → wrapped lines
    const lines: string[] = [];
    const push = (text: string, colorFn: (s: string) => string): void => {
      for (const chunk of wrapLines(text, width)) lines.push(colorFn(chunk));
    };
    for (const block of state.blocks) {
      if (block.kind === "user") push(`› ${collapseForTranscript(block.text)}`, CYAN);
      else if (block.kind === "assistant") push(block.text, WHITE);
      else if (block.kind === "tool") push(block.text, GRAY);
      else if (block.kind === "seconds") lines.push(FAINT(block.text));
      else push(block.text, GRAY);
    }
    if (state.streamText !== "") push(state.streamText, WHITE);

    const visibleRowsBase = height - 1 - INPUT_ROWS; // status row + composer
    // prerendered plan preview rows (dim), above the status row
    let previewRows: string[] = [];
    if (state.prerender !== null) {
      const header = `◇ prerendered plan — enter runs it`;
      previewRows.push(GRAY(header));
      const planLines = wrapLines(state.prerender.plan, width).slice(0, 6);
      for (const pl of planLines) previewRows.push(GRAY(`  ${pl}`));
      if (wrapLines(state.prerender.plan, width).length > 6) previewRows.push(GRAY("  …"));
    }
    const visibleRows = visibleRowsBase - previewRows.length;
    state.scrollUp = Math.min(state.scrollUp, Math.max(0, lines.length - visibleRows));
    const start = Math.max(0, lines.length - visibleRows - state.scrollUp);
    const view = lines.slice(start, start + visibleRows);
    while (view.length < visibleRows) view.push("");
    while (view.length < visibleRows) view.push("");

    const frameIdx = state.frame % SPINNER_FRAMES.length;
    const elapsed = state.startedAt !== null ? formatSeconds(Date.now() - state.startedAt) : "";
    const statusText = state.running
      ? `${CYAN(SPINNER_FRAMES[frameIdx] + " ")}${GRAY(state.status ?? "")}${FAINT(` ${elapsed}`.trimEnd())}${state.sidecarRoute ? GRAY(`  ◇ ${state.sidecarRoute}`) : ""}`
      : state.prerender !== null
        ? GRAY("◇ plan ready — enter to run it")
        : state.sidecarLine !== null && state.sidecarLine !== ""
          ? GRAY(state.sidecarLine)
          : GRAY(`${providerName(provider)} · ${cfg.model} · thinking ${cfg.thinking} · ${cfg.workspace}`);

    // composer rows: tokens expand when the cursor is inside them
    const cur = ed.cur;
    const ranges = tokenRanges(ed.buf);
    const pts = [...ed.buf];
    let display = "";
    let rowCursor = -1; // display index of the cursor
    let di = 0;
    let rawCp = 0;
    while (rawCp < pts.length) {
      const range = ranges.find((r) => rawCp >= r.start && rawCp < r.end);
      if (range !== undefined) {
        const inToken = cur > range.start && cur < range.end;
        if (rawCp === cur) rowCursor = di;
        const content = ed.pastes.get(range.id) ?? "";
        const collapsed = `[Pasted #${range.id} +${content.split("\n").length} lines]`;
        if (inToken) {
          // expanded: paste content inline, cursor sits at the expansion start
          for (const cch of content) {
            display += cch === "\n" ? "\n" : cch;
            di += 1;
          }
        } else {
          display += collapsed;
          di += [...collapsed].length;
        }
        rawCp += range.end - range.start; // skip the whole token
        continue;
      }
      if (rawCp === cur) rowCursor = di;
      display += pts[rawCp] ?? "";
      di += 1;
      rawCp += 1;
    }
    if (cur === pts.length) rowCursor = di;

    // split display into rows and hard-wrap to width-2 (prefix on first row)
    const composerRows: string[] = [];
    let cursorRowIdx = 0;
    let cursorCol = 0;
    {
      let lineAcc = "";
      let lineStart = 0; // display index where the current row begins
      let lineWidth = 0;
      let idx = 0;
      for (const dch of display) {
        if (idx === rowCursor) {
          cursorRowIdx = composerRows.length;
          cursorCol = lineWidth;
        }
        if (dch === "\n") {
          composerRows.push(lineAcc);
          lineAcc = "";
          lineWidth = 0;
          lineStart = idx + 1;
          idx += 1;
          continue;
        }
        const w = charWidth(dch.codePointAt(0) ?? 0);
        if (lineWidth + w > width - 2 && lineAcc !== "") {
          composerRows.push(lineAcc);
          lineAcc = "";
          lineWidth = 0;
          lineStart = idx;
        }
        lineAcc += dch;
        lineWidth += w;
        idx += 1;
      }
      if (idx === rowCursor) {
        cursorRowIdx = composerRows.length;
        cursorCol = lineWidth;
      }
      composerRows.push(lineAcc);
      void lineStart;
    }

    // window over the composer rows: keep the cursor row visible
    const total = composerRows.length;
    let winStart = Math.max(0, Math.min(cursorRowIdx - INPUT_ROWS + 1, total - INPUT_ROWS));
    if (total <= INPUT_ROWS) winStart = 0;

    const out: string[] = ["\x1b[?2026h"];
    const frameRows: string[] = [];
    for (let r = 0; r < visibleRows; r += 1) frameRows.push(view[r] ?? "");
    for (const pr of previewRows) frameRows.push(pr);
    frameRows.push(statusText);
    for (let r = 0; r < INPUT_ROWS; r += 1) {
      const rowIdx = winStart + r;
      if (rowIdx >= total) {
        frameRows.push(r === 0 ? `${CYAN("› ")}▊` : "");
        continue;
      }
      let rowText = composerRows[rowIdx] ?? "";
      const prefix = rowIdx === 0 ? `${CYAN("› ")}` : "";
      if (rowIdx === cursorRowIdx) {
        const pts = [...rowText];
        pts.splice(Math.min(cursorCol, pts.length), 0, "▊");
        rowText = pts.join("");
      }
      frameRows.push(prefix + WHITE(rowText));
    }

    for (let r = 0; r < Math.max(frameRows.length, height); r += 1) {
      out.push(`\x1b[${r + 1};1H${CLEAR}${frameRows[r] ?? ""}`);
    }
    out.push("\x1b[?2026l");
    process.stdout.write(out.join(""));
  };

  // ——— boot ———

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  // alt screen, hide cursor, bracketed paste, kitty keyboard protocol (Shift+Enter as CSI-u)
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[>1u");

  const timer = setInterval(() => {
    state.frame += 1;
    // composer stability tracking (drives plan prerender)
    if (ed.buf === state.lastBufSeen) state.stableTicks += 1;
    else {
      state.stableTicks = 0;
      state.lastBufSeen = ed.buf;
    }
    // invalidate a prerender whose draft drifted
    if (state.prerender !== null && state.prerender.draft !== expandAll(ed.buf).trim()) state.prerender = null;

    if (sidecar && sidecar.shouldRun(ed.buf, Date.now())) {
      void sidecar
        .assert(ed.buf, state.running)
        .then((assertion) => {
          if (assertion !== null) {
            state.sidecarLine = assertion.line;
            state.sidecarRoute = assertion.route;
          }
        })
        .catch(() => {});
    }

    // plan prerender: stable, confident, complete directive draft → draft the plan early
    if (planDrafter && !state.running && !state.prerenderBusy && state.prerender === null && state.stableTicks >= 4) {
      const expanded = expandAll(ed.buf).trim();
      const confident = state.sidecarLine !== null && state.sidecarLine.includes("ready");
      if (confident && expanded.length >= 15 && Date.now() - state.lastPrerenderAt > 6000) {
        state.prerenderBusy = true;
        state.prerenderRequest = expanded;
        state.lastPrerenderAt = Date.now();
        const fileList = state.fileList;
        void planDrafter
          .draft(expanded, fileList)
          .then((plan) => {
            if (expandAll(ed.buf).trim() === state.prerenderRequest) {
              state.prerender = { plan, draft: state.prerenderRequest };
            }
          })
          .catch(() => {})
          .finally(() => {
            state.prerenderBusy = false;
          });
      }
    }

    draw();
  }, TICK_MS);
  draw();

  await new Promise<void>(() => {
    void timer; // the process ends via exit()
  });
}
