# tiny-agent

A minimal GLM agent harness built on
[@earendil-works/pi-agent-core](https://github.com/earendil-works/pi) (pi).
Pure TypeScript — there is not a single `.js` source file; it runs directly on
Node ≥ 24 via native type stripping. **No shell tool, by design**: no bash/exec,
no command strings. The agent gets nine sandboxed workspace tools (files, diff,
fuzzy find, script runner) and two read-only documentation tools.

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
Terminal UI is [ink](https://github.com/vadimdemedes/ink) (the library behind
Claude Code): finished conversation is printed to your scrollback once and never
repainted — scroll and search it natively; only the composer area redraws.
↑/↓ input history · Ctrl+C aborts the current run, twice quits · Ctrl+D exits.

## Tools (file tools sandboxed to the workspace root)

| tool              | what it does                                        |
| ----------------- | --------------------------------------------------- |
| `read_file`       | numbered lines, optional `offset`/`limit`           |
| `write_file`      | create/overwrite, makes parent dirs                 |
| `edit_file`       | exact-match replace; fails on ambiguity unless `replace_all` |
| `list_dir`        | recursive listing with depth control                |
| `glob_files`      | `**`-style globbing via `fs.glob`                   |
| `grep_files`      | regex/literal search, `include` glob filter, skips binaries |
| `run_ts`          | run a workspace script on Node under the Permission Model |
| `diff_files`      | unified diff between two files (Myers O(ND), verify your edits) |
| `find_files`      | fuzzy ranked file-name search (fzf-style scoring) |
| `resolve_library` | Context7 lookup: name → `/org/project` ID           |
| `get_library_docs`| fetch current docs for a Context7 library ID        |

Paths that escape the workspace (`../`, absolute paths outside) are rejected.
**Symlink-safe**: targets are real-resolved and re-checked, so a symlink inside
the workspace pointing outside is rejected too (see `src/paths.ts`).

`run_ts` spawns one fixed binary (`process.execPath`) with fixed flags — never a
shell. The script runs with Node's `--permission` model: fs read/write bounded
to the workspace, child processes/workers/addons denied, and (Node ≥ 25) network
denied. It receives a minimal environment (no API keys) and output/timeout caps.

The docs tools are the only network traffic, and it is outbound read-only fetches
to context7.com. Doc text is untrusted content — the system prompt tells the
model to treat it as data.

## Sidecar mode (--sidecar)

With `JEV_TOKEN` set (TypeSafe API key), `--sidecar` adds a System One layer:

- While you compose, a debounced Jev request (one speculative fan-out call) rates
  your draft: completion probability, intent, multi-idea detection, missing-file
  references, and a queue-vs-steer route recommendation. Assertions appear on the
  idle status row and retract on the next keystroke.
- Enter mid-run queues your message for when the agent stops; Shift+Enter steers
  immediately (kitty-keyboard terminals).
- Substantive responses open with a short numbered plan (plan handshake).

The main agent is unaffected when the flag is off or the sidecar fails.

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
  tools.ts     nine workspace tools (files + run_ts + diff/find)
  context7.ts  resolve_library + get_library_docs (read-only docs)
  display.ts   one-shot streaming printer (REPL uses pi-tui)
  repl.ts      interactive loop (ink terminal UI)
  paths.ts     workspace sandbox helpers (incl. symlink-safe resolveReal)
  diff.ts      Myers O(ND) line diff + unified formatter
  fuzzy.ts     fzf-style fuzzy match scoring
  selfcheck.ts offline test of all tools + sandbox
  e2e-faux.ts  offline full agent-loop test (scripted fake model)
```
