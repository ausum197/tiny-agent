import process from "node:process";
import readline from "node:readline/promises";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Config, ProviderId } from "./config.ts";
import { providerName } from "./agent.ts";

const BOLD = "\x1b[1m";
const RESET = "\x1b[22m";

function bold(text: string): string {
  return process.stdout.isTTY ? `${BOLD}${text}${RESET}` : text;
}

/** Interactive read–eval loop with /commands. Ctrl+C aborts a run, twice exits. */
export async function runRepl(agent: Agent, cfg: Config, provider: ProviderId): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let running = false;
  let ctrlCCount = 0;

  rl.on("SIGINT", () => {
    if (running) {
      process.stdout.write("\n[aborting]\n");
      agent.abort();
      return;
    }
    ctrlCCount += 1;
    if (ctrlCCount >= 2) {
      rl.close();
      process.exit(0);
    }
    process.stdout.write("(press Ctrl+C again to exit)\n");
  });

  console.log(
    `tiny-agent · ${providerName(provider)} · ${bold(cfg.model)} · thinking ${cfg.thinking}\n` +
      `workspace: ${cfg.workspace}\n` +
      `tools: read_file write_file edit_file list_dir glob_files grep_files — no shell, by design.\n` +
      `Type a message. /help for commands. Ctrl+C aborts a run, twice quits.`,
  );

  while (true) {
    let line: string;
    try {
      line = await rl.question("\n› ");
    } catch {
      break; // stdin closed
    }
    ctrlCCount = 0;

    const input = line.trim();
    if (input === "") continue;

    if (input.startsWith("/")) {
      const [command, ...args] = input.split(/\s+/);
      switch (command) {
        case "/quit":
        case "/exit": {
          rl.close();
          return;
        }
        case "/help": {
          console.log("/model [id]  switch or list models\n/tools       list active tools\n/reset       clear conversation\n/pwd         show workspace\n/quit        exit");
          continue;
        }
        case "/pwd": {
          console.log(cfg.workspace);
          continue;
        }
        case "/tools": {
          for (const tool of agent.state.tools) {
            console.log(`${tool.name.padEnd(12)} ${tool.description}`);
          }
          continue;
        }
        case "/reset": {
          agent.reset();
          console.log("conversation cleared");
          continue;
        }
        case "/model": {
          if (args[0] === undefined) {
            console.log(`current: ${agent.state.model.id}`);
            continue;
          }
          // Model switching needs a Model object from the provider registry; the
          // REPL keeps it simple and only reports — restart with --model to switch.
          console.log(`model is chosen at startup via --model (current: ${agent.state.model.id})`);
          continue;
        }
        default: {
          console.log(`unknown command ${command} (try /help)`);
          continue;
        }
      }
    }

    running = true;
    try {
      await agent.prompt(input);
      await agent.waitForIdle();
    } catch (err) {
      if (agent.signal?.aborted) {
        console.log("[aborted]");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\nerror: ${message}`);
      }
    } finally {
      running = false;
    }
  }
  rl.close();
}
