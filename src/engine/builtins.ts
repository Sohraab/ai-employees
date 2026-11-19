/**
 * Tools every agent has, handled inside the engine rather than by Executor.
 * They follow the same rule: the caller's permissions decide what they may do.
 */
import { hasAccess, type Caller } from "../core/access.js";
import { recallMemories, remember } from "../core/memory.js";
import type { Db } from "../db/client.js";
import type { MemoryVisibility } from "../db/schema.js";
import type { LoadedAgent } from "./lookup.js";
import type { ToolResult, ToolSpec } from "./types.js";

export const BUILTIN_TOOLS: ToolSpec[] = [
  {
    name: "memory.search",
    description: "Search what you remember. Only returns memories the current person is allowed to see.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "memory.save",
    description:
      "Save something to remember next time. visibility: 'private' (only the current person), " +
      "'team' (the current person's team), 'agent_wide' (everyone; general know-how about your job).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        visibility: { type: "string", enum: ["private", "team", "agent_wide"] },
      },
      required: ["content", "visibility"],
    },
  },
];

export const isBuiltin = (tool: string) => BUILTIN_TOOLS.some((t) => t.name === tool);

export async function runBuiltin(
  db: Db,
  ctx: { agent: LoadedAgent; caller: Caller; taskId: string; now?: Date },
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { agent, caller, taskId, now } = ctx;

  if (tool === "memory.search") {
    const found = await recallMemories(db, {
      agentId: agent.id,
      requester: { personId: caller.id, teamId: caller.teamId },
      query: String(args.query ?? ""),
      limit: 10,
    });
    return { ok: true, content: found.length ? found.map((m) => `- ${m.content}`).join("\n") : "Nothing found." };
  }

  if (tool === "memory.save") {
    const content = String(args.content ?? "").trim();
    const visibility = args.visibility as MemoryVisibility;
    if (!content) return { ok: false, content: "Nothing to save." };

    // Unverified senders can't write memory: that would let a spoofed email plant "facts".
    if (caller.trust === "unverified") {
      return { ok: false, content: "Memory can't be saved for an unverified sender." };
    }
    if (visibility === "team" && !caller.teamId) {
      return { ok: false, content: "This person has no team. Save it as 'private' instead." };
    }
    // Shared know-how changes how the agent behaves for everyone, so only its managers may add it.
    if (visibility === "agent_wide" && !hasAccess(agent, agent.grants, caller, { level: "manage" }, now)) {
      return { ok: false, content: "Only this agent's managers can add agent-wide memory. Save it as 'private' or 'team'." };
    }
    if (!["private", "team", "agent_wide"].includes(visibility)) {
      return { ok: false, content: "visibility must be private, team or agent_wide." };
    }

    await remember(db, {
      agentId: agent.id,
      content,
      visibility,
      ownerPersonId: caller.id,
      teamId: caller.teamId,
      sourceTaskId: taskId,
    });
    return { ok: true, content: `Saved (${visibility}).` };
  }

  return { ok: false, content: `Unknown built-in tool ${tool}.` };
}
