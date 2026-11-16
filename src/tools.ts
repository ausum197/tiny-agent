import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import {
  SandboxError,
  INTERNAL_DIR,
  displayPath,
  resolveReal,
  shouldSkipDir,
} from "./paths.ts";
import { recordMutation } from "./journal.ts";
import { diffSequence, unifiedDiff } from "./diff.ts";
import { fuzzyScore } from "./fuzzy.ts";

const MAX_READ_BYTES = 512 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_LIST_ENTRIES = 500;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_FILES = 2000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_RUN_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_RUN_TIMEOUT_MS = 120_000;

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
/** Node >= 25 denies network by default under --permission; earlier versions only bound fs. */
const RUN_NET_DENIED = NODE_MAJOR >= 25;
const RUNNABLE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/** Workspace entries the sandboxed script must never read or write (secrets, git internals, undo history). */
const RUN_DENY_ENTRIES = [".env", ".git", ".tinyagent", ".selfcheck"];

/** True on macOS with /usr/bin/sandbox-exec available. */
async function seatbeltAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await fs.access("/usr/bin/sandbox-exec", fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kernel-level seatbelt profile for run_ts children: allow everything except
 * network and the workspace's secret/internal entries. Seatbelt denies win over
 * allows when they are the more specific rule, so a deny on <root>/.env hides
 * it from an otherwise-readable workspace. File-system breadth stays in Node's
 * Permission Model (fs bounded to the workspace); the belt is the independent
 * kernel layer on top. Both layers must fail to break out.
 */
function seatbeltProfile(realRoot: string): string {
  const sb = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const denies = RUN_DENY_ENTRIES.map(
    (entry) =>
      `(deny file-read* file-write* (subpath ${sb(path.join(realRoot, entry))}))`,
  ).join("");
  return `(version 1)(allow default)(deny network*)${denies}`;
}

type TextResult = { content: [{ type: "text"; text: string }]; details: Record<string, unknown>; isError?: boolean };

function ok(text: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: "text", text }], details };
}

function fail(message: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], details: { ...details, error: message }, isError: true };
}

/** Wrap a tool body so thrown errors become clean tool results instead of aborting the loop. */
function guard(body: () => Promise<TextResult>): Promise<TextResult> {
  return body().catch((err: unknown) => {
    if (err instanceof SandboxError) return fail(err.message);
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  });
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} … [line truncated]` : line;
}

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8000);
  return probe.includes(0);
}

const readFileParams = obj({
  path: str({ description: "File path, relative to the workspace root." }),
  offset: opt(int({ description: "1-based line number to start reading from." })),
  limit: opt(int({ description: "Maximum number of lines to read." })),
});

const writeFileParams = obj({
  path: str({ description: "File path, relative to the workspace root. Parent directories are created." }),
  content: str({ description: "Full file content to write (overwrites existing files)." }),
});

const editFileParams = obj({
  path: str({ description: "File path, relative to the workspace root." }),
  old_string: str({ description: "Exact text to find (must match verbatim, including whitespace)." }),
  new_string: str({ description: "Replacement text." }),
  replace_all: opt(bool({ description: "Replace every occurrence instead of failing on multiple matches." })),
});

const listDirParams = obj({
  path: opt(str({ description: "Directory to list, relative to the workspace root. Default: workspace root." })),
  depth: opt(int({ description: "How many directory levels to descend. Default: 1." })),
});

const globFilesParams = obj({
  pattern: str({ description: 'Glob pattern, e.g. "src/**/*.ts".' }),
  path: opt(str({ description: "Directory to search in, relative to the workspace root. Default: workspace root." })),
});

const grepFilesParams = obj({
  pattern: str({ description: "Text or regular expression to search for." }),
  path: opt(str({ description: "Directory or file to search, relative to the workspace root. Default: workspace root." })),
  include: opt(str({ description: 'Only search files matching this glob, e.g. "*.ts".' })),
  literal: opt(bool({ description: "Treat pattern as plain text, not a regular expression." })),
  case_insensitive: opt(bool({ description: "Case-insensitive matching." })),
});

const runTsParams = obj({
  path: str({ description: "Script file to run, relative to the workspace root (.ts/.mts/.js/.mjs/.cjs/.cts)." }),
  argv: opt(arr(str({ description: "Arguments passed to the script." }))),
  timeout_ms: opt(int({ description: `Kill the script after this many ms. Default ${DEFAULT_RUN_TIMEOUT_MS}, max ${MAX_RUN_TIMEOUT_MS}.` })),
});

const diffFilesParams = obj({
  a: str({ description: "First file, relative to the workspace root." }),
  b: str({ description: "Second file, relative to the workspace root." }),
  context: opt(int({ description: "Lines of context around each hunk. Default 3." })),
});

const findFilesParams = obj({
  query: str({ description: 'Fuzzy query against file paths, e.g. "usrv" finds src/user-service.ts.' }),
  path: opt(str({ description: "Directory to search, relative to the workspace root. Default: workspace root." })),
  limit: opt(int({ description: "Maximum number of results. Default 25, max 50." })),
});

/**
 * The workspace tools: file tools on node:fs, `run_ts` (runtime-sandboxed
 * script execution), plus read-only `diff_files` and `find_files`. There is
 * still no shell: no argv string, no bash -c.
 */
export function makeTools(root: string): AgentTool<any>[] {
  const read_file: AgentTool<typeof readFileParams> = {
    name: "read_file",
    label: "Read File",
    description: "Read a text file from the workspace. Returns numbered lines.",
    parameters: readFileParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = await resolveReal(root, params.path);
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) return fail(`"${params.path}" is a directory, not a file`);
        if (stat.size > MAX_READ_BYTES) {
          return fail(`file is ${stat.size} bytes, larger than the ${MAX_READ_BYTES} byte read limit`);
        }
        const buffer = await fs.readFile(abs);
        if (looksBinary(buffer)) return fail(`"${params.path}" looks like a binary file`);
        const allLines = buffer.toString("utf8").split(/\r?\n/);
        const start = Math.max(1, params.offset ?? 1);
        const end = Math.min(allLines.length, start - 1 + (params.limit ?? allLines.length));
        const slice = allLines.slice(start - 1, end);
        const body = slice.map((line, i) => `${String(start + i).padStart(4)}: ${truncateLine(line)}`).join("\n");
        const truncated = end < allLines.length ? `\n… (${allLines.length - end} more lines)` : "";
        return ok(`${displayPath(root, abs)} (${allLines.length} lines)\n${body}${truncated}`, {
          path: displayPath(root, abs),
          totalLines: allLines.length,
          shownLines: slice.length,
        });
      }),
  };

  const write_file: AgentTool<typeof writeFileParams> = {
    name: "write_file",
    label: "Write File",
    description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: writeFileParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = await resolveReal(root, params.path);
        const rel = path.relative(root, abs).split(path.sep).join("/");
        await recordMutation(root, "write_file", { path: params.path, content: params.content }, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, params.content, "utf8");
        return ok(`wrote ${displayPath(root, abs)} (${Buffer.byteLength(params.content, "utf8")} bytes)`, {
          path: displayPath(root, abs),
          bytes: Buffer.byteLength(params.content, "utf8"),
        });
      }),
  };

  const edit_file: AgentTool<typeof editFileParams> = {
    name: "edit_file",
    label: "Edit File",
    description:
      "Replace exact text in a file. Fails if old_string is not found or appears more than once (pass replace_all to replace every occurrence).",
    parameters: editFileParams,
    execute: async (_id, params) =>
      guard(async () => {
        if (params.old_string === params.new_string) {
          return fail("old_string and new_string are identical");
        }
        const abs = await resolveReal(root, params.path);
        const text = await fs.readFile(abs, "utf8");
        const count = text.split(params.old_string).length - 1;
        if (count === 0) return fail("old_string not found in file", { path: displayPath(root, abs) });
        if (count > 1 && params.replace_all !== true) {
          return fail(
            `old_string appears ${count} times; pass replace_all: true or include more surrounding text to make it unique`,
            { path: displayPath(root, abs), occurrences: count },
          );
        }
        await recordMutation(root, "edit_file", {
          path: params.path,
          old_string: params.old_string,
          new_string: params.new_string,
          replace_all: params.replace_all,
        }, path.relative(root, abs).split(path.sep).join("/"));
        const updated = params.replace_all === true
          ? text.replaceAll(params.old_string, params.new_string)
          : text.replace(params.old_string, params.new_string);
        await fs.writeFile(abs, updated, "utf8");
        const replaced = params.replace_all === true ? count : 1;
        return ok(`edited ${displayPath(root, abs)} (${replaced} replacement${replaced === 1 ? "" : "s"})`, {
          path: displayPath(root, abs),
          replacements: replaced,
        });
      }),
  };

  const list_dir: AgentTool<typeof listDirParams> = {
    name: "list_dir",
    label: "List Directory",
    description: "List directory contents up to a given depth. Directories have a trailing /.",
    parameters: listDirParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = await resolveReal(root, params.path);
        const depth = Math.min(Math.max(1, params.depth ?? 1), 8);
        const entries: string[] = [];
        let truncated = false;

        const walk = async (dir: string, level: number): Promise<void> => {
          if (truncated || level > depth) return;
          const names = await fs.readdir(dir, { withFileTypes: true });
          names.sort((a, b) => {
            const dirDelta = Number(b.isDirectory()) - Number(a.isDirectory());
            return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
          });
          for (const entry of names) {
            if (entry.name === ".DS_Store" || (entry.isDirectory() && shouldSkipDir(entry.name))) continue;
            if (entries.length >= MAX_LIST_ENTRIES) {
              truncated = true;
              return;
            }
            const rel = path.relative(root, path.join(dir, entry.name));
            entries.push(entry.isDirectory() ? `${rel}/` : rel);
            if (entry.isDirectory()) await walk(path.join(dir, entry.name), level + 1);
          }
        };

        const stat = await fs.stat(abs);
        if (!stat.isDirectory()) return fail(`"${params.path ?? "."}" is not a directory`);
        await walk(abs, 1);
        const note = truncated ? `\n… (listing truncated at ${MAX_LIST_ENTRIES} entries)` : "";
        return ok(
          entries.length === 0
            ? `${displayPath(root, abs)} is empty`
            : `${entries.length} entr${entries.length === 1 ? "y" : "ies"} under ${displayPath(root, abs)}\n${entries.join("\n")}${note}`,
          { path: displayPath(root, abs), count: entries.length, truncated },
        );
      }),
  };

  const glob_files: AgentTool<typeof globFilesParams> = {
    name: "glob_files",
    label: "Glob Files",
    description: 'Find files by glob pattern (supports **). e.g. pattern "src/**/*.ts".',
    parameters: globFilesParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = await resolveReal(root, params.path);
        const found: string[] = [];
        for await (const hit of fs.glob(params.pattern, { cwd: abs })) {
          if (found.length >= MAX_GLOB_RESULTS) break;
          found.push(hit);
        }
        found.sort();
        if (found.length === 0) return ok(`no matches for "${params.pattern}"`, { matches: 0 });
        const lines = found.map((hit) => displayPath(root, path.resolve(abs, hit)));
        const note = found.length >= MAX_GLOB_RESULTS ? `\n… (capped at ${MAX_GLOB_RESULTS})` : "";
        return ok(`${found.length} match${found.length === 1 ? "" : "es"}\n${lines.join("\n")}${note}`, {
          matches: found.length,
        });
      }),
  };

  const grep_files: AgentTool<typeof grepFilesParams> = {
    name: "grep_files",
    label: "Grep Files",
    description: "Search text or regex across workspace files. Returns file:line: text matches. Skips binaries.",
    parameters: grepFilesParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = await resolveReal(root, params.path);
        const source = params.literal === true ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : params.pattern;
        let regex: RegExp;
        try {
          regex = new RegExp(source, params.case_insensitive === true ? "i" : "");
        } catch (err) {
          return fail(`invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Collect candidate files.
        const baseStat = await fs.stat(abs);
        let candidates: string[] = [];
        if (baseStat.isFile()) {
          candidates = [abs];
        } else {
          const all: string[] = [];
          const walk = async (dir: string): Promise<void> => {
            if (all.length >= MAX_GREP_FILES) return;
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                if (shouldSkipDir(entry.name)) continue;
                await walk(path.join(dir, entry.name));
              } else if (entry.isFile()) {
                all.push(path.join(dir, entry.name));
              }
            }
          };
          await walk(abs);
          candidates = all;
        }

        if (params.include !== undefined) {
          candidates = candidates.filter((file) => {
            const rel = path.relative(abs, file);
            return (
              rel === params.include ||
              path.basename(file) === params.include ||
              // minimal ** support: match against the whole relative path
              globToRegExp(params.include as string).test(rel.split(path.sep).join("/"))
            );
          });
        }

        const out: string[] = [];
        let searched = 0;
        let truncated = false;
        for (const file of candidates.slice(0, MAX_GREP_FILES)) {
          if (out.length >= MAX_GREP_RESULTS) {
            truncated = true;
            break;
          }
          const stat = await fs.stat(file);
          if (stat.size > MAX_GREP_FILE_BYTES) continue;
          const buffer = await fs.readFile(file);
          if (looksBinary(buffer)) continue;
          searched += 1;
          const lines = buffer.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (regex.test(lines[i] as string)) {
              out.push(`${displayPath(root, file)}:${i + 1}: ${truncateLine((lines[i] as string).trimStart())}`);
              if (out.length >= MAX_GREP_RESULTS) break;
            }
          }
        }

        if (out.length === 0) return ok(`no matches for "${params.pattern}" (searched ${searched} files)`, { matches: 0 });
        const note = truncated ? `\n… (capped at ${MAX_GREP_RESULTS} results)` : "";
        return ok(`${out.length} match${out.length === 1 ? "" : "es"}\n${out.join("\n")}${note}`, {
          matches: out.length,
          filesSearched: searched,
        });
      }),
  };

  const run_ts: AgentTool<typeof runTsParams> = {
    name: "run_ts",
    label: "Run TypeScript",
    description: `Run a workspace script with Node (native TypeScript type stripping). Double-sandboxed: Node's Permission Model bounds fs to the workspace (secrets like .env explicitly denied), denies child processes/workers/addons${RUN_NET_DENIED ? " and network" : ""}; on macOS a kernel seatbelt additionally denies all network. Use for scripts and experiments, not for editing files.`,
    parameters: runTsParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = await resolveReal(root, params.path);
        const ext = path.extname(abs).toLowerCase();
        if (!RUNNABLE_EXTENSIONS.has(ext)) {
          return fail(`"${params.path}" is not a runnable script type (want .ts/.mts/.cts/.js/.mjs/.cjs)`);
        }
        const stat = await fs.stat(abs);
        if (!stat.isFile()) return fail(`"${params.path}" is not a file`);

        const timeout = Math.min(
          Math.max(1_000, params.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS),
          MAX_RUN_TIMEOUT_MS,
        );
        const realRoot = await fs.realpath(root);
        const argv = params.argv ?? [];

        const nodeArgs = [
          "--disable-warning=ExperimentalWarning",
          "--permission",
          `--allow-fs-read=${realRoot}`,
          `--allow-fs-write=${realRoot}`,
          abs,
          ...argv,
        ];

        let sandbox: "seatbelt" | "none" = "none";
        const useBelt = await seatbeltAvailable();
        const command = useBelt ? "/usr/bin/sandbox-exec" : process.execPath;
        const args = useBelt
          ? ["-p", seatbeltProfile(realRoot), process.execPath, ...nodeArgs]
          : nodeArgs;
        if (useBelt) sandbox = "seatbelt";

        const child = spawn(command, args,
          {
            cwd: realRoot,
            // Deliberately minimal: the script never sees API keys or other ambient secrets.
            env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout);

        const capture = (stream: NodeJS.ReadableStream): { text: string; truncated: boolean } => {
          let text = "";
          let truncated = false;
          stream.on("data", (chunk: Buffer) => {
            if (text.length >= MAX_RUN_OUTPUT_BYTES) {
              truncated = true;
              return;
            }
            text += chunk.toString("utf8");
            if (text.length > MAX_RUN_OUTPUT_BYTES) {
              text = text.slice(0, MAX_RUN_OUTPUT_BYTES);
              truncated = true;
            }
          });
          return { get text() { return text; }, get truncated() { return truncated; } };
        };
        const out = capture(child.stdout);
        const errOut = capture(child.stderr);

        const code: number | null = await new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        clearTimeout(timer);

        const sections = [
          `exit ${code === null ? "killed" : code}${timedOut ? " (timed out, SIGKILL)" : ""}`,
          out.text.length > 0 ? `--- stdout ---\n${out.text}${out.truncated ? "\n… [truncated]" : ""}` : "--- stdout --- (empty)",
          errOut.text.length > 0 ? `--- stderr ---\n${errOut.text}${errOut.truncated ? "\n… [truncated]" : ""}` : "--- stderr --- (empty)",
        ];
        return ok(sections.join("\n"), {
          path: displayPath(root, abs),
          exitCode: code,
          timedOut,
          sandbox,
          stdoutTruncated: out.truncated,
          stderrTruncated: errOut.truncated,
        });
      }),
  };

  const diff_files: AgentTool<typeof diffFilesParams> = {
    name: "diff_files",
    label: "Diff Files",
    description:
      "Show a unified diff between two workspace files (read-only). Use to verify what an edit changed, or to compare two files. Lines are matched with Myers O(ND) diff.",
    parameters: diffFilesParams,
    execute: async (_id, params) =>
      guard(async () => {
        const absA = await resolveReal(root, params.a);
        const absB = await resolveReal(root, params.b);
        for (const [label, abs, original] of [["a", absA, params.a], ["b", absB, params.b]] as const) {
          const stat = await fs.stat(abs);
          if (stat.isDirectory()) return fail(`"${original}" is a directory, not a file`);
          if (stat.size > MAX_GREP_FILE_BYTES) {
            return fail(`"${original}" is ${stat.size} bytes, larger than the ${MAX_GREP_FILE_BYTES} byte diff limit`);
          }
        }
        const bufA = await fs.readFile(absA);
        const bufB = await fs.readFile(absB);
        if (looksBinary(bufA)) return fail(`"${params.a}" looks like a binary file`);
        if (looksBinary(bufB)) return fail(`"${params.b}" looks like a binary file`);
        const linesA = bufA.toString("utf8").replace(/\r\n/g, "\n").split("\n");
        const linesB = bufB.toString("utf8").replace(/\r\n/g, "\n").split("\n");
        const context = Math.min(Math.max(0, params.context ?? 3), 10);
        const nameA = displayPath(root, absA);
        const nameB = displayPath(root, absB);
        const diff = unifiedDiff(linesA, linesB, nameA, nameB, context);
        if (diff.text === "") {
          return ok(`${nameA} and ${nameB} are identical`, { additions: 0, deletions: 0 });
        }
        return ok(
          `${diff.text}\n(${diff.additions} addition${diff.additions === 1 ? "" : "s"}, ${diff.deletions} deletion${diff.deletions === 1 ? "" : "s"})`,
          { additions: diff.additions, deletions: diff.deletions, a: nameA, b: nameB },
        );
      }),
  };

  const find_files: AgentTool<typeof findFilesParams> = {
    name: "find_files",
    label: "Find Files",
    description:
      "Fuzzy-find workspace files by name (read-only). Ranked subsequence match with word-boundary and camelCase bonuses — e.g. query \"usrv\" finds src/user-service.ts. Returns best matches first.",
    parameters: findFilesParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = await resolveReal(root, params.path);
        const baseStat = await fs.stat(abs);
        if (!baseStat.isDirectory()) return fail(`"${params.path ?? "."}" is not a directory`);
        const limit = Math.min(Math.max(1, params.limit ?? 25), 50);

        const candidates: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          if (candidates.length >= MAX_GREP_FILES) return;
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              if (shouldSkipDir(entry.name)) continue;
              await walk(path.join(dir, entry.name));
            } else if (entry.isFile()) {
              candidates.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
            }
          }
        };
        await walk(abs);

        const scored = candidates
          .map((rel) => ({ rel, score: fuzzyScore(params.query, rel) }))
          .filter((item) => Number.isFinite(item.score))
          .sort((x, y) => y.score - x.score || x.rel.localeCompare(y.rel))
          .slice(0, limit);

        if (scored.length === 0) {
          return ok(`no files match "${params.query}" (searched ${candidates.length} files)`, { matches: 0 });
        }
        const body = scored.map((item) => `${item.rel}  (${item.score})`).join("\n");
        return ok(
          `${scored.length} match${scored.length === 1 ? "" : "es"} for "${params.query}" (of ${candidates.length} files)\n${body}`,
          { matches: scored.length, paths: scored.map((item) => item.rel) },
        );
      }),
  };

  return [read_file, write_file, edit_file, list_dir, glob_files, grep_files, run_ts, diff_files, find_files];
}

/** Tiny glob → RegExp converter for the `include` filter (supports **, *, ?). */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}
