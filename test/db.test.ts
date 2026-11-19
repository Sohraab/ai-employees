/**
 * Integration test: applies the real migration to an in-process Postgres
 * (PGlite), seeds the example org, and checks identity, access and memory
 * end to end. No Docker needed.
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { authorizeRequest, authorizeToolCall } from "../src/core/access.js";
import { resolveCaller } from "../src/core/identity.js";
import { recallMemories, remember } from "../src/core/memory.js";
import * as schema from "../src/db/schema.js";
import { seed, type SeedResult } from "../src/db/seed-data.js";

const db = drizzle(new PGlite(), { schema });
let data: SeedResult;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  data = await seed(db);
});

async function loadAgent(agentId: string) {
  const agent = await db.query.agents.findFirst({
    where: eq(schema.agents.id, agentId),
    with: { grants: true, tools: true },
  });
  if (!agent) throw new Error("agent not found");
  return agent;
}

describe("identity", () => {
  it("resolves the same person across channels", async () => {
    const viaSlack = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "slack",
      handle: "U_RECRUITER",
      proof: { signatureValid: true },
    });
    const viaEmail = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "email",
      handle: "  Riley@Example.com ",
      proof: { emailAuthPassed: true },
    });
    expect(viaSlack?.id).toBe(data.people.recruiter.id);
    expect(viaEmail?.id).toBe(data.people.recruiter.id);
    expect(viaEmail?.trust).toBe("verified");
  });

  it("treats spoofable or unverified identities as low trust", async () => {
    const spoofed = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "email",
      handle: "riley@example.com",
      proof: { emailAuthPassed: false },
    });
    expect(spoofed?.trust).toBe("unverified");

    const unverifiedNumber = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "whatsapp",
      handle: "+49 151 0000002",
      proof: { signatureValid: true },
    });
    expect(unverifiedNumber?.id).toBe(data.people.seller.id);
    expect(unverifiedNumber?.trust).toBe("unverified");
  });

  it("returns null for unknown senders", async () => {
    const who = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "email",
      handle: "stranger@elsewhere.com",
      proof: { emailAuthPassed: true },
    });
    expect(who).toBeNull();
  });
});

describe("access with seeded data", () => {
  it("lets the Talent team request outreach, gated by manager approval", async () => {
    const nova = await loadAgent(data.agents.sourcer.id);
    const recruiter = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "slack",
      handle: "U_RECRUITER",
      proof: { signatureValid: true },
    });
    const decision = authorizeToolCall({
      agent: nova,
      toolRules: nova.tools,
      grants: nova.grants,
      caller: recruiter!,
      tool: "gmail.send_message",
    });
    expect(decision).toEqual({ kind: "needs_approval", approverId: data.people.headOfTalent.id });
  });

  it("lets Sales request sourcing but not candidate outreach", async () => {
    const nova = await loadAgent(data.agents.sourcer.id);
    const seller = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "slack",
      handle: "U_SELLER",
      proof: { signatureValid: true },
    });
    expect(authorizeRequest(nova, nova.grants, seller).kind).toBe("allow");
    expect(
      authorizeToolCall({ agent: nova, toolRules: nova.tools, grants: nova.grants, caller: seller!, tool: "gmail.send_message" }),
    ).toEqual({ kind: "deny", reason: "caller_lacks_access" });
  });

  it("keeps Ops out of the sourcer but lets everyone talk to the reporter", async () => {
    const nova = await loadAgent(data.agents.sourcer.id);
    const atlas = await loadAgent(data.agents.reporter.id);
    const ops = await resolveCaller(db, { orgId: data.orgId, channel: "slack", handle: "U_OPS", proof: { signatureValid: true } });
    const seller = await resolveCaller(db, {
      orgId: data.orgId,
      channel: "slack",
      handle: "U_SELLER",
      proof: { signatureValid: true },
    });

    expect(authorizeRequest(nova, nova.grants, ops)).toEqual({ kind: "receptionist", reason: "no_access" });
    expect(authorizeRequest(atlas, atlas.grants, seller)).toEqual({ kind: "allow", level: "talk" });
    expect(
      authorizeToolCall({ agent: atlas, toolRules: atlas.tools, grants: atlas.grants, caller: seller!, tool: "slack.post_message" })
        .kind,
    ).toBe("deny");
  });
});

describe("memory visibility", () => {
  it("shows private memories only to their owner and team memories only to the team", async () => {
    const agentId = data.agents.sourcer.id;
    const forRiley = await recallMemories(db, {
      agentId,
      requester: { personId: data.people.recruiter.id, teamId: data.teams.talent.id },
    });
    const forSam = await recallMemories(db, {
      agentId,
      requester: { personId: data.people.seller.id, teamId: data.teams.sales.id },
    });
    const forStranger = await recallMemories(db, { agentId, requester: { personId: null, teamId: null } });

    expect(forRiley.map((m) => m.visibility).sort()).toEqual(["agent_wide", "private", "team"]);
    expect(forSam.map((m) => m.visibility)).toEqual(["agent_wide"]);
    expect(forStranger.map((m) => m.visibility)).toEqual(["agent_wide"]);
  });

  it("searches memories by text", async () => {
    const agentId = data.agents.sourcer.id;
    await remember(db, {
      agentId,
      visibility: "agent_wide",
      content: "The Rust backend role needs Kubernetes experience.",
    });
    const hits = await recallMemories(db, {
      agentId,
      requester: { personId: null, teamId: null },
      query: "kubernetes",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("Kubernetes");
  });

  it("rejects private memories without an owner at the database level", async () => {
    await expect(
      db.insert(schema.memories).values({ agentId: data.agents.sourcer.id, visibility: "private", content: "x" }),
    ).rejects.toThrow();
  });
});
