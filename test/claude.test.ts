import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeModel, toMessages, ToolNames } from "../src/adapters/claude.js";
import type { ModelStepInput } from "../src/engine/types.js";

/** Records the request and returns a canned reply, in place of the Anthropic client. */
function fakeClient(reply: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          requests.push(params);
          return { finalMessage: async () => reply };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const input = (over: Partial<ModelStepInput> = {}): ModelStepInput => ({
  model: "claude-opus-5-5",
  system: "You are Nova.",
  transcript: [{ role: "user", text: "Email the candidate" }],
  tools: [{ name: "gmail.send_message", description: "Send", inputSchema: { properties: { to: { type: "string" } } } }],
  ...over,
});

describe("ClaudeModel", () => {
  it("sends the employee's model and effort, with Claude-safe tool names", async () => {
    const { client, requests } = fakeClient({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage });
    await new ClaudeModel({ client }).step(input({ model: "claude-sonnet-5-5", effort: "medium" }));

    const req = requests[0]!;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.fallbacks).toBe("default");
    expect((req.tools as { name: string }[])[0]!.name).toBe("gmail__send_message");
  });

  it("uses the default effort when the employee has none, and no server fallback on Haiku", async () => {
    const { client, requests } = fakeClient({ model: "claude-haiku-5-5", content: [], stop_reason: "end_turn", usage });
    await new ClaudeModel({ client, effort: "high" }).step(input({ model: "claude-haiku-5-5" }));

    expect(requests[0]!.output_config).toEqual({ effort: "high" });
    expect(requests[0]).not.toHaveProperty("fallbacks");
    expect(requests[0]).not.toHaveProperty("betas");
  });

  it("rejects models that aren't supported", async () => {
    const { client } = fakeClient({});
    await expect(new ClaudeModel({ client }).step(input({ model: "gpt-5" }))).rejects.toThrow(/Unsupported model/);
  });

  it("returns tool calls with our names, keeps the raw blocks, and prices the turn", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Sending now." },
      { type: "tool_use", id: "tu_1", name: "gmail__send_message", input: { to: "a@b.c" } },
    ];
    const { client } = fakeClient({ model: "claude-opus-5-5", content, stop_reason: "tool_use", usage });
    const out = await new ClaudeModel({ client }).step(input());

    expect(out.toolCalls).toEqual([{ id: "tu_1", name: "gmail.send_message", args: { to: "a@b.c" } }]);
    expect(out.text).toBe("Sending now.");
    expect(out.raw).toBe(content);
    expect(out.usage.costUsd).toBeCloseTo((1000 * 4 + 100 * 20) / 1_000_000);
  });

  it("never runs tool calls from a reply that was cut off", async () => {
    const content = [{ type: "tool_use", id: "tu_1", name: "gmail__send_message", input: { to: "a@" } }];
    const { client } = fakeClient({ model: "claude-opus-5-5", content, stop_reason: "max_tokens", usage });
    const out = await new ClaudeModel({ client }).step(input());
    expect(out.toolCalls).toEqual([]);
  });

  it("treats a refusal as a final answer", async () => {
    const { client } = fakeClient({ model: "claude-opus-5-5", content: [], stop_reason: "refusal", usage });
    const out = await new ClaudeModel({ client }).step(input());
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toContain("can't help");
  });
});

describe("toMessages", () => {
  it("replays raw assistant blocks unchanged and groups tool results into one user message", () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "a", name: "x__one", input: {} },
      { type: "tool_use", id: "b", name: "x__two", input: {} },
    ];
    const messages = toMessages([
      { role: "user", text: "go" },
      { role: "assistant", toolCalls: [], raw },
      { role: "tool_result", callId: "a", tool: "x.one", ok: true, content: "1" },
      { role: "tool_result", callId: "b", tool: "x.two", ok: false, content: "denied" },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: "assistant", content: raw });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "1", is_error: false },
        { type: "tool_result", tool_use_id: "b", content: "denied", is_error: true },
      ],
    });
  });

  it("builds assistant blocks when there are no raw ones (e.g. from another model adapter)", () => {
    const messages = toMessages([
      { role: "user", text: "go" },
      { role: "assistant", text: "ok", toolCalls: [{ id: "a", name: "ats.search", args: { q: 1 } }] },
    ]);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "a", name: "ats__search", input: { q: 1 } },
      ],
    });
  });
});

describe("ToolNames", () => {
  it("round-trips names and keeps them within Claude's rules", () => {
    const names = new ToolNames(["gmail.send_message", "memory.save", "weird tool/name"]);
    for (const n of ["gmail.send_message", "memory.save", "weird tool/name"]) {
      const encoded = names.encode(n);
      expect(encoded).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(names.decode(encoded)).toBe(n);
    }
  });
});
