import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PROVIDER_IDS = ["zai", "zai-coding-cn"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const DEFAULT_MODEL = "glm-5.3";

export interface Config {
  /** Explicit --provider, or undefined to auto-select from env keys at boot. */
  provider: ProviderId | undefined;
  model: string;
  thinking: ThinkingLevel;
  workspace: string;
  prompt: string | undefined;
  help: boolean;
}

export const HELP = `tiny-agent — minimal GLM agent harness (file tools only, no shell)

Usage:
  tiny-agent                        interactive REPL
  tiny-agent "do the thing"         one-shot run
  tiny-agent -p "do the thing"      one-shot run
  echo "task" | tiny-agent          one-shot from stdin

Flags:
  -p, --prompt <text>     one-shot prompt (or pass it as a bare argument)
  -m, --model <id>        model id (default: ${DEFAULT_MODEL}, env TINY_AGENT_MODEL)
      --provider <id>     ${PROVIDER_IDS.join(" | ")}  (default: auto from env keys)
  -t, --thinking <level>  off|minimal|low|medium|high|xhigh|max (default: medium)
  -C, --cwd <dir>         workspace root the tools are sandboxed to (default: cwd)
  -h, --help              show this help

Env:
  ZAI_API_KEY             Z.AI API key (coding plan, global)  -> provider "zai"
  ZAI_CODING_CN_API_KEY   Z.AI API key (coding plan, China)   -> provider "zai-coding-cn"
  TINY_AGENT_MODEL        default model id

REPL commands:
  /help   /model [id]   /tools   /reset   /pwd   /quit
`;

/** Minimal .env loader: only fills vars that are not already set. */
export function loadDotEnv(dir: string = process.cwd()): void {
  const file = path.join(dir, ".env");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key in process.env) continue;
    process.env[key] = value;
  }
}

/** Choose the provider based on which API key env var is present. */
export function pickProvider(): ProviderId {
  if (process.env["ZAI_API_KEY"]) return "zai";
  if (process.env["ZAI_CODING_CN_API_KEY"]) return "zai-coding-cn";
  throw new Error(
    "No GLM API key found.\n" +
      "Set ZAI_API_KEY (Z.AI coding plan, global) or ZAI_CODING_CN_API_KEY (China).\n" +
      "Tip: put it in a .env file next to package.json.",
  );
}

export function parseArgs(argv: readonly string[]): Config {
  let provider: ProviderId | undefined;
  let model = process.env["TINY_AGENT_MODEL"] ?? DEFAULT_MODEL;
  let thinking: ThinkingLevel = "medium";
  let workspace = process.cwd();
  let prompt: string | undefined;
  let help = false;

  const positional: string[] = [];

  const needValue = (flag: string, rest: string[]): string => {
    const value = rest.shift();
    if (value === undefined) {
      throw new Error(`flag ${flag} needs a value`);
    }
    return value;
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    switch (arg) {
      case "-h":
      case "--help": {
        help = true;
        break;
      }
      case "-p":
      case "--prompt": {
        prompt = needValue(arg, rest);
        break;
      }
      case "-m":
      case "--model": {
        model = needValue(arg, rest);
        break;
      }
      case "--provider": {
        const id = needValue(arg, rest);
        if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
          throw new Error(`unknown provider "${id}" (expected: ${PROVIDER_IDS.join(", ")})`);
        }
        provider = id as ProviderId;
        break;
      }
      case "-t":
      case "--thinking": {
        const level = needValue(arg, rest);
        if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
          throw new Error(`unknown thinking level "${level}" (expected: ${THINKING_LEVELS.join(", ")})`);
        }
        thinking = level as ThinkingLevel;
        break;
      }
      case "-C":
      case "--cwd": {
        workspace = path.resolve(needValue(arg, rest));
        break;
      }
      case "--": {
        positional.push(...rest);
        rest.length = 0;
        break;
      }
      default: {
        if (arg.startsWith("-")) {
          throw new Error(`unknown flag "${arg}" (see --help)`);
        }
        positional.push(arg);
      }
    }
  }

  if (prompt === undefined && positional.length > 0) {
    prompt = positional.join(" ");
  }
  if (!existsSync(workspace)) {
    throw new Error(`workspace directory does not exist: ${workspace}`);
  }

  return {
    provider,
    model,
    thinking,
    workspace,
    prompt,
    help,
  };
}
