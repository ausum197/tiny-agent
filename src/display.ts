import process from "node:process";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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

function formatUsage(message: AssistantMessage): string {
  const usage = message.usage;
  const bits: string[] = [
    `in ${usage.input}`,
    `out ${usage.output}${usage.reasoning !== undefined ? ` (think ${usage.reasoning})` : ""}`,
  ];
  if (usage.cacheRead > 0) bits.push(`cache read ${usage.cacheRead}`);
  if (usage.cacheWrite > 0) bits.push(`cache write ${usage.cacheWrite}`);
  return bits.join(", ");
}

/**
 * Print streaming text/thinking, tool activity, and per-turn usage to stdout.
 */
export function attachDisplay(agent: Agent, tty: boolean = process.stdout.isTTY === true): void {
  let dirty = false; // a delta was printed without trailing newline

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
        if (e.type === "thinking_delta") {
          if (!dirty) process.stdout.write(color(tty, DIM, "… "));
          process.stdout.write(color(tty, DIM, e.delta));
          dirty = true;
        } else if (e.type === "text_delta") {
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
        const duration = event.durationMs !== undefined ? color(tty, DIM, ` (${event.durationMs}ms)`) : "";
        process.stdout.write(`${mark}${duration}\n`);
        break;
      }
      case "turn_end": {
        closeLine();
        const message = event.message;
        if (message.role === "assistant") {
          process.stdout.write(`\n${color(tty, DIM, `· ${formatUsage(message)}`)}\n`);
        }
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
