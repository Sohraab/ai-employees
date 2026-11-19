/**
 * The engine talks to the model, the tools and the channels only through
 * these interfaces. Real implementations: Claude (model), Executor (tools),
 * Slack/email/WhatsApp adapters (notifier). Tests use fakes.
 */
import type { OutboundMessage } from "../channels/types.js";
import type { Db } from "../db/client.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type TranscriptItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls: ToolCall[] }
  | { role: "tool_result"; callId: string; tool: string; ok: boolean; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ModelStepInput {
  model: string;
  system: string;
  transcript: TranscriptItem[];
  tools: ToolSpec[];
}

export interface ModelStepOutput {
  text?: string;
  /** Empty means the model is done and `text` is the final answer. */
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

/** One model turn. The runner drives the loop so a task can pause between turns. */
export interface AgentModel {
  step(input: ModelStepInput): Promise<ModelStepOutput>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

/** Runs connector tools. Backed by the agent's Executor workspace. */
export interface ToolExecutor {
  listTools(workspace: string): Promise<ToolSpec[]>;
  call(workspace: string, tool: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface Notifier {
  send(message: OutboundMessage): Promise<void>;
}

export interface EngineDeps {
  db: Db;
  model: AgentModel;
  tools: ToolExecutor;
  notify: Notifier;
  /** Queue a task to run. Defaults to running it inline (fine for tests and a first deploy). */
  enqueue?: (taskId: string) => Promise<void>;
  now?: () => Date;
  /** Safety limit on model turns per task. */
  maxSteps?: number;
}
