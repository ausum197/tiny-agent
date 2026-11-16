/**
 * Offline sanity check: exercises every tool against a scratch directory and
 * verifies the pi-agent-core/pi-ai wiring constructs cleanly. No API call, no
 * API key needed.
 *
 *   npm run selfcheck
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { boot } from "./agent.ts";
import { DEFAULT_MODEL } from "./config.ts";
import { makeTools } from "./tools.ts";
import { makeDocsTools } from "./context7.ts";
import { makeReversibilityTools } from "./reversibility.ts";
import { snapshotRun } from "./snapshots.ts";

let failures = 0;

function check(name: string, condition: boolean, detail: string = ""): void {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

async function expectError(name: string, body: () => Promise<{ isError?: boolean }>): Promise<void> {
  const result = await body();
  check(name, result.isError === true, "expected an error result");
}

const workspace = await fs.mkdtemp(path.join(process.cwd(), ".selfcheck-"));
try {
  const tools = [...makeTools(workspace), ...makeDocsTools(), ...makeReversibilityTools(workspace)];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, params: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    const result = await tool.execute("selfcheck", params as never);
    const first = result.content[0];
    return { text: first?.type === "text" ? first.text : "", isError: result.isError };
  };

  // write_file + read_file
  await call("write_file", { path: "notes/hello.txt", content: "alpha\nbeta\ngamma\n" });
  const read = await call("read_file", { path: "notes/hello.txt" });
  check("write_file + read_file", read.text.includes("1:") && read.text.includes("gamma"));

  // edit_file unique
  const edit = await call("edit_file", { path: "notes/hello.txt", old_string: "beta", new_string: "BETA" });
  check("edit_file", edit.text.includes("1 replacement"));

  // edit_file ambiguous
  await call("write_file", { path: "notes/dup.txt", content: "x y x\n" });
  await expectError("edit_file rejects ambiguity", () =>
    call("edit_file", { path: "notes/dup.txt", old_string: "x", new_string: "z" }),
  );
  const editAll = await call("edit_file", { path: "notes/dup.txt", old_string: "x", new_string: "z", replace_all: true });
  check("edit_file replace_all", editAll.text.includes("2 replacements"));

  // sandbox: parent-relative escapes must fail
  await expectError("sandbox blocks ../ escapes", () => call("read_file", { path: "../outside.txt" }));
  await expectError("sandbox blocks absolute escapes", () => call("read_file", { path: "/etc/hosts" }));

  // sandbox: symlink escapes must fail
  const outsideDir = await fs.mkdtemp(path.join(path.dirname(workspace), "selfcheck-outside-"));
  try {
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "top secret\n");
    await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(workspace, "link.txt"));
    await expectError("sandbox blocks symlink escape (read)", () => call("read_file", { path: "link.txt" }));
    await expectError("sandbox blocks symlink escape (overwrite)", () =>
      call("write_file", { path: "link.txt", content: "pwned\n" }));
    check("outside file untouched by symlink write", (await fs.readFile(path.join(outsideDir, "secret.txt"), "utf8")) === "top secret\n");
    const leaked = await fs.readFile(path.join(workspace, "link.txt"), "utf8").catch(() => "");
    check("symlink target not overwritten", leaked !== "pwned\n");

    // symlinked directory as an ancestor
    await fs.symlink(outsideDir, path.join(workspace, "outside-dir"));
    await expectError("sandbox blocks symlinked ancestor dir", () =>
      call("read_file", { path: "outside-dir/secret.txt" }));
    await expectError("sandbox blocks write through symlinked ancestor dir", () =>
      call("write_file", { path: "outside-dir/evil.txt", content: "pwned\n" }));
    const evil = await fs.readFile(path.join(outsideDir, "evil.txt"), "utf8").catch(() => "");
    check("no write landed outside via symlinked dir", evil === "");

    // write_file of a brand-new file still works (non-existing suffix path)
    const fresh = await call("write_file", { path: "notes/new/deep.txt", content: "ok\n" });
    check("write_file creates new nested file", !fresh.isError && fresh.text.includes("wrote"));

    // run_ts: happy path — script runs, writes inside the workspace
    await call("write_file", {
      path: "scripts/add.ts",
      content: `import fs from "node:fs/promises";\nconsole.log("RUNTS-SUM", 2 + 3);\nawait fs.writeFile("scripts/sum.txt", String(2 + 3));\n`,
    });
    const run = await call("run_ts", { path: "scripts/add.ts" });
    check("run_ts runs script", !run.isError && run.text.includes("RUNTS-SUM 5") && run.text.includes("exit 0"), run.text.slice(0, 200));
    const sumFile = await call("read_file", { path: "scripts/sum.txt" });
    check("run_ts script wrote inside workspace", sumFile.text.includes("5"));

    // run_ts: permission model blocks fs writes outside the workspace
    const outsideTarget = path.join(outsideDir, "escape.txt");
    await call("write_file", {
      path: "scripts/escape.ts",
      content: `import fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(outsideTarget)}, "pwned");\n`,
    });
    const escape = await call("run_ts", { path: "scripts/escape.ts" });
    check("run_ts denies fs write outside workspace", escape.text.includes("exit") && !escape.text.includes("exit 0"), escape.text.slice(0, 300));
    const escapeFile = await fs.readFile(outsideTarget, "utf8").catch(() => "");
    check("no file escaped via run_ts", escapeFile === "");

    // run_ts: kernel seatbelt active on macOS
    if (process.platform === "darwin") {
      const beltRun = await call("run_ts", { path: "scripts/add.ts", argv: [] });
      check("run_ts under seatbelt", beltRun.text.includes("exit 0"), beltRun.text.slice(0, 200));
    }

    // run_ts: network denied
    await call("write_file", {
      path: "scripts/netcheck.ts",
      content: `import http from "node:http";\nhttp.get({ host: "example.com" }, () => { console.log("NET-LEAK"); process.exit(0); }).on("error", () => process.exit(3));\n`,
    });
    const netcheck = await call("run_ts", { path: "scripts/netcheck.ts" });
    check("run_ts denies network", !netcheck.text.includes("NET-LEAK") && !netcheck.text.includes("exit 0"), netcheck.text.slice(0, 300));

    // run_ts: .env (secrets) unreadable by scripts (kernel seatbelt denies it; macOS only)
    if (process.platform === "darwin") {
      await fs.writeFile(path.join(workspace, ".env"), "ZAI_API_KEY=secret\n");
      await call("write_file", {
        path: "scripts/steal.ts",
        content: `import fs from "node:fs";\nconsole.log("KEY", fs.readFileSync(".env", "utf8").trim());\n`,
      });
      const steal = await call("run_ts", { path: "scripts/steal.ts" });
      check("run_ts denies .env read", !steal.text.includes("ZAI_API_KEY=secret") && !steal.text.includes("exit 0"), steal.text.slice(0, 300));
    }

    // run_ts: refuses non-script paths and missing files
    await expectError("run_ts refuses missing file", () => call("run_ts", { path: "scripts/nope.ts" }));
  } finally {
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  // list_dir / glob_files / grep_files
  const list = await call("list_dir", { depth: 3 });
  check("list_dir", list.text.includes("notes/"));
  const glob = await call("glob_files", { pattern: "**/*.txt" });
  check("glob_files", glob.text.includes("notes/hello.txt"));
  const grep = await call("grep_files", { pattern: "BETA", case_insensitive: true });
  check("grep_files", grep.text.includes("notes/hello.txt:2:"));
  const grepLiteral = await call("grep_files", { pattern: "a+b", literal: true });
  check("grep_files literal", !grepLiteral.isError);

  // agent wiring (no network — just construction)
  const cfg = {
    provider: "zai" as const,
    model: DEFAULT_MODEL,
    thinking: "medium" as const,
    workspace,
    prompt: undefined,
    help: false,
    sidecar: false,
  };
  const { agent, model } = boot(cfg);
  check("boot: model resolved", model.id === DEFAULT_MODEL, `got ${model.id}`);
  check("boot: tools attached", agent.state.tools.length === 15, `got ${agent.state.tools.length}`);
  check("boot: thinking level", agent.state.thinkingLevel === "medium");
  const zaiIds = agent.state.tools.map((tool) => tool.name).join(",");
  check(
    "tool names",
    zaiIds ===
      "read_file,write_file,edit_file,list_dir,glob_files,grep_files,run_ts,diff_files,find_files,resolve_library,get_library_docs,undo_run,diff_run,undo_last_edit,redo_last_edit",
    zaiIds,
  );

  // ——— reversibility: .tinyagent off-limits to file tools ———
  await expectError("sandbox blocks .tinyagent read", () => call("read_file", { path: ".tinyagent/journal.jsonl" }));
  await expectError("sandbox blocks .tinyagent write", () => call("write_file", { path: ".tinyagent/evil", content: "x" }));

  // ——— level 1: per-run snapshot + undo_run + diff_run ———
  await call("write_file", { path: "rev.txt", content: "v1\n" }); // also creates a journal record
  await snapshotRun(workspace); // simulate pre-run checkpoint (what the REPL does)
  const run = async (name: string, params: Record<string, unknown> = {}): Promise<string> => {
    const result = await (byName.get(name) as any).execute("selfcheck", params as never);
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };

  // agent "run": modify rev.txt, create new.ts
  await call("write_file", { path: "rev.txt", content: "v2 broken\n" });
  await call("write_file", { path: "new.ts", content: "export const x = 1;\n" });
  const diffText = await run("diff_run");
  check("diff_run sees changes", diffText.includes("1 modified") && diffText.includes("M rev.txt") && diffText.includes("A new.ts"), diffText);
  const undoText = await run("undo_run");
  check("undo_run reverts run", undoText.includes("reverted"), undoText);
  const afterUndo = await call("read_file", { path: "rev.txt" });
  check("undo_run restored content", afterUndo.text.includes("v1"), afterUndo.text.slice(0, 120));
  const gone = await call("read_file", { path: "new.ts" });
  check("undo_run removed agent-created file", gone.isError === true, gone.text.slice(0, 120));

  // ——— diff_files + find_files ———
  await call("write_file", { path: "src/user-service.ts", content: "export const userService = 1;\n" });
  const difftext = await run("diff_files", { a: "notes/hello.txt", b: "src/user-service.ts" });
  check("diff_files produces hunks", difftext.includes("@@") && difftext.includes("-alpha") && difftext.includes("+export"), difftext.slice(0, 200));
  const sameDiff = await run("diff_files", { a: "notes/hello.txt", b: "notes/hello.txt" });
  check("diff_files identical", sameDiff.includes("identical"), sameDiff.slice(0, 120));
  const find1 = await run("find_files", { query: "usrv" });
  check("find_files fuzzy match", find1.includes("src/user-service.ts"), find1.slice(0, 200));
  const find2 = await run("find_files", { query: "hello" });
  check("find_files exact-name first", find2.split("\n")[1]?.includes("notes/hello.txt") === true, find2.slice(0, 200));
  const find3 = await run("find_files", { query: "zzqq" });
  check("find_files no match is clean", find3.includes("no files match"), find3.slice(0, 120));

  // ——— levels 2+3: journal undo/redo ———
  const undoEdit = byName.get("undo_last_edit")!;
  const redoEdit = byName.get("redo_last_edit")!;
  const callSimple = async (name: string): Promise<{ text: string; isError?: boolean }> => {
    const result = await (byName.get(name) as any).execute("selfcheck", {} as never);
    const first = result.content[0];
    return { text: first?.type === "text" ? first.text : "", isError: result.isError };
  };

  // journal currently: [write rev.txt v1 (mutation), write rev.txt v2, write new.ts (undone via snapshot restore)]
  // undo_last_edit targets the last APPLIED mutation = write new.ts (its file was removed by restore → recreated? no:
  // restoreRun deleted it; undo would delete again — force:true, harmless)
  const u1 = await callSimple("undo_last_edit");
  check("undo_last_edit steps back", u1.isError !== true, u1.text);
  // now the last applied is write rev.txt v2 — restore brings back v1... but wait: rev.txt on disk is v1 (snapshot restore).
  // The v2 mutation's before = v1 content; undo writes v1 again — idempotent here.
  const u2 = await callSimple("undo_last_edit");
  check("undo_last_edit steps back again", u2.isError !== true, u2.text);
  const r1 = await callSimple("redo_last_edit");
  check("redo_last_edit re-applies", r1.isError !== true, r1.text);
  const r2 = await callSimple("redo_last_edit");
  check("redo_last_edit re-applies again", r2.isError !== true, r2.text);
  const afterRedo = await call("read_file", { path: "new.ts" });
  check("redo restored agent-created file", !afterRedo.isError && afterRedo.text.includes("x = 1"), afterRedo.text.slice(0, 120));
  const drained = await callSimple("redo_last_edit");
  check("redo drains to nothing", drained.isError === true, drained.text);
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nselfcheck failed: ${failures} problem${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\nselfcheck passed — all tools and agent wiring work.");
