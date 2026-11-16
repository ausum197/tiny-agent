# tiny-agent

A minimal GLM agent harness built on
[@earendil-works/pi-agent-core](https://github.com/earendil-works/pi) (pi).
Pure TypeScript, no build step — Node ≥ 24 runs the `.ts` sources directly via
type stripping. **No shell tool, by design**: no bash/exec, no command strings.
The agent gets eleven sandboxed tools (files, diff, fuzzy find, script runner,
docs lookup), a fullscreen terminal UI, and an optional Jev sidecar.

## Quickstart

```sh
npm install
cp .env.example .env      # ZAI_API_KEY (plus JEV_TOKEN for --sidecar)
npm run selfcheck         # offline tool + sandbox test, no key needed
npm start                 # interactive REPL (default model: glm-5.3)
npm start -- "fix the typo in notes/hello.txt"   # one-shot
```

Model: `glm-5.3` by default; override with `--model` or `TINY_AGENT_MODEL`.
Keys: `ZAI_API_KEY` (global) or `ZAI_CODING_CN_API_KEY` (China endpoint).
Flags: `-p` prompt · `-m` model · `-t` thinking level · `-C` workspace · `--sidecar`.
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

## Sidecar mode (--sidecar)

While you compose, one debounced Jev request rates the draft: completion
probability, intent, multi-idea detection, missing-file references, and a
queue-vs-steer route suggestion. Assertions appear on the idle status row and
retract on the next keystroke. When the draft settles, a plan is prerendered
and shown dimmed — Enter submits your message with that plan attached, so the
agent starts executing instead of exploring.

## Why the sidecar isn't an LLM classifier

The common design puts a second LLM behind a prompt — "judge whether this draft
is ready." tiny-agent doesn't, for four reasons:

- an LLM classifier is non-deterministic: the same draft can pass and fail
- its verdicts are uncalibrated text, so there is no honest threshold to set
- its policy lives in prompt phrasing, which drifts with every edit
- the judge is itself generative, injectable by the same content it judges

The sidecar instead asks [Jev](https://docs.typesafe.ai) — a System One model
trained for calibrated decisions — narrow yes/no and choice questions, and gets
probabilities measured against outcomes. Policy is code: thresholds, gates, and
one status line. Wrong guesses retract on the next keystroke, and real damage
is bounded anyway: the sidecar is read-only, the main agent's writes are
journaled, and `undo_run` reverts anything it did.

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
  repl.ts           fullscreen terminal UI + composer + sidecar wiring
  sidecar.ts        Jev assertions (System One fan-out)
  snapshots.ts      pre-run snapshots (undo_run, diff_run)
  journal.ts        per-edit journal (undo_last_edit, redo_last_edit)
  reversibility.ts  the four reversibility tools
  display.ts        one-shot streaming printer
  selfcheck.ts      offline tool + sandbox tests
  e2e-faux.ts       offline full agent-loop test
```
