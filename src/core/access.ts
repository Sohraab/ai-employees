/**
 * Permission checks. Pure functions, no database access, so they are easy to
 * test and to reason about.
 *
 * Two questions are asked for every action, and both must say yes:
 *   1. Is the CALLER allowed to ask this agent for this?  (access grants)
 *   2. Is the AGENT allowed to do it?                     (agent tools)
 */
import type { AccessGrant, AccessLevel, Agent, AgentTool, Person } from "../db/schema.js";

export const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = {
  talk: 1,
  assign: 2,
  manage: 3,
  admin: 4,
};

export function atLeast(level: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_LEVEL_RANK[level] >= ACCESS_LEVEL_RANK[required];
}

/** How much we trust that the sender really is who the channel says. */
export type IdentityTrust = "verified" | "unverified";

export type Caller = Pick<Person, "id" | "teamId" | "role" | "isOrgAdmin"> & {
  trust: IdentityTrust;
};

export type GrantLike = Pick<AccessGrant, "subjectType" | "subjectId" | "level" | "scopes" | "expiresAt">;
export type AgentLike = Pick<Agent, "managerId" | "status">;
export type ToolRule = Pick<AgentTool, "toolPattern" | "requiresApproval" | "requiredScope" | "minLevel">;

/** Grants that apply to this caller right now. */
export function applicableGrants(grants: GrantLike[], caller: Caller, now = new Date()): GrantLike[] {
  return grants.filter((g) => {
    if (g.expiresAt && g.expiresAt <= now) return false;
    switch (g.subjectType) {
      case "everyone":
        return true;
      case "person":
        return g.subjectId === caller.id;
      case "team":
        return caller.teamId != null && g.subjectId === caller.teamId;
      case "role":
        return caller.role != null && g.subjectId === caller.role;
    }
  });
}

/**
 * Grants a caller holds implicitly: org admins administer every agent, and an
 * agent's manager can manage it.
 */
function implicitGrants(agent: AgentLike, caller: Caller): GrantLike[] {
  const out: GrantLike[] = [];
  if (caller.isOrgAdmin) {
    out.push({ subjectType: "person", subjectId: caller.id, level: "admin", scopes: [], expiresAt: null });
  }
  if (agent.managerId && agent.managerId === caller.id) {
    out.push({ subjectType: "person", subjectId: caller.id, level: "manage", scopes: [], expiresAt: null });
  }
  return out;
}

export interface AccessQuery {
  level: AccessLevel;
  /** Kind of work, e.g. "candidate_outreach". Omit for work that needs no scope. */
  scope?: string | null;
}

/**
 * Does the caller hold a grant with at least `level` that covers `scope`?
 * A grant with no scopes covers every scope at its level. Grants are checked
 * one by one, never merged, so "talk about anything" plus "assign refunds"
 * does NOT add up to "assign anything".
 *
 * Unverified identities (e.g. an email that failed DKIM) are capped at "talk".
 */
export function hasAccess(
  agent: AgentLike,
  grants: GrantLike[],
  caller: Caller,
  query: AccessQuery,
  now = new Date(),
): boolean {
  if (caller.trust === "unverified" && !atLeast("talk", query.level)) return false;

  const all = [...implicitGrants(agent, caller), ...applicableGrants(grants, caller, now)];
  return all.some(
    (g) =>
      atLeast(g.level, query.level) &&
      (g.scopes.length === 0 || query.scope == null || g.scopes.includes(query.scope)),
  );
}

/** Highest level the caller holds for any scope. Useful for UIs and routing. */
export function highestLevel(
  agent: AgentLike,
  grants: GrantLike[],
  caller: Caller,
  now = new Date(),
): AccessLevel | null {
  const all = [...implicitGrants(agent, caller), ...applicableGrants(grants, caller, now)];
  let best: AccessLevel | null = null;
  for (const g of all) {
    if (!best || ACCESS_LEVEL_RANK[g.level] > ACCESS_LEVEL_RANK[best]) best = g.level;
  }
  if (best && caller.trust === "unverified" && atLeast(best, "assign")) return "talk";
  return best;
}

// ---------------------------------------------------------------------------
// Inbound requests
// ---------------------------------------------------------------------------

export type RequestDecision =
  | { kind: "allow"; level: AccessLevel }
  | { kind: "receptionist"; reason: "unknown_sender" | "no_access" }
  | { kind: "reject"; reason: "agent_inactive" };

/**
 * First gate for any inbound message. Unknown senders and people without a
 * grant get "receptionist" mode: a polite reply or a hand-off to the manager,
 * never any action.
 */
export function authorizeRequest(
  agent: AgentLike,
  grants: GrantLike[],
  caller: Caller | null,
  now = new Date(),
): RequestDecision {
  if (agent.status !== "active") return { kind: "reject", reason: "agent_inactive" };
  if (!caller) return { kind: "receptionist", reason: "unknown_sender" };
  const level = highestLevel(agent, grants, caller, now);
  if (!level) return { kind: "receptionist", reason: "no_access" };
  return { kind: "allow", level };
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/** "gmail.*" matches "gmail.send_message"; "*" matches everything. */
export function matchesPattern(pattern: string, tool: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/** Most specific rule wins: exact name beats a longer wildcard beats a shorter one. */
export function findToolRule<T extends ToolRule>(rules: T[], tool: string): T | undefined {
  const specificity = (p: string) => (p.endsWith("*") ? p.length - 1 : Number.MAX_SAFE_INTEGER);
  return rules
    .filter((r) => matchesPattern(r.toolPattern, tool))
    .sort((a, b) => specificity(b.toolPattern) - specificity(a.toolPattern))[0];
}

export type ToolDecision =
  | { kind: "allow" }
  | { kind: "needs_approval"; approverId: string }
  | { kind: "deny"; reason: "agent_lacks_tool" | "caller_lacks_access" | "no_approver" };

/**
 * Effective permission = what the caller is granted ∩ what the agent can do.
 * A junior person cannot use a powerful agent to do something they could not
 * ask for themselves.
 */
export function authorizeToolCall(params: {
  agent: AgentLike;
  toolRules: ToolRule[];
  grants: GrantLike[];
  caller: Caller;
  tool: string;
  now?: Date;
}): ToolDecision {
  const { agent, toolRules, grants, caller, tool, now } = params;

  const rule = findToolRule(toolRules, tool);
  if (!rule) return { kind: "deny", reason: "agent_lacks_tool" };

  const ok = hasAccess(agent, grants, caller, { level: rule.minLevel, scope: rule.requiredScope }, now);
  if (!ok) return { kind: "deny", reason: "caller_lacks_access" };

  if (rule.requiresApproval) {
    // The manager is the approver, so their own request goes ahead.
    if (agent.managerId === caller.id) return { kind: "allow" };
    if (!agent.managerId) return { kind: "deny", reason: "no_approver" };
    return { kind: "needs_approval", approverId: agent.managerId };
  }
  return { kind: "allow" };
}
