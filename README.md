# tiny-agent

A minimal GLM agent harness built on
[@earendil-works/pi-agent-core](https://github.com/earendil-works/pi) (pi).
Pure TypeScript, no build step — Node ≥ 24 runs the `.ts` sources directly via
type stripping. **No shell tool, by design**: no bash/exec, no command strings.
The agent gets eleven sandboxed tools (files, diff, fuzzy find, script runner,
docs lookup) and a fullscreen terminal UI.

## Quickstart

```sh
npm install
cp .env.example .env      # ZAI_API_KEY
npm run selfcheck         # offline tool + sandbox test, no key needed
npm start                 # interactive REPL (default model: glm-5.3)
npm start -- "fix the typo in notes/hello.txt"   # one-shot
```

Model: `glm-5.3` by default; override with `--model` or `TINY_AGENT_MODEL`.
Keys: `ZAI_API_KEY` (global) or `ZAI_CODING_CN_API_KEY` (China endpoint).
Flags: `-p` prompt · `-m` model · `-t` thinking level · `-C` workspace.
REPL: Enter queues mid-run · Shift+Enter steers · Ctrl+C aborts (twice quits) · `/help`.

## Tools

| tool              | what it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `read_file`       | numbered lines, optional `offset`/`limit`                    |
| `write_file`      | create/overwrite, makes parent dirs                          |
| `edit_file`       | exact-match replace; fails on ambiguity unless `replace_all` |
| `list_dir`        | recursive listing with depth control                         |
| `glob_files`      | `**`-style globbing via `fs.glob`                            |
| `grep_files`      | regex/literal search, `include` glob filter, skips binaries  |
| `run_ts`          | run a workspace script on Node under the Permission Model    |
| `diff_files`      | unified diff between two files (Myers O(ND))                 |
| `find_files`      | fuzzy ranked file-name search (fzf-style scoring)            |
| `resolve_library` | Context7 lookup: name → `/org/project` ID                    |
| `get_library_docs`| fetch current docs for a Context7 library ID                 |

Paths that escape the workspace are rejected; symlinks pointing outside are
rejected too. `run_ts` runs one fixed binary with fixed flags — never a shell —
under Node's `--permission` model (fs bounded to the workspace, no child
processes, no network on Node ≥ 25). The docs tools are the only network
traffic: outbound read-only fetches to context7.com.

## Why tool calls aren't gated by an LLM classifier

Some agents check every tool call with a second LLM: "is this call safe?"
tiny-agent doesn't, because a judgment is the wrong kind of answer:

- **Non-deterministic.** The same call can pass and fail. A security boundary
  that flip-flops is not a boundary.
- **Uncalibrated.** The verdict is generated text, not a measured probability.
  There is no honest threshold, and no way to test where the boundary actually
  sits.
- **Injectable.** The judge reads the same content an attacker controls — tool
  arguments and the files they point at. The gate is made of the attack surface.
- **Wrong question.** "Is this call safe?" depends on intent, which cannot be
  read from a string. "What can this call affect, and can it be undone?" can be
  answered by reading code.

So safety lives in the capability set, not in a verdict. Tools have fixed
semantics and bounded scope: workspace-only paths, symlink-safe resolution,
`run_ts` sandboxed at two independent layers, writes journaled and reversible
with `undo_run`. The dangerous question — is this safe? — is replaced by one
you can answer for yourself: read `src/tools.ts`, then decide.

## Layout

```
src/
  index.ts          entry: args → one-shot or REPL
  config.ts         flags, .env loading, help
  agent.ts          models + Agent wiring, system prompt, plan drafter
  tools.ts          workspace tools (files, diff_files, find_files, run_ts)
  paths.ts          sandbox helpers (symlink-safe resolveReal)
  diff.ts           Myers O(ND) line diff + unified formatter
  fuzzy.ts          fzf-style fuzzy match scoring
  context7.ts       docs tools (context7.com, read-only)
  repl.ts           fullscreen terminal UI + composer + paste handling
  snapshots.ts      pre-run snapshots (undo_run, diff_run)
  journal.ts        per-edit journal (undo_last_edit, redo_last_edit)
  reversibility.ts  the four reversibility tools
  display.ts        one-shot streaming printer
  selfcheck.ts      offline tool + sandbox tests
  e2e-faux.ts       offline full agent-loop test
```
