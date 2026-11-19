import { describe, expect, it } from "vitest";
import { ExecutorTools, type McpCaller, type McpResult } from "../src/adapters/executor.js";

function fakeMcp(handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const caller: McpCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      const value = handler(name, args);
      return (typeof value === "object" && value && "content" in value
        ? value
        : { content: [{ type: "text", text: JSON.stringify(value) }] }) as McpResult;
    },
  };
  return { caller, calls };
}

describe("ExecutorTools", () => {
  it("lists the scoped connection's tools across pages, without the tools. prefix", async () => {
    const { caller, calls } = fakeMcp((_name, args) =>
      "cursor" in args
        ? { tools: [{ path: "tools.ats.search_candidates", description: "Search", input: "{ q: string }" }] }
        : { tools: [{ path: "tools.gmail.send_message", description: "Send an email" }], next: { cursor: "2" } },
    );
    const tools = await new ExecutorTools(() => caller).listTools("sourcer");

    expect(tools.map((t) => t.name)).toEqual(["gmail.send_message", "ats.search_candidates"]);
    expect(tools[1]!.description).toContain("{ q: string }");
    expect(calls.map((c) => c.args)).toEqual([{ query: "" }, { cursor: "2" }]);
  });

  it("calls one tool by path and returns its value", async () => {
    const { caller, calls } = fakeMcp(() => ({ results: [{ ok: true, value: { id: "msg_1" } }] }));
    const result = await new ExecutorTools(() => caller).call("sourcer", "gmail.send_message", { to: "a@b.c" });

    expect(calls[0]).toEqual({ name: "call", args: { calls: [{ path: "tools.gmail.send_message", input: { to: "a@b.c" } }] } });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("msg_1");
  });

  it("reports tool errors and Executor-side approval pauses as failures", async () => {
    const failing = fakeMcp(() => ({ results: [{ ok: false, error: "Rate limited" }] }));
    expect(await new ExecutorTools(() => failing.caller).call("w", "x.y", {})).toEqual({ ok: false, content: "Rate limited" });

    const paused = fakeMcp(() => ({ results: [{ status: "paused", approvalUrl: "https://…" }] }));
    const r = await new ExecutorTools(() => paused.caller).call("w", "x.y", {});
    expect(r.ok).toBe(false);
    expect(r.content).toContain("automatic");
  });

  it("errors clearly when an agent has no connection configured", async () => {
    await expect(new ExecutorTools(() => undefined).listTools("nobody")).rejects.toThrow(/No Executor connection/);
  });

  it("reads connections from the environment", async () => {
    const tools = ExecutorTools.fromEnv({ EXECUTOR_URL__OPS_REPORTER: "https://x/mcp", EXECUTOR_TOKEN__OPS_REPORTER: "t" });
    // Resolution only; connecting needs a live server.
    expect(tools).toBeInstanceOf(ExecutorTools);
  });
});
