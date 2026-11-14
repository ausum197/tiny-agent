import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import {
  SandboxError,
  displayPath,
  resolveInWorkspace,
  shouldSkipDir,
} from "./paths.ts";

const MAX_READ_BYTES = 512 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_LIST_ENTRIES = 500;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_FILES = 2000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;

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

/**
 * The six workspace tools. Pure TypeScript on node:fs — there is no shell,
 * no exec, no child_process, and no network access anywhere in this project.
 */
export function makeTools(root: string): AgentTool<any>[] {
  const read_file: AgentTool<typeof readFileParams> = {
    name: "read_file",
    label: "Read File",
    description: "Read a text file from the workspace. Returns numbered lines.",
    parameters: readFileParams,
    execute: async (_id, params) =>
      guard(async () => {
        const abs = resolveInWorkspace(root, params.path);
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
        const abs = resolveInWorkspace(root, params.path);
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
        const abs = resolveInWorkspace(root, params.path);
        const text = await fs.readFile(abs, "utf8");
        const count = text.split(params.old_string).length - 1;
        if (count === 0) return fail("old_string not found in file", { path: displayPath(root, abs) });
        if (count > 1 && params.replace_all !== true) {
          return fail(
            `old_string appears ${count} times; pass replace_all: true or include more surrounding text to make it unique`,
            { path: displayPath(root, abs), occurrences: count },
          );
        }
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
        const abs = resolveInWorkspace(root, params.path);
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
        const abs = resolveInWorkspace(root, params.path);
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
        const abs = resolveInWorkspace(root, params.path);
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

  return [read_file, write_file, edit_file, list_dir, glob_files, grep_files];
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
