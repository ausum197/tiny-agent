import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import type { Config, ProviderId } from "./config.ts";
import { pickProvider } from "./config.ts";
import { makeTools } from "./tools.ts";

const PROVIDERS: Record<ProviderId, () => ReturnType<typeof zaiProvider>> = {
  zai: zaiProvider,
  "zai-coding-cn": zaiCodingCnProvider,
};

const PROVIDER_NAMES: Record<ProviderId, string> = {
  zai: "Z.AI (global)",
  "zai-coding-cn": "Z.AI (China)",
};

export function systemPrompt(workspace: string): string {
  return `You are tiny-agent, a concise coding assistant working inside a sandboxed workspace.

Workspace root: ${workspace}

You have exactly six tools: read_file, write_file, edit_file, list_dir, glob_files, grep_files.
All tool paths are relative to the workspace root; you cannot reach outside it.

There is NO shell, terminal, exec, or network tool. Do not pretend to run commands; use the
file tools to read and change files directly, and tell the user to run anything that needs a
terminal themselves.

Working style:
- Use glob_files/grep_files to explore, read_file to look before editing.
- edit_file needs exact verbatim old_string; read the file first to copy it precisely.
- Keep answers short. Show what changed, not everything you did.`;
}

export interface Boot {
  agent: Agent;
  model: Model<any>;
  provider: ProviderId;
}

export function boot(cfg: Config): Boot {
  const provider = cfg.provider ?? pickProvider();
  const models = createModels();
  models.setProvider(PROVIDERS[provider]());

  const model = models.getModel(provider, cfg.model);
  if (!model) {
    const available = models.getModels(provider).map((m) => m.id).join(", ");
    throw new Error(
      `unknown model "${cfg.model}" on provider "${provider}".\nAvailable: ${available || "(none)"}`,
    );
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(cfg.workspace),
      model,
      thinkingLevel: cfg.thinking,
      tools: makeTools(cfg.workspace),
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution: "sequential",
    sessionId: randomUUID(),
  });

  return { agent, model, provider };
}

export function providerName(provider: ProviderId): string {
  return PROVIDER_NAMES[provider];
}
