/**
 * End-to-end loop test with zero network: pi-ai's faux provider scripts the
 * model responses (a write_file tool call, then a final answer) so the full
 * agent loop — LLM → tool execution → follow-up LLM call — runs offline.
 *
 *   npm run e2e
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { attachDisplay } from "./display.ts";
import { systemPrompt } from "./agent.ts";
import { makeTools } from "./tools.ts";

async function main(): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(process.cwd(), ".e2e-"));

  const faux = fauxProvider({ models: [{ id: "glm-faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel("glm-faux");
  if (!model) throw new Error("faux model missing");

  faux.setResponses([
    fauxAssistantMessage([
      fauxText("I'll create the file now.\n"),
      fauxToolCall("write_file", { path: "e2e.txt", content: "written by the agent loop\n" }),
    ]),
    fauxAssistantMessage(fauxText("Done — created e2e.txt with one line.")),
  ]);

  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(workspace),
      model,
      tools: makeTools(workspace),
      thinkingLevel: "off",
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution: "sequential",
  });
  attachDisplay(agent, false);

  await agent.prompt("create a file called e2e.txt");
  await agent.waitForIdle();

  const written = await fs.readFile(path.join(workspace, "e2e.txt"), "utf8");
  const roles = agent.state.messages.map((m) => m.role).join(",");
  const finalMessage = agent.state.messages.at(-1);
  const finalText =
    finalMessage?.role === "assistant"
      ? finalMessage.content.filter((c) => c.type === "text").map((c) => c.text).join("")
      : "";

  const checks: Array<[string, boolean]> = [
    ["tool wrote the file", written.includes("written by the agent loop")],
    ["transcript shape system,user,assistant,toolResult,assistant", roles === "system,user,assistant,toolResult,assistant"],
    ["loop continued after tool call", finalText.includes("Done — created e2e.txt")],
    ["faux provider called twice", faux.state.callCount === 2],
  ];

  await fs.rm(workspace, { recursive: true, force: true });

  let failures = 0;
  for (const [name, passed] of checks) {
    if (passed) {
      console.log(`✓ ${name}`);
    } else {
      failures += 1;
      console.error(`✗ ${name}`);
    }
  }
  if (failures > 0) {
    console.error(`\ne2e failed: ${failures} problem${failures === 1 ? "" : "s"}`);
    process.exit(1);
  }
  console.log("\ne2e passed — the full agent loop works offline.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
