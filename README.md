# tiny-agent

A minimal GLM agent harness built on
[@earendil-works/pi-agent-core](https://github.com/earendil-works/pi) (pi).
Pure TypeScript — there is not a single `.js` source file; it runs directly on
Node ≥ 24 via native type stripping. **No shell tool, by design**: the agent has
file tools only, no bash/exec/network capabilities anywhere in the codebase.

## Quickstart

```sh
npm install
cp .env.example .env      # paste your ZAI_API_KEY
npm run selfcheck         # offline tool + sandbox test (no key needed)
npm run e2e               # offline full-loop test with a fake model (no key needed)
npm start                 # interactive REPL
npm start -- "fix the typo in notes/hello.txt"   # one-shot
echo "summarize src/" | npm start                # one-shot from stdin
```

## Models

Provider `zai` (global, `ZAI_API_KEY`) or `zai-coding-cn` (`ZAI_CODING_CN_API_KEY`),
auto-selected from whichever key is set. Available GLM ids:

`glm-4.7`, `glm-5-turbo`, `glm-5.2`, `glm-5.2-highspeed`, `glm-5.3`,
`glm-5.3-flash`, `glm-5.3-highspeed`

Default: `glm-5.3`. Override with `--model` or `TINY_AGENT_MODEL`.

## Flags

```
-p, --prompt <text>      one-shot prompt
-m, --model <id>         model id
    --provider <id>      zai | zai-coding-cn
-t, --thinking <level>   off|minimal|low|medium|high|xhigh|max (default: medium)
-C, --cwd <dir>          workspace root for the tools (default: current dir)
```

REPL commands: `/help`, `/tools`, `/reset`, `/pwd`, `/quit`.
Ctrl+C aborts the current run; press twice to quit.

## Tools (all sandboxed to the workspace root)

| tool         | what it does                                        |
| ------------ | --------------------------------------------------- |
| `read_file`  | numbered lines, optional `offset`/`limit`           |
| `write_file` | create/overwrite, makes parent dirs                 |
| `edit_file`  | exact-match replace; fails on ambiguity unless `replace_all` |
| `list_dir`   | recursive listing with depth control                |
| `glob_files` | `**`-style globbing via `fs.glob`                   |
| `grep_files` | regex/literal search, `include` glob filter, skips binaries |

Paths that escape the workspace (`../`, absolute paths outside) are rejected.

## How it works

- **pi-agent-core** owns the loop: streaming, tool calls, steering/abort,
  retries. We only supply state, tools, and a `streamFn`.
- **pi-ai** talks to Z.AI: `createModels()` + the built-in `zai` provider
  (OpenAI-compatible, `https://api.z.ai/api/coding/paas/v4`), key read from
  the environment.
- **pi-schema** gives us typed JSON-Schema builders (`obj`/`str`/`int`/…), so
  tool parameters are typechecked at compile time.
- Node's type stripping runs the `.ts` sources directly — no build step, no
  emitted JavaScript. `npm run typecheck` validates everything with `tsc`.

## Adding a tool

```ts
import { obj, str } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const params = obj({ name: str({ description: "Who to greet" }) });

const greet: AgentTool<typeof params> = {
  name: "greet",
  label: "Greet",
  description: "Say hello to someone",
  parameters: params,
  execute: async (_id, p) => ({
    content: [{ type: "text", text: `Hello, ${p.name}!` }],
    details: { name: p.name },
  }),
};

// add it in src/agent.ts → makeTools()
```

## Layout

```
src/
  index.ts     entry: args → one-shot or REPL
  config.ts    flags, .env loading, help
  agent.ts     models + Agent wiring, system prompt
  tools.ts     the six workspace tools
  display.ts   streaming/tool/usage printer
  repl.ts      interactive loop
  paths.ts     workspace sandbox helpers
  selfcheck.ts offline test of all tools + sandbox
  e2e-faux.ts  offline full agent-loop test (scripted fake model)
```
