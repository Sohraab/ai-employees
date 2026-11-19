import { describe, expect, it } from "vitest";
import {
  authorizeRequest,
  authorizeToolCall,
  findToolRule,
  hasAccess,
  highestLevel,
  type Caller,
  type GrantLike,
  type ToolRule,
} from "../src/core/access.js";

const agent = { managerId: "manager", status: "active" as const };

const caller = (over: Partial<Caller> = {}): Caller => ({
  id: "alice",
  teamId: "talent",
  role: "recruiter",
  isOrgAdmin: false,
  trust: "verified",
  ...over,
});

const grant = (over: Partial<GrantLike>): GrantLike => ({
  subjectType: "everyone",
  subjectId: null,
  level: "talk",
  scopes: [],
  expiresAt: null,
  ...over,
});

describe("hasAccess", () => {
  it("matches person, team, role and everyone grants", () => {
    expect(hasAccess(agent, [grant({ subjectType: "person", subjectId: "alice" })], caller(), { level: "talk" })).toBe(true);
    expect(hasAccess(agent, [grant({ subjectType: "team", subjectId: "talent" })], caller(), { level: "talk" })).toBe(true);
    expect(hasAccess(agent, [grant({ subjectType: "role", subjectId: "recruiter" })], caller(), { level: "talk" })).toBe(true);
    expect(hasAccess(agent, [grant({})], caller(), { level: "talk" })).toBe(true);
    expect(hasAccess(agent, [grant({ subjectType: "team", subjectId: "sales" })], caller(), { level: "talk" })).toBe(false);
  });

  it("requires a high enough level", () => {
    const grants = [grant({ level: "talk" })];
    expect(hasAccess(agent, grants, caller(), { level: "assign" })).toBe(false);
  });

  it("does not combine separate grants into more power", () => {
    const grants = [grant({ level: "talk" }), grant({ level: "assign", scopes: ["refunds"] })];
    expect(hasAccess(agent, grants, caller(), { level: "assign", scope: "refunds" })).toBe(true);
    expect(hasAccess(agent, grants, caller(), { level: "assign", scope: "payroll" })).toBe(false);
  });

  it("ignores expired grants", () => {
    const grants = [grant({ level: "assign", expiresAt: new Date("2020-01-01") })];
    expect(hasAccess(agent, grants, caller(), { level: "talk" })).toBe(false);
  });

  it("gives the manager and org admins implicit access", () => {
    expect(hasAccess(agent, [], caller({ id: "manager" }), { level: "manage" })).toBe(true);
    expect(hasAccess(agent, [], caller({ isOrgAdmin: true }), { level: "admin" })).toBe(true);
  });

  it("caps unverified senders at talk", () => {
    const grants = [grant({ level: "admin" })];
    const c = caller({ trust: "unverified" });
    expect(hasAccess(agent, grants, c, { level: "talk" })).toBe(true);
    expect(hasAccess(agent, grants, c, { level: "assign" })).toBe(false);
    expect(highestLevel(agent, grants, c)).toBe("talk");
  });
});

describe("authorizeRequest", () => {
  it("sends unknown senders and people without access to receptionist mode", () => {
    expect(authorizeRequest(agent, [], null)).toEqual({ kind: "receptionist", reason: "unknown_sender" });
    expect(authorizeRequest(agent, [], caller())).toEqual({ kind: "receptionist", reason: "no_access" });
  });

  it("rejects requests to paused agents", () => {
    expect(authorizeRequest({ ...agent, status: "paused" }, [grant({})], caller()).kind).toBe("reject");
  });

  it("allows with the caller's highest level", () => {
    expect(authorizeRequest(agent, [grant({ level: "assign" })], caller())).toEqual({ kind: "allow", level: "assign" });
  });
});

describe("tool rules", () => {
  const rules: ToolRule[] = [
    { toolPattern: "gmail.*", minLevel: "assign", requiredScope: null, requiresApproval: false },
    { toolPattern: "gmail.send_message", minLevel: "assign", requiredScope: "outreach", requiresApproval: true },
    { toolPattern: "web.search", minLevel: "talk", requiredScope: null, requiresApproval: false },
  ];

  it("picks the most specific rule", () => {
    expect(findToolRule(rules, "gmail.send_message")?.toolPattern).toBe("gmail.send_message");
    expect(findToolRule(rules, "gmail.read_thread")?.toolPattern).toBe("gmail.*");
    expect(findToolRule(rules, "drive.delete")).toBeUndefined();
  });

  const base = { agent, toolRules: rules };

  it("denies tools the agent does not have", () => {
    const d = authorizeToolCall({ ...base, grants: [grant({ level: "admin" })], caller: caller(), tool: "drive.delete" });
    expect(d).toEqual({ kind: "deny", reason: "agent_lacks_tool" });
  });

  it("denies when the caller lacks the level or scope (intersection)", () => {
    const talkOnly = [grant({ level: "talk" })];
    expect(authorizeToolCall({ ...base, grants: talkOnly, caller: caller(), tool: "gmail.read_thread" }).kind).toBe("deny");
    expect(authorizeToolCall({ ...base, grants: talkOnly, caller: caller(), tool: "web.search" }).kind).toBe("allow");

    const wrongScope = [grant({ level: "assign", scopes: ["sourcing"] })];
    expect(authorizeToolCall({ ...base, grants: wrongScope, caller: caller(), tool: "gmail.send_message" })).toEqual({
      kind: "deny",
      reason: "caller_lacks_access",
    });
  });

  it("routes risky tools to the manager for approval", () => {
    const grants = [grant({ level: "assign", scopes: ["outreach"] })];
    expect(authorizeToolCall({ ...base, grants, caller: caller(), tool: "gmail.send_message" })).toEqual({
      kind: "needs_approval",
      approverId: "manager",
    });
  });

  it("lets the manager run risky tools without waiting on themselves", () => {
    expect(authorizeToolCall({ ...base, grants: [], caller: caller({ id: "manager" }), tool: "gmail.send_message" })).toEqual({
      kind: "allow",
    });
  });

  it("denies risky tools when the agent has no manager to approve", () => {
    const grants = [grant({ level: "assign", scopes: ["outreach"] })];
    const d = authorizeToolCall({
      ...base,
      agent: { managerId: null, status: "active" },
      grants,
      caller: caller(),
      tool: "gmail.send_message",
    });
    expect(d).toEqual({ kind: "deny", reason: "no_approver" });
  });
});
