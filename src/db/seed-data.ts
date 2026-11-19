/**
 * Example org with two AI employees. Used by `npm run db:seed` and by tests.
 * All people and addresses are placeholders.
 */
import type { Db } from "./client.js";
import * as s from "./schema.js";

export async function seed(db: Db) {
  const [org] = await db.insert(s.organizations).values({ name: "Example Co", slug: "example" }).returning();
  const orgId = org!.id;

  const [talent, sales, ops] = await db
    .insert(s.teams)
    .values([
      { orgId, name: "Talent" },
      { orgId, name: "Sales" },
      { orgId, name: "Ops" },
    ])
    .returning();

  const [admin, headOfTalent, recruiter, seller, opsLead] = await db
    .insert(s.people)
    .values([
      { orgId, name: "Avery Admin", role: "founder", isOrgAdmin: true },
      { orgId, name: "Harper Lee-Talent", role: "head_of_talent", teamId: talent!.id },
      { orgId, name: "Riley Recruiter", role: "recruiter", teamId: talent!.id },
      { orgId, name: "Sam Seller", role: "account_executive", teamId: sales!.id },
      { orgId, name: "Morgan Ops", role: "ops_lead", teamId: ops!.id },
    ])
    .returning();

  const now = new Date();
  await db.insert(s.personIdentities).values([
    { orgId, personId: admin!.id, channel: "slack", handle: "U_ADMIN", verifiedAt: now },
    { orgId, personId: admin!.id, channel: "email", handle: "avery@example.com", verifiedAt: now },
    { orgId, personId: headOfTalent!.id, channel: "slack", handle: "U_HEAD_TALENT", verifiedAt: now },
    { orgId, personId: headOfTalent!.id, channel: "whatsapp", handle: "+491510000001", verifiedAt: now },
    { orgId, personId: recruiter!.id, channel: "slack", handle: "U_RECRUITER", verifiedAt: now },
    { orgId, personId: recruiter!.id, channel: "email", handle: "riley@example.com", verifiedAt: now },
    { orgId, personId: seller!.id, channel: "slack", handle: "U_SELLER", verifiedAt: now },
    // Not yet verified: treated as low trust until an OTP check.
    { orgId, personId: seller!.id, channel: "whatsapp", handle: "+491510000002", verifiedAt: null },
    { orgId, personId: opsLead!.id, channel: "slack", handle: "U_OPS", verifiedAt: now },
  ]);

  // --- AI employee 1: recruiting sourcer --------------------------------------
  const [sourcer] = await db
    .insert(s.agents)
    .values({
      orgId,
      slug: "sourcer",
      name: "Nova",
      role: "Recruiting Sourcer",
      instructions:
        "You are Nova, a recruiting sourcer on the Talent team. You find and shortlist candidates, " +
        "draft outreach, and keep hiring managers updated. Never contact a candidate without an approved message.",
      model: "claude-opus-5-5",
      effort: "high",
      managerId: headOfTalent!.id,
      teamId: talent!.id,
      executorWorkspace: "sourcer",
      monthlyBudgetUsd: "300.00",
    })
    .returning();

  await db.insert(s.agentSkills).values([
    {
      agentId: sourcer!.id,
      name: "candidate-shortlist",
      description: "How to build and present a candidate shortlist for a role.",
      content: "# Candidate shortlist\n\n1. Read the role brief.\n2. Search sources.\n3. Rank by must-haves first.\n",
    },
    {
      agentId: sourcer!.id,
      name: "outreach-style",
      description: "House style for first outreach to candidates.",
      content: "# Outreach style\n\nShort, specific, no hype. Mention why this person, why now.\n",
    },
  ]);

  await db.insert(s.agentTools).values([
    { agentId: sourcer!.id, toolPattern: "ats.*", minLevel: "assign" },
    { agentId: sourcer!.id, toolPattern: "web.search", minLevel: "talk" },
    {
      agentId: sourcer!.id,
      toolPattern: "gmail.send_message",
      minLevel: "assign",
      requiredScope: "candidate_outreach",
      requiresApproval: true,
    },
    {
      agentId: sourcer!.id,
      toolPattern: "ats.send_offer",
      minLevel: "manage",
      requiredScope: "offers",
      requiresApproval: true,
    },
  ]);

  await db.insert(s.agentChannels).values([
    { agentId: sourcer!.id, channel: "slack", address: "B_NOVA" },
    { agentId: sourcer!.id, channel: "email", address: "nova@agents.example.com" },
  ]);

  await db.insert(s.accessGrants).values([
    // Whole Talent team can give Nova work, including candidate outreach.
    { agentId: sourcer!.id, subjectType: "team", subjectId: talent!.id, level: "assign", grantedById: admin!.id },
    // Sales can ask questions and request sourcing, but not outreach.
    {
      agentId: sourcer!.id,
      subjectType: "team",
      subjectId: sales!.id,
      level: "assign",
      scopes: ["sourcing"],
      grantedById: admin!.id,
    },
  ]);

  // --- AI employee 2: ops reporter --------------------------------------------
  const [reporter] = await db
    .insert(s.agents)
    .values({
      orgId,
      slug: "ops-reporter",
      name: "Atlas",
      role: "Ops Reporter",
      instructions:
        "You are Atlas. You pull numbers from the warehouse, explain changes, and post clear summaries.",
      model: "claude-sonnet-5-5",
      effort: "medium",
      managerId: opsLead!.id,
      teamId: ops!.id,
      executorWorkspace: "ops-reporter",
    })
    .returning();

  await db.insert(s.agentTools).values([
    { agentId: reporter!.id, toolPattern: "bigquery.query_readonly", minLevel: "talk" },
    { agentId: reporter!.id, toolPattern: "slack.post_message", minLevel: "assign" },
  ]);

  await db.insert(s.agentChannels).values([{ agentId: reporter!.id, channel: "slack", address: "B_ATLAS" }]);

  await db.insert(s.accessGrants).values([
    { agentId: reporter!.id, subjectType: "everyone", subjectId: null, level: "talk", grantedById: admin!.id },
    { agentId: reporter!.id, subjectType: "team", subjectId: ops!.id, level: "assign", grantedById: admin!.id },
  ]);

  await db.insert(s.routines).values({
    agentId: reporter!.id,
    name: "Weekday metrics digest",
    cron: "47 8 * * 1-5",
    timezone: "Europe/Berlin",
    prompt: "Summarize yesterday's signups, activations and revenue vs. the 7-day average. Flag anything unusual.",
    runAsId: opsLead!.id,
    deliverChannel: "slack",
    deliverTarget: "C_METRICS",
    createdById: opsLead!.id,
  });

  await db.insert(s.memories).values([
    {
      agentId: sourcer!.id,
      visibility: "agent_wide",
      content: "Candidates in Berlin usually prefer hybrid roles with two office days.",
    },
    {
      agentId: sourcer!.id,
      visibility: "team",
      teamId: talent!.id,
      content: "Hiring process: recruiter screen, hiring manager interview, take-home, final round.",
    },
    {
      agentId: sourcer!.id,
      visibility: "private",
      ownerPersonId: recruiter!.id,
      content: "Riley prefers shortlists of five candidates, sent before 10am.",
    },
  ]);

  return {
    orgId,
    teams: { talent: talent!, sales: sales!, ops: ops! },
    people: { admin: admin!, headOfTalent: headOfTalent!, recruiter: recruiter!, seller: seller!, opsLead: opsLead! },
    agents: { sourcer: sourcer!, reporter: reporter! },
  };
}

export type SeedResult = Awaited<ReturnType<typeof seed>>;
