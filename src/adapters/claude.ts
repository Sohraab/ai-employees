/**
 * AgentModel backed by the Claude Messages API.
 *
 * The engine drives the loop itself (one `step` per model turn) so a task can
 * pause for hours waiting on an approval and resume later. Things this adapter
 * takes care of:
 *  - Claude's own reply blocks (including thinking) are replayed unchanged on
 *    later turns, and the system prompt and tool list are fixed per task by the
 *    runner, as Claude Opus 5.5 requires.
 *  - Tool names: ours use dots (`gmail.send_message`); Claude tool names allow
 *    only letters, digits, `_` and `-`, so names are translated both ways.
 *  - Refusals fall back to another model server-side (`fallbacks: "default"`).
 *  - Cost is computed from token usage.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentModel, Effort, ModelStepInput, ModelStepOutput, ToolCall, TranscriptItem } from "../engine/types.js";

/**
 * Models an AI employee can run on. Pick per employee (agents.model):
 * Opus for judgment-heavy work, Sonnet for everyday work at half the price,
 * Haiku for high-volume, simple jobs.
 * Prices: USD per million tokens; keep in sync with Anthropic's pricing page.
 */
export const AGENT_MODELS: Record<
  string,
  { label: string; input: number; output: number; cacheRead: number; cacheWrite: number; serverFallback: boolean }
> = {
  "claude-opus-5-5": { label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, serverFallback: true },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, serverFallback: true },
  // Haiku 5.5 has no server-side refusal fallback.
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, serverFallback: false },
};

export function isSupportedModel(model: string): boolean {
  return model in AGENT_MODELS;
}

export interface ClaudeModelOptions {
  client?: Anthropic;
  /** Effort for employees that don't set their own. Agentic tool work does well at "high". */
  effort?: Effort;
  maxTokens?: number;
}

export class ClaudeModel implements AgentModel {
  private client: Anthropic;
  private effort: Effort;
  private maxTokens: number;

  constructor(opts: ClaudeModelOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens ?? 64000;
  }

  async step(input: ModelStepInput): Promise<ModelStepOutput> {
    const spec = AGENT_MODELS[input.model];
    if (!spec) throw new Error(`Unsupported model "${input.model}". Use one of: ${Object.keys(AGENT_MODELS).join(", ")}`);
    const names = new ToolNames(input.tools.map((t) => t.name));

    const stream = this.client.beta.messages.stream({
      model: input.model,
      max_tokens: this.maxTokens,
      // If the model declines for safety reasons, retry on a suitable fallback model in the same call.
      ...(spec.serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: input.effort ?? this.effort },
      cache_control: { type: "ephemeral" },
      system: input.system,
      tools: input.tools.map((t) => ({
        name: names.encode(t.name),
        description: t.description,
        input_schema: { type: "object" as const, ...t.inputSchema },
        // Stream tool arguments as they are written. Inputs are never run when the
        // reply was cut off (see max_tokens below); Executor validates them.
        eager_input_streaming: true,
      })),
      messages: toMessages(input.transcript),
    });
    const msg = await stream.finalMessage();

    const text = msg.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
    const usage = {
      inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
      outputTokens: msg.usage.output_tokens,
      costUsd: costOf(msg.model, msg.usage),
    };

    if (msg.stop_reason === "refusal") {
      return { text: text || "I can't help with that request.", toolCalls: [], usage, raw: msg.content };
    }
    // A reply cut off mid-tool-call may carry incomplete arguments: never run those.
    if (msg.stop_reason === "max_tokens") {
      return { text: text || "My reply was cut off before I could finish.", toolCalls: [], usage, raw: msg.content };
    }

    const toolCalls: ToolCall[] = msg.content.flatMap((b) =>
      b.type === "tool_use"
        ? [{ id: b.id, name: names.decode(b.name), args: isObject(b.input) ? b.input : {} }]
        : [],
    );
    return { text: text || undefined, toolCalls, usage, raw: msg.content };
  }
}

/**
 * Engine transcript → Claude messages. Consecutive tool results go into a
 * single user message, as the API expects.
 */
export function toMessages(transcript: TranscriptItem[]): Anthropic.Beta.Messages.BetaMessageParam[] {
  const out: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  for (const item of transcript) {
    if (item.role === "user") {
      out.push({ role: "user", content: item.text });
    } else if (item.role === "assistant") {
      const content = (item.raw as Anthropic.Beta.Messages.BetaContentBlockParam[] | undefined) ?? [
        ...(item.text ? [{ type: "text" as const, text: item.text }] : []),
        ...item.toolCalls.map((c) => ({
          type: "tool_use" as const,
          id: c.id,
          name: ToolNames.encodeOne(c.name),
          input: c.args,
        })),
      ];
      out.push({ role: "assistant", content });
    } else {
      const block: Anthropic.Beta.Messages.BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: item.callId,
        content: item.content,
        is_error: !item.ok,
      };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

/** Translates between our tool names and Claude-safe names (`gmail.send_message` ↔ `gmail__send_message`). */
export class ToolNames {
  private toOurs = new Map<string, string>();

  constructor(names: string[]) {
    for (const name of names) {
      let encoded = ToolNames.encodeOne(name);
      for (let i = 2; this.toOurs.has(encoded); i++) encoded = `${ToolNames.encodeOne(name).slice(0, 60)}_${i}`;
      this.toOurs.set(encoded, name);
    }
  }

  static encodeOne(name: string): string {
    return name.replace(/\./g, "__").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  }

  encode(name: string): string {
    for (const [encoded, ours] of this.toOurs) if (ours === name) return encoded;
    return ToolNames.encodeOne(name);
  }

  decode(encoded: string): string {
    return this.toOurs.get(encoded) ?? encoded.replace(/__/g, ".");
  }
}

function costOf(
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
): number {
  const p = AGENT_MODELS[model];
  if (!p) return 0;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
