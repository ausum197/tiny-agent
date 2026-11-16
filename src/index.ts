import process from "node:process";
import { boot } from "./agent.ts";
import { attachDisplay } from "./display.ts";
import { HELP, loadDotEnv, parseArgs } from "./config.ts";
import { runRepl } from "./repl.ts";
import { snapshotRun } from "./snapshots.ts";
import { Sidecar, sidecarApiKey } from "./sidecar.ts";
import { createPlanDrafter } from "./agent.ts";

async function readStdinPrompt(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text === "" ? undefined : text;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = parseArgs(process.argv.slice(2));

  if (cfg.help) {
    console.log(HELP);
    return;
  }

  const prompt = cfg.prompt ?? (await readStdinPrompt());

  const { agent, provider } = boot(cfg);

  if (prompt === undefined) {
    const key = sidecarApiKey(process.env);
    const sidecar = cfg.sidecar && key !== undefined ? new Sidecar(key) : undefined;
    const planDrafter = sidecar !== undefined ? createPlanDrafter(cfg) : undefined;
    await runRepl(agent, cfg, provider, sidecar, planDrafter); // the TUI renders everything itself
    return;
  }

  attachDisplay(agent); // one-shot mode: plain streaming printer

  try {
    await snapshotRun(cfg.workspace); // reversibility: pre-run checkpoint
  } catch {
    // snapshot failure must not block the run
  }
  await agent.prompt(prompt);
  await agent.waitForIdle();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tiny-agent: ${message}`);
  process.exit(1);
});
