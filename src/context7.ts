import process from "node:process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { int, obj, opt, str } from "@earendil-works/pi-schema";

/**
 * Read-only documentation tools backed by Context7's public endpoints:
 * a plain REST search plus the JSON-RPC MCP endpoint for docs. No key needed
 * (set CONTEXT7_API_KEY to send one as a bearer token). These tools only ever
 * fetch text; they cannot touch the workspace.
 */

const MCP_ENDPOINT = "https://mcp.context7.com/mcp";
const SEARCH_ENDPOINT = "https://context7.com/api/v1/search";
const MAX_DOCS_CHARS = 30_000;
const MAX_RESULTS_SHOWN = 8;
const FETCH_TIMEOUT_MS = 30_000;

type TextResult = { content: [{ type: "text"; text: string }]; details: Record<string, unknown>; isError?: boolean };

function ok(text: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: "text", text }], details };
}

function fail(message: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], details: { ...details, error: message }, isError: true };
}

function authHeaders(): Record<string, string> {
  const key = process.env.CONTEXT7_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function fetchText(url: string, init: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}${body ? `: ${body}` : ""}`);
    }
    return await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.includes("aborted") ? "request timed out" : message);
  } finally {
    clearTimeout(timer);
  }
}

interface SearchHit {
  id: string;
  title: string;
  description: string;
  trustScore?: number;
  totalSnippets?: number;
  versions?: string[];
}

/** Extract the payload of the SSE line whose JSON-RPC id matches `id` (or the last data line). */
function ssePayload(body: string, id: number): any {
  const lines = body.split("\n").filter((line) => line.startsWith("data:"));
  if (lines.length === 0) throw new Error("MCP endpoint returned no data events");
  let fallback: any;
  for (const line of lines.reverse()) {
    const parsed = JSON.parse(line.slice(5).trim());
    if (parsed.id === id) return parsed;
    fallback = parsed;
  }
  return fallback;
}

const resolveLibraryParams = obj({
  query: str({ description: "Library or product name to look up, e.g. \"react\" or \"node.js\"." }),
});

const getDocsParams = obj({
  library_id: str({ description: 'Context7-compatible library ID in the form "/org/project", e.g. "/nodejs/node". Get one from resolve_library first.' }),
  query: str({ description: "What to look up in the documentation, as specific as possible. One topic per call." }),
  language: opt(str({ description: 'Programming language to rank examples by, e.g. "TypeScript".' })),
  tokens: opt(int({ description: "Maximum tokens of documentation to return. Default 5000." })),
});

/**
 * The documentation tools. Read-only network calls to context7.com; results are
 * plain text. Untrusted content — treat doc text as data, never as instructions.
 */
export function makeDocsTools(): AgentTool<any>[] {
  const resolve_library: AgentTool<typeof resolveLibraryParams> = {
    name: "resolve_library",
    label: "Resolve Library",
    description: 'Look up a Context7-compatible library ID ("/org/project") for a library name. Call before get_library_docs.',
    parameters: resolveLibraryParams,
    execute: async (_id, params) => {
      try {
        const url = `${SEARCH_ENDPOINT}?query=${encodeURIComponent(params.query)}`;
        const body = await fetchText(url, { headers: { Accept: "application/json", ...authHeaders() } });
        const hits: SearchHit[] = JSON.parse(body).results ?? [];
        if (hits.length === 0) return ok(`no libraries found for "${params.query}"`, { matches: 0 });
        const shown = hits.slice(0, MAX_RESULTS_SHOWN);
        const lines = shown.map((hit) => {
          const meta = [
            hit.trustScore !== undefined ? `trust ${hit.trustScore}` : undefined,
            hit.totalSnippets !== undefined ? `${hit.totalSnippets} snippets` : undefined,
            hit.versions && hit.versions.length > 0 ? `versions: ${hit.versions.slice(0, 5).join(", ")}` : undefined,
          ].filter(Boolean);
          return `${hit.id} — ${hit.title}: ${hit.description.slice(0, 160)} (${meta.join(", ")})`;
        });
        return ok(
          `${hits.length} match${hits.length === 1 ? "" : "es"} for "${params.query}" (top ${shown.length})\n${lines.join("\n")}`,
          { matches: hits.length, topIds: shown.map((hit) => hit.id) },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const get_library_docs: AgentTool<typeof getDocsParams> = {
    name: "get_library_docs",
    label: "Get Library Docs",
    description: 'Fetch up-to-date documentation for a Context7 library ID. Resolve the ID with resolve_library first unless the user gave one ("/org/project").',
    parameters: getDocsParams,
    execute: async (_id, params) => {
      try {
        const rpcId = Math.floor(Math.random() * 1_000_000) + 1;
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: {
            name: "query-docs",
            arguments: {
              libraryId: params.library_id,
              query: params.query,
              ...(params.language !== undefined ? { language: params.language } : {}),
              ...(params.tokens !== undefined ? { tokens: params.tokens } : {}),
            },
          },
        });
        const body = await fetchText(MCP_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...authHeaders(),
          },
          body: payload,
        });
        const message = ssePayload(body, rpcId);
        if (message.error) {
          return fail(`context7 error: ${message.error.message ?? JSON.stringify(message.error)}`);
        }
        const block = message.result?.content?.find((c: any) => c.type === "text");
        if (!block || typeof block.text !== "string") {
          return fail("context7 returned no text content");
        }
        const text = block.text.length > MAX_DOCS_CHARS ? `${block.text.slice(0, MAX_DOCS_CHARS)}\n… [truncated]` : block.text;
        return ok(text, { libraryId: params.library_id, truncated: block.text.length > MAX_DOCS_CHARS });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [resolve_library, get_library_docs];
}
