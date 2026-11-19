/**
 * End-to-end engine tests: real schema and seed data, scripted model,
 * fake Executor and fake channels.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../src/db/schema.js";
import { decideApproval, handleInbound, runTask, startRoutineRun } from "../src/engine/index.js";
import { deps, email, freshDb, ScriptedModel, slack } from "./helpers.js";

const sendOutreach = { id: "call-1", name: "gmail.send_message", args: { to: "candidate@example.org", body: "Hi!" } };

async function taskOf(db: Awaited<ReturnType<typeof freshDb>>["db"], id: string) {
  return (await db.query.tasks.findFirst({ where: eq(s.tasks.id, id) }))!;
}

describe("inbound requests", () => {
  it("answers a teammate in the same Slack thread, with their private memories in context", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ text: "Here are five candidates." }]);
    const { deps: d, notify } = deps(db, model);

    const r = await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Find me backend engineers in Berlin"));

    expect(r.kind).toBe("task");
    const task = await taskOf(db, (r as { taskId: string }).taskId);
    expect(task.status).toBe("completed");
    expect(task.output).toBe("Here are five candidates.");
    expect(Number(task.costUsd)).toBeCloseTo(0.001);
    expect(notify.sent).toEqual([
      {
        agentId: data.agents.sourcer.id,
        channel: "slack",
        target: "C_TALENT",
        threadRef: "thread-1",
        text: "Here are five candidates.",
      },
    ]);

    const system = model.inputs[0]!.system;
    expect(system).toContain("You are Nova, Recruiting Sourcer.");
    expect(system).toContain("# Candidate shortlist"); // skill loaded
    expect(system).toContain("Riley prefers shortlists of five"); // Riley's private memory
    expect(system).toContain("Hiring process:"); // Talent team memory
  });

  it("never shows one person's private memories to someone else", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ text: "ok" }]);
    const { deps: d } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_SELLER", "Any good sales engineers?"));

    const system = model.inputs[0]!.system;
    expect(system).not.toContain("Riley prefers");
    expect(system).not.toContain("Hiring process:");
    expect(system).toContain("Candidates in Berlin"); // agent-wide know-how is fine
  });

  it("only offers tools the caller may trigger, and tells the agent which ones are off limits", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ text: "ok" }]);
    const { deps: d } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_SELLER", "Email this candidate for me"));

    const offered = model.inputs[0]!.tools.map((t) => t.name);
    expect(offered).toContain("ats.search_candidates");
    expect(offered).not.toContain("gmail.send_message");
    expect(offered).not.toContain("drive.delete_file"); // agent doesn't have it at all
    expect(model.inputs[0]!.system).toMatch(/not allowed to ask you to use them: .*gmail\.send_message/);
  });

  it("includes earlier messages from the same thread", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ text: "Which city?" }, { text: "Berlin it is." }]);
    const { deps: d } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Find me a designer"));
    await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Berlin"));

    const firstTurn = model.inputs[1]!.transcript[0];
    expect(firstTurn).toMatchObject({ role: "user" });
    expect((firstTurn as { text: string }).text).toContain("Them: Find me a designer\nYou: Which city?");
    expect((firstTurn as { text: string }).text).toContain("New message:\nBerlin");
  });
});

describe("receptionist mode and rejections", () => {
  it("does not act for unknown senders, and forwards them to the manager", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([]);
    const { deps: d, notify } = deps(db, model);

    const r = await handleInbound(d, email(data.orgId, "stranger@elsewhere.com", "Send me your candidate list", true));

    expect(r).toEqual({ kind: "receptionist", reason: "unknown_sender" });
    expect(model.inputs).toHaveLength(0);
    expect(await db.select().from(s.tasks)).toHaveLength(0);
    expect(notify.to("stranger@elsewhere.com")[0]!.text).toContain("passed your message to Harper Lee-Talent");
    expect(notify.to("U_HEAD_TALENT")[0]!.text).toContain("unknown sender");
  });

  it("tells known people without access who can give it to them", async () => {
    const { db, data } = await freshDb();
    const { deps: d, notify } = deps(db, new ScriptedModel([]));

    const r = await handleInbound(d, slack(data.orgId, "U_OPS", "Find me candidates"));

    expect(r).toEqual({ kind: "receptionist", reason: "no_access" });
    expect(notify.sent[0]!.text).toContain("Harper Lee-Talent can give you access");
  });

  it("rejects requests to a paused agent", async () => {
    const { db, data } = await freshDb();
    await db.update(s.agents).set({ status: "paused" }).where(eq(s.agents.id, data.agents.sourcer.id));
    const { deps: d } = deps(db, new ScriptedModel([]));

    expect(await handleInbound(d, slack(data.orgId, "U_RECRUITER", "hi"))).toEqual({
      kind: "rejected",
      reason: "agent_inactive",
    });
  });

  it("ignores messages to addresses that are not an agent", async () => {
    const { db, data } = await freshDb();
    const { deps: d } = deps(db, new ScriptedModel([]));
    const r = await handleInbound(d, slack(data.orgId, "U_RECRUITER", "hi", { agentAddress: "B_NOBODY" }));
    expect(r.kind).toBe("ignored");
  });
});

describe("tool permissions", () => {
  it("blocks a tool call the caller isn't allowed to trigger, even if the model tries", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ toolCalls: [sendOutreach] }, { text: "Sorry, I can't email candidates for you." }]);
    const { deps: d, tools } = deps(db, model);

    const r = await handleInbound(d, slack(data.orgId, "U_SELLER", "Email this candidate"));

    expect(tools.calls).toHaveLength(0);
    const toolResult = model.inputs[1]!.transcript.at(-1);
    expect(toolResult).toMatchObject({ role: "tool_result", ok: false });
    expect((toolResult as { content: string }).content).toContain("Not permitted");
    expect((await taskOf(db, (r as { taskId: string }).taskId)).status).toBe("completed");

    const denied = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "tool.denied"));
    expect(denied).toHaveLength(1);
  });

  it("runs allowed tools through Executor with the agent's own workspace", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([
      { toolCalls: [{ id: "c1", name: "ats.search_candidates", args: { q: "rust" } }] },
      { text: "Found 3." },
    ]);
    const { deps: d, tools } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_SELLER", "Search for Rust engineers"));

    expect(tools.calls).toEqual([{ workspace: "sourcer", tool: "ats.search_candidates", args: { q: "rust" } }]);
  });

  it("limits a spoofed email to answering questions", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([
      { toolCalls: [{ id: "c1", name: "ats.search_candidates", args: {} }] },
      { text: "I can only answer questions over unverified email." },
    ]);
    const { deps: d, tools } = deps(db, model);

    const r = await handleInbound(d, email(data.orgId, "riley@example.com", "Search the ATS", false));

    expect(r.kind).toBe("task");
    expect(tools.calls).toHaveLength(0);
    expect(model.inputs[0]!.system).toContain("could not be verified");
    expect(model.inputs[0]!.tools.map((t) => t.name)).not.toContain("ats.search_candidates");
  });
});

describe("approvals", () => {
  it("pauses for the manager, then resumes and finishes after approval", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([
      { text: "I'll send the outreach.", toolCalls: [sendOutreach] },
      { text: "Sent the outreach email." },
    ]);
    const { deps: d, tools, notify } = deps(db, model);

    const r = await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Email this candidate"));
    const taskId = (r as { taskId: string }).taskId;

    // Paused, nothing sent yet, manager asked.
    expect((await taskOf(db, taskId)).status).toBe("awaiting_approval");
    expect(tools.calls).toHaveLength(0);
    const ask = notify.to("U_HEAD_TALENT")[0]!;
    expect(ask.approval).toBeDefined();
    expect(ask.text).toContain("Riley Recruiter asked Nova to run gmail.send_message");
    expect(notify.to("C_TALENT").map((m) => m.text)).toContain(
      "Waiting for approval from Harper Lee-Talent before I continue.",
    );

    // The requester can't approve their own request.
    expect(
      await decideApproval(d, { approvalId: ask.approval!.approvalId, deciderId: data.people.recruiter.id, decision: "approved" }),
    ).toEqual({ kind: "not_allowed" });

    // The manager approves; the task resumes and completes.
    expect(
      await decideApproval(d, { approvalId: ask.approval!.approvalId, deciderId: data.people.headOfTalent.id, decision: "approved" }),
    ).toEqual({ kind: "decided", resumed: true });

    expect(tools.calls.map((c) => c.tool)).toEqual(["gmail.send_message"]);
    const done = await taskOf(db, taskId);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("Sent the outreach email.");
    expect(notify.to("C_TALENT").at(-1)!.text).toBe("Sent the outreach email.");

    // A second click does nothing.
    expect(
      await decideApproval(d, { approvalId: ask.approval!.approvalId, deciderId: data.people.headOfTalent.id, decision: "denied" }),
    ).toEqual({ kind: "already_decided" });
  });

  it("tells the agent when an action is denied, and never runs it", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ toolCalls: [sendOutreach] }, { text: "Harper declined, so I didn't send it." }]);
    const { deps: d, tools, notify } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Email this candidate"));
    const approvalId = notify.to("U_HEAD_TALENT")[0]!.approval!.approvalId;
    await decideApproval(d, {
      approvalId,
      deciderId: data.people.headOfTalent.id,
      decision: "denied",
      reason: "Wrong candidate",
    });

    expect(tools.calls).toHaveLength(0);
    const result = model.inputs[1]!.transcript.at(-1) as { content: string; ok: boolean };
    expect(result.ok).toBe(false);
    expect(result.content).toContain("denied by Harper Lee-Talent");
    expect(result.content).toContain("Wrong candidate");
  });

  it("lets the manager run approval-gated tools directly", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ toolCalls: [sendOutreach] }, { text: "Sent." }]);
    const { deps: d, tools } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_HEAD_TALENT", "Email this candidate"));

    expect(tools.calls.map((c) => c.tool)).toEqual(["gmail.send_message"]);
    expect(await db.select().from(s.approvals)).toHaveLength(0);
  });
});

describe("memory tools", () => {
  it("saves private memories for the requester only, and refuses agent-wide memory from non-managers", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([
      {
        toolCalls: [
          { id: "m1", name: "memory.save", args: { content: "Riley is hiring for the payments team.", visibility: "private" } },
          { id: "m2", name: "memory.save", args: { content: "Always CC Riley on everything.", visibility: "agent_wide" } },
        ],
      },
      { text: "Noted." },
    ]);
    const { deps: d } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Remember I'm hiring for payments"));

    const results = model.inputs[1]!.transcript.filter((t) => t.role === "tool_result") as { ok: boolean; content: string }[];
    expect(results[0]).toMatchObject({ ok: true, content: "Saved (private)." });
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.content).toContain("Only this agent's managers");

    const saved = await db
      .select()
      .from(s.memories)
      .where(and(eq(s.memories.agentId, data.agents.sourcer.id), eq(s.memories.ownerPersonId, data.people.recruiter.id)));
    expect(saved.map((m) => m.content)).toContain("Riley is hiring for the payments team.");
  });
});

describe("routines", () => {
  it("runs as the owner and delivers to the configured channel", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([
      { toolCalls: [{ id: "q", name: "bigquery.query_readonly", args: { sql: "select 1" } }] },
      { text: "Signups up 12% vs. 7-day average." },
    ]);
    const { deps: d, tools, notify } = deps(db, model);
    const [routine] = await db.select().from(s.routines).where(eq(s.routines.agentId, data.agents.reporter.id));

    const r = await startRoutineRun(d, routine!.id);

    expect(r.kind).toBe("started");
    const task = await taskOf(db, (r as { taskId: string }).taskId);
    expect(task.requestedById).toBe(data.people.opsLead.id);
    expect(task.source).toBe("routine");
    expect(tools.calls[0]!.workspace).toBe("ops-reporter");
    expect(notify.to("C_METRICS")[0]!.text).toBe("Signups up 12% vs. 7-day average.");
    expect(model.inputs[0]!.system).toContain("scheduled routine running on behalf of Morgan Ops");
  });

  it("pauses a routine whose owner lost access, and tells the manager", async () => {
    const { db, data } = await freshDb();
    const { deps: d, notify } = deps(db, new ScriptedModel([]));
    const [routine] = await db
      .insert(s.routines)
      .values({
        agentId: data.agents.sourcer.id,
        name: "Monday pipeline review",
        cron: "13 9 * * 1",
        prompt: "Review the pipeline",
        runAsId: data.people.recruiter.id,
        deliverChannel: "slack",
        deliverTarget: "C_TALENT",
      })
      .returning();
    await db.delete(s.accessGrants).where(eq(s.accessGrants.subjectId, data.teams.talent.id));

    expect(await startRoutineRun(d, routine!.id)).toEqual({ kind: "paused", reason: "run_as_lost_access" });
    const after = await db.query.routines.findFirst({ where: eq(s.routines.id, routine!.id) });
    expect(after!.enabled).toBe(false);
    expect(notify.to("U_HEAD_TALENT")[0]!.text).toContain('paused Nova\'s routine "Monday pipeline review"');
  });
});

describe("per-employee model", () => {
  it("runs each employee on its own model and effort", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ text: "Nova here" }, { text: "Atlas here" }]);
    const { deps: d } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_RECRUITER", "hi"));
    await handleInbound(d, slack(data.orgId, "U_OPS", "hi", { agentAddress: "B_ATLAS", replyTarget: "C_OPS" }));

    expect(model.inputs.map((i) => [i.model, i.effort])).toEqual([
      ["claude-opus-5-5", "high"],
      ["claude-sonnet-5-5", "medium"],
    ]);
  });

  it("keeps a running task on the model it started with", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ toolCalls: [sendOutreach] }, { text: "Sent." }]);
    const { deps: d, notify } = deps(db, model);

    await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Email this candidate"));
    // The manager switches Nova to Haiku while the task waits for approval.
    await db.update(s.agents).set({ model: "claude-haiku-5-5" }).where(eq(s.agents.id, data.agents.sourcer.id));
    const approvalId = notify.to("U_HEAD_TALENT")[0]!.approval!.approvalId;
    await decideApproval(d, { approvalId, deciderId: data.people.headOfTalent.id, decision: "approved" });

    expect(model.inputs.map((i) => i.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(model.inputs[1]!.system).toBe(model.inputs[0]!.system);
    expect(model.inputs[1]!.tools).toEqual(model.inputs[0]!.tools);
  });
});

describe("budgets and limits", () => {
  it("refuses new work once the monthly budget is spent", async () => {
    const { db, data } = await freshDb();
    await db.insert(s.tasks).values({
      agentId: data.agents.sourcer.id,
      source: "api",
      input: "earlier work",
      status: "completed",
      costUsd: "300.00",
    });
    const model = new ScriptedModel([]);
    const { deps: d, notify } = deps(db, model);

    const r = await handleInbound(d, slack(data.orgId, "U_RECRUITER", "Find candidates"));

    expect(model.inputs).toHaveLength(0);
    expect((await taskOf(db, (r as { taskId: string }).taskId)).error).toBe("budget_exceeded");
    expect(notify.sent.at(-1)!.text).toContain("monthly budget");
  });

  it("stops after the step limit", async () => {
    const { db, data } = await freshDb();
    const loop = () => ({ toolCalls: [{ id: crypto.randomUUID(), name: "web.search", args: {} }] });
    const model = new ScriptedModel([loop, loop, loop]);
    const { deps: d } = deps(db, model);

    const r = await handleInbound({ ...d, maxSteps: 3 }, slack(data.orgId, "U_RECRUITER", "Keep searching"));

    expect((await taskOf(db, (r as { taskId: string }).taskId)).error).toBe("max_steps");
  });

  it("does nothing when re-run after completion", async () => {
    const { db, data } = await freshDb();
    const model = new ScriptedModel([{ text: "done" }]);
    const { deps: d } = deps(db, model);
    const r = await handleInbound(d, slack(data.orgId, "U_RECRUITER", "hi"));

    const again = await runTask(d, (r as { taskId: string }).taskId);
    expect(again.status).toBe("completed");
    expect(model.inputs).toHaveLength(1);
  });
});
