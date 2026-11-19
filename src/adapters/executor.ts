/**
 * ToolExecutor backed by Executor (executor.sh) over MCP.
 *
 * Each AI employee has its own Executor *scoped connection*: a URL that only
 * reaches the apps, accounts and tools chosen for that employee. That is the
 * agent's `executor_workspace`.
 *
 * We call Executor's `search` and `call` MCP tools, one tool at a time, so the
 * engine's permission gate (who may ask for what) runs before every call.
 * Executor's `execute` (codemode) is deliberately NOT given to the model: a
 * program could call tools without passing through our gate.
 *
 * Approvals: the engine asks the right human first (by person and scope), so
 * create the scoped connection in Executor's `automatic` approval mode. The
 * scoped connection still limits which tools exist at all.
 *
 * Executor's result shapes are parsed defensively. Run `npm run executor:check
 * -- <workspace>` against your instance once to confirm the catalog loads.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolExecutor, ToolResult, ToolSpec } from "../engine/types.js";

/** The part of an MCP client we use. Swappable in tests. */
export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<McpResult>;
}

export interface McpResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ExecutorConnection {
  /** Scoped connection URL, e.g. https://mcp.executor.sh/mcp?connection=<id> */
  url: string;
  /** OAuth access token granted for that scoped connection. */
  token: string;
}

export class ExecutorTools implements ToolExecutor {
  private callers = new Map<string, Promise<McpCaller>>();
  private catalogs = new Map<string, { at: number; tools: ToolSpec[] }>();

  constructor(
    private resolve: (workspace: string) => ExecutorConnection | McpCaller | undefined,
    private opts: { catalogTtlMs?: number } = {},
  ) {}

  /** Reads EXECUTOR_URL__<WORKSPACE> and EXECUTOR_TOKEN__<WORKSPACE>. */
  static fromEnv(env = process.env): ExecutorTools {
    return new ExecutorTools((workspace) => {
      const key = envKey(workspace);
      const url = env[`EXECUTOR_URL__${key}`];
      const token = env[`EXECUTOR_TOKEN__${key}`];
      return url && token ? { url, token } : undefined;
    });
  }

  async listTools(workspace: string): Promise<ToolSpec[]> {
    const cached = this.catalogs.get(workspace);
    const ttl = this.opts.catalogTtlMs ?? 5 * 60_000;
    if (cached && Date.now() - cached.at < ttl) return cached.tools;

    const mcp = await this.caller(workspace);
    const tools: ToolSpec[] = [];
    let input: Record<string, unknown> | undefined = { query: "" };
    for (let page = 0; input && page < 50; page++) {
      const res = parseJson(await mcp.callTool("search", input));
      for (const item of findArray(res, ["tools", "items", "results"])) {
        const spec = toSpec(item);
        if (spec) tools.push(spec);
      }
      const next = isObject(res) ? res.next : undefined;
      input = isObject(next) ? next : undefined;
    }

    this.catalogs.set(workspace, { at: Date.now(), tools });
    return tools;
  }

  async call(workspace: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const mcp = await this.caller(workspace);
    const raw = await mcp.callTool("call", { calls: [{ path: `tools.${tool}`, input: args }] });
    const parsed = parseJson(raw);
    const outcome = findArray(parsed, ["results", "calls", "outcomes"])[0] ?? parsed;

    if (isObject(outcome)) {
      if (looksPaused(outcome)) {
        return {
          ok: false,
          content:
            "Executor paused this call for its own approval. Set this agent's scoped connection to the " +
            "'automatic' approval mode: approvals are handled by the AI employees app.",
        };
      }
      if (outcome.ok === false || "error" in outcome) {
        return { ok: false, content: stringify(outcome.error ?? outcome) };
      }
      const value = "value" in outcome ? outcome.value : outcome;
      return { ok: !raw.isError && !isToolError(value), content: stringify(value) };
    }
    return { ok: !raw.isError, content: stringify(parsed) };
  }

  private caller(workspace: string): Promise<McpCaller> {
    let p = this.callers.get(workspace);
    if (!p) {
      p = this.connect(workspace);
      this.callers.set(workspace, p);
      p.catch(() => this.callers.delete(workspace));
    }
    return p;
  }

  private async connect(workspace: string): Promise<McpCaller> {
    const target = this.resolve(workspace);
    if (!target) throw new Error(`No Executor connection configured for workspace "${workspace}"`);
    if ("callTool" in target) return target;

    const client = new Client({ name: "ai-employees", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: { headers: { Authorization: `Bearer ${target.token}` } },
    });
    await client.connect(transport);
    return {
      callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as McpResult,
    };
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers (Executor returns JSON as structured content or as text)
// ---------------------------------------------------------------------------

export function envKey(workspace: string): string {
  return workspace.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function parseJson(res: McpResult): unknown {
  if (res.structuredContent !== undefined) return res.structuredContent;
  const text = (res.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findArray(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) {
    for (const k of keys) if (Array.isArray(v[k])) return v[k] as unknown[];
  }
  return [];
}

function toSpec(item: unknown): ToolSpec | null {
  if (!isObject(item) || typeof item.path !== "string") return null;
  const name = item.path.replace(/^tools\./, "");
  const description = String(item.description ?? item.summary ?? name);
  const inputType = item.input ?? item.inputType ?? item.signature;
  return {
    name,
    // Executor describes inputs as TypeScript types; Claude reads those well,
    // so they go in the description and the schema stays open.
    description: inputType ? `${description}\n\nInput (TypeScript type):\n${stringify(inputType)}` : description,
    inputSchema: isObject(item.inputSchema) ? item.inputSchema : { additionalProperties: true },
  };
}

function looksPaused(o: Record<string, unknown>): boolean {
  return "approvalUrl" in o || "requestId" in o || o.status === "paused" || o.status === "waiting_for_approval";
}

function isToolError(v: unknown): boolean {
  return isObject(v) && v.isError === true;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
