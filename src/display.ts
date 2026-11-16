import process from "node:process";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

const DIM = "\x1b[2m";
const RESET = "\x1b[22m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function color(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

function compactArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const text = typeof value === "string" ? (value.length > 60 ? `${value.slice(0, 57)}…` : value) : String(value);
    parts.push(`${key}=${JSON.stringify(text)}`);
  }
  return parts.join(" ");
}

/** Seconds with one decimal, e.g. "3.2s". */
function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Print streaming text/thinking, tool activity, and per-turn usage to stdout.
 */
export function attachDisplay(agent: Agent, tty: boolean = process.stdout.isTTY === true): void {
  let dirty = false; // a delta was printed without trailing newline
  let turnStartedAt: number | null = null;

  const closeLine = (): void => {
    if (dirty) {
      process.stdout.write("\n");
      dirty = false;
    }
  };

  agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          process.stdout.write(e.delta);
          dirty = true;
        }
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message.role === "assistant") {
          closeLine();
        }
        break;
      }
      case "tool_execution_start": {
        closeLine();
        process.stdout.write(`\n${color(tty, CYAN, `⚙ ${event.toolName}`)} ${color(tty, DIM, compactArgs(event.args))}\n`);
        break;
      }
      case "tool_execution_end": {
        const mark = event.isError ? color(tty, RED, "✗") : color(tty, GREEN, "✓");
        const duration =
          event.durationMs !== undefined ? color(tty, DIM, ` (${formatSeconds(event.durationMs)})`) : "";
        process.stdout.write(`${mark}${duration}\n`);
        break;
      }
      case "turn_start": {
        turnStartedAt = Date.now();
        break;
      }
      case "turn_end": {
        closeLine();
        const elapsed = turnStartedAt !== null ? color(tty, DIM, formatSeconds(Date.now() - turnStartedAt)) : "";
        turnStartedAt = null;
        if (elapsed) process.stdout.write(`\n${elapsed}\n`);
        break;
      }
      case "agent_end": {
        closeLine();
        break;
      }
      default:
        break;
    }
  });
}
