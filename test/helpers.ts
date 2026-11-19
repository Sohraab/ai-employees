import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { InboundEnvelope, OutboundMessage } from "../src/channels/types.js";
import * as schema from "../src/db/schema.js";
import { seed } from "../src/db/seed-data.js";
import type {
  AgentModel,
  EngineDeps,
  ModelStepInput,
  ModelStepOutput,
  ToolExecutor,
  ToolResult,
  ToolSpec,
} from "../src/engine/types.js";

export async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  const data = await seed(db);
  return { db, data };
}

const spec = (name: string): ToolSpec => ({ name, description: name, inputSchema: { type: "object" } });

/** Pretends to be Executor: a fixed catalog, and records every call. */
export class FakeTools implements ToolExecutor {
  calls: { workspace: string; tool: string; args: Record<string, unknown> }[] = [];
  catalog = [
    "ats.search_candidates",
    "ats.send_offer",
    "gmail.send_message",
    "web.search",
    "drive.delete_file",
    "bigquery.query_readonly",
    "slack.post_message",
  ].map(spec);

  async listTools(): Promise<ToolSpec[]> {
    return this.catalog;
  }
  async call(workspace: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ workspace, tool, args });
    return { ok: true, content: `${tool} ok` };
  }
}

export class FakeNotifier {
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage) {
    this.sent.push(m);
  }
  to(target: string) {
    return this.sent.filter((m) => m.target === target);
  }
}

type Step = Partial<ModelStepOutput> | ((input: ModelStepInput) => Partial<ModelStepOutput>);

/** Plays back a fixed list of model turns and records what the model was shown. */
export class ScriptedModel implements AgentModel {
  inputs: ModelStepInput[] = [];
  constructor(private steps: Step[]) {}
  async step(input: ModelStepInput): Promise<ModelStepOutput> {
    this.inputs.push(structuredClone(input));
    const next = this.steps.shift();
    if (!next) throw new Error("ScriptedModel ran out of steps");
    const out = typeof next === "function" ? next(input) : next;
    return {
      text: out.text,
      toolCalls: out.toolCalls ?? [],
      usage: out.usage ?? { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
    };
  }
}

export function deps(db: EngineDeps["db"], model: AgentModel) {
  const tools = new FakeTools();
  const notify = new FakeNotifier();
  const d: EngineDeps = { db, model, tools, notify };
  return { deps: d, tools, notify };
}

export function slack(
  orgId: string,
  senderHandle: string,
  text: string,
  over: Partial<InboundEnvelope> = {},
): InboundEnvelope {
  return {
    orgId,
    channel: "slack",
    agentAddress: "B_NOVA",
    senderHandle,
    text,
    threadRef: "thread-1",
    replyTarget: "C_TALENT",
    attachments: [],
    proof: { signatureValid: true },
    receivedAt: new Date(),
    raw: {},
    ...over,
  };
}

export function email(orgId: string, from: string, text: string, authPassed: boolean): InboundEnvelope {
  return {
    orgId,
    channel: "email",
    agentAddress: "nova@agents.example.com",
    senderHandle: from,
    text,
    threadRef: `<${from}-thread>`,
    replyTarget: from,
    attachments: [],
    proof: { emailAuthPassed: authPassed },
    receivedAt: new Date(),
    raw: {},
  };
}
