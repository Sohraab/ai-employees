/**
 * Builds what the agent sees for one task: who it is, how it works (skills),
 * who it is working for and what that person may have it do, and the
 * memories that person is allowed to see.
 */
import { authorizeToolCall, type Caller } from "../core/access.js";
import { recallMemories } from "../core/memory.js";
import type { Db } from "../db/client.js";
import type { Memory, Person } from "../db/schema.js";
import { BUILTIN_TOOLS } from "./builtins.js";
import type { LoadedAgent } from "./lookup.js";
import type { ToolExecutor, ToolSpec } from "./types.js";

export interface ToolView {
  /** Tools sent to the model for this caller. */
  offered: ToolSpec[];
  needsApproval: string[];
  /** Tools the agent has but this caller may not trigger. */
  blocked: string[];
}

export async function toolsForCaller(
  tools: ToolExecutor,
  agent: LoadedAgent,
  caller: Caller,
  now?: Date,
): Promise<ToolView> {
  const view: ToolView = { offered: [...BUILTIN_TOOLS], needsApproval: [], blocked: [] };
  if (!agent.executorWorkspace) return view;

  for (const spec of await tools.listTools(agent.executorWorkspace)) {
    const d = authorizeToolCall({ agent, toolRules: agent.tools, grants: agent.grants, caller, tool: spec.name, now });
    if (d.kind === "deny") {
      // Tools the agent has no rule for are invisible. Tools the caller can't use are listed by name only.
      if (d.reason !== "agent_lacks_tool") view.blocked.push(spec.name);
      continue;
    }
    if (d.kind === "needs_approval") view.needsApproval.push(spec.name);
    view.offered.push(spec);
  }
  return view;
}

export async function memoriesForTask(db: Db, agentId: string, caller: Caller, input: string): Promise<Memory[]> {
  const requester = { personId: caller.id, teamId: caller.teamId };
  const [relevant, recent] = await Promise.all([
    recallMemories(db, { agentId, requester, query: input, limit: 8 }),
    recallMemories(db, { agentId, requester, limit: 5 }),
  ]);
  const seen = new Set<string>();
  return [...relevant, ...recent].filter((m) => !seen.has(m.id) && seen.add(m.id));
}

export function buildSystemPrompt(params: {
  agent: LoadedAgent;
  requester: Pick<Person, "name" | "role"> | null;
  caller: Caller;
  source: "channel" | "routine" | "agent" | "api";
  view: ToolView;
  memories: Memory[];
  now: Date;
}): string {
  const { agent, requester, caller, source, view, memories, now } = params;
  const parts: string[] = [];

  parts.push(`You are ${agent.name}, ${agent.role}.`, agent.instructions);
  parts.push(`Current time: ${now.toISOString()}.`);

  const skills = agent.skills.filter((s) => s.enabled);
  if (skills.length) {
    parts.push("## Your skills", ...skills.map((s) => `### ${s.name}\n${s.description}\n\n${s.content}`));
  }

  parts.push("## Who you are working for");
  const who = requester ? `${requester.name}${requester.role ? ` (${requester.role})` : ""}` : "someone";
  parts.push(
    source === "routine"
      ? `This is a scheduled routine running on behalf of ${who}. Nobody is waiting in a chat, so produce the finished result.`
      : `You are working on a request from ${who}.`,
  );
  if (caller.trust === "unverified") {
    parts.push(
      "Their identity could not be verified for this message, so you can only answer questions. Do not take actions; " +
        "suggest they message you from a verified channel such as Slack.",
    );
  }

  parts.push("## What you may do for this person");
  if (view.needsApproval.length) {
    const approver = agent.manager?.name ?? "your manager";
    parts.push(
      `These tools pause for approval from ${approver} before they run: ${view.needsApproval.join(", ")}. ` +
        "Tell the person when you are waiting for approval.",
    );
  }
  if (view.blocked.length) {
    parts.push(
      `You have these tools, but this person is not allowed to ask you to use them: ${view.blocked.join(", ")}. ` +
        `If their request needs one, explain that and suggest they ask ${agent.manager?.name ?? "your manager"}.`,
    );
  }
  parts.push(
    "If a tool call is refused, do not try to get around it with other tools. Explain what you could not do and why.",
  );

  parts.push("## Memory");
  parts.push(
    "Use memory.save for facts worth remembering next time: preferences, decisions, how things work here. " +
      "Use visibility 'private' for anything personal or said in a private message, 'team' for things the " +
      "person's whole team should share, and 'agent_wide' only for general know-how about your job.",
  );
  if (memories.length) {
    parts.push("What you remember that is relevant here:", ...memories.map((m) => `- ${m.content}`));
  }

  return parts.join("\n\n");
}
