import process from "node:process";
import { boot } from "./agent.ts";
import { attachDisplay } from "./display.ts";
import { HELP, loadDotEnv, parseArgs } from "./config.ts";
import { runRepl } from "./repl.ts";

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
  attachDisplay(agent);

  if (prompt === undefined) {
    await runRepl(agent, cfg, provider);
    return;
  }

  await agent.prompt(prompt);
  await agent.waitForIdle();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tiny-agent: ${message}`);
  process.exit(1);
});
