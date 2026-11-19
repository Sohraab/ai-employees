/**
 * Runs a task: build the prompt, step the model, gate every tool call,
 * pause for approvals, resume after decisions, reply, and record cost.
 *
 * The transcript is saved on the task after every step, so a task can wait
 * hours for an approval and pick up exactly where it left off.
 */
import { asc, eq } from "drizzle-orm";
import { authorizeRequest, authorizeToolCall, type Caller } from "../core/access.js";
import { approvals, conversations, messages, people, tasks, type Task } from "../db/schema.js";
import { audit } from "./audit.js";
import { isBuiltin, runBuiltin } from "./builtins.js";
import { contactFor, loadAgent, loadCaller, monthToDateSpend, type LoadedAgent } from "./lookup.js";
import { buildSystemPrompt, memoriesForTask, toolsForCaller } from "./prompt.js";
import type { EngineDeps, Effort, ToolCall, ToolResult, ToolSpec, TranscriptItem } from "./types.js";

const DONE = new Set(["completed", "failed", "denied", "cancelled"]);

export async function runTask(deps: EngineDeps, taskId: string): Promise<Task> {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const maxSteps = deps.maxSteps ?? 20;

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (DONE.has(task.status)) return task;

  const agent = await loadAgent(db, task.agentId);
  const requester = task.requestedById
    ? ((await db.query.people.findFirst({ where: eq(people.id, task.requestedById) })) ?? null)
    : null;
  const caller = task.requestedById ? await loadCaller(db, task.requestedById, task.callerTrust) : null;
  const conversation = task.conversationId
    ? ((await db.query.conversations.findFirst({ where: eq(conversations.id, task.conversationId) })) ?? null)
    : null;

  let transcript = task.transcript as TranscriptItem[];
  const usage = { input: task.inputTokens, output: task.outputTokens, cost: Number(task.costUsd) };

  // --- helpers ---------------------------------------------------------------

  const save = async (patch: Partial<typeof tasks.$inferInsert> = {}) => {
    const [row] = await db
      .update(tasks)
      .set({
        transcript,
        inputTokens: usage.input,
        outputTokens: usage.output,
        costUsd: usage.cost.toFixed(4),
        ...patch,
      })
      .where(eq(tasks.id, taskId))
      .returning();
    return row!;
  };

  const replyToRequester = async (text: string) => {
    if (!task.replyChannel || !task.replyTarget) return;
    await deps.notify.send({
      agentId: agent.id,
      channel: task.replyChannel,
      target: task.replyTarget,
      threadRef: conversation?.threadRef,
      text,
    });
    if (conversation) await db.insert(messages).values({ conversationId: conversation.id, direction: "outbound", body: text });
  };

  const end = async (status: "completed" | "failed" | "denied", text: string, error?: string) => {
    await replyToRequester(text);
    await audit(db, {
      orgId: agent.orgId,
      agentId: agent.id,
      taskId,
      actorType: "agent",
      actorId: agent.id,
      action: `task.${status}`,
      detail: error ? { error } : {},
    });
    return save({ status, output: status === "completed" ? text : null, error: error ?? null, completedAt: now() });
  };

  // --- checks before doing any work --------------------------------------------

  if (!caller) return end("denied", "I can't continue this task because the person who asked no longer has an active account.", "requester_inactive");

  const access = authorizeRequest(agent, agent.grants, caller, now());
  if (access.kind === "reject") return end("failed", `${agent.name} is paused, so this task was stopped.`, "agent_inactive");
  if (access.kind !== "allow") return end("denied", `You no longer have access to ${agent.name}.`, "no_access");

  if (task.status === "queued" && agent.monthlyBudgetUsd != null) {
    const spent = await monthToDateSpend(db, agent.id, now());
    if (spent >= Number(agent.monthlyBudgetUsd)) {
      return end("failed", `${agent.name} has reached its monthly budget. ${agent.manager?.name ?? "An admin"} can raise it.`, "budget_exceeded");
    }
  }

  if (task.status === "queued") {
    transcript = [{ role: "user", text: await initialInput(deps, task) }];
    await save({ status: "running", startedAt: now() });
  }

  // --- resume after approvals ------------------------------------------------

  if (task.status === "awaiting_approval") {
    const waiting = await resolvePendingCalls(deps, agent, caller, task, transcript);
    if (waiting) return save();
    await save({ status: "running" });
  }

  // --- the model loop --------------------------------------------------------

  // Fixed once per task, so a resumed task shows the model exactly what it saw before.
  // The model too: changing an employee's model applies to new tasks, not ones already running.
  let context = task.modelContext as { model: string; effort?: Effort | null; system: string; tools: ToolSpec[] } | null;
  if (!context) {
    const view = await toolsForCaller(deps.tools, agent, caller, now());
    const memories = await memoriesForTask(db, agent.id, caller, task.input);
    const system = buildSystemPrompt({ agent, requester, caller, source: task.source, view, memories, now: now() });
    context = { model: agent.model, effort: agent.effort, system, tools: view.offered };
    await save({ modelContext: context });
  }
  const { model, effort, system, tools: offeredTools } = context;

  for (let step = 0; step < maxSteps; step++) {
    const out = await deps.model.step({ model, effort, system, transcript, tools: offeredTools });
    usage.input += out.usage.inputTokens;
    usage.output += out.usage.outputTokens;
    usage.cost += out.usage.costUsd;
    transcript.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls, raw: out.raw });

    if (out.toolCalls.length === 0) {
      return end("completed", out.text?.trim() || "Done.");
    }

    const pendingApprovals: { approvalId: string; approverId: string; call: ToolCall }[] = [];
    for (const call of out.toolCalls) {
      const r = await gateAndRun(deps, agent, caller, taskId, call);
      if ("approverId" in r) {
        const [approval] = await db
          .insert(approvals)
          .values({ taskId, toolCallId: call.id, tool: call.name, args: call.args, approverId: r.approverId })
          .returning();
        pendingApprovals.push({ approvalId: approval!.id, approverId: r.approverId, call });
      } else {
        transcript.push({ role: "tool_result", callId: call.id, tool: call.name, ok: r.ok, content: r.content });
      }
    }

    if (pendingApprovals.length) {
      await save({ status: "awaiting_approval" });
      for (const p of pendingApprovals) {
        await audit(db, {
          orgId: agent.orgId,
          agentId: agent.id,
          taskId,
          actorType: "agent",
          actorId: agent.id,
          action: "approval.requested",
          detail: { approvalId: p.approvalId, tool: p.call.name, approverId: p.approverId },
        });
        const contact = await contactFor(db, p.approverId);
        if (contact) {
          const summary =
            `${requester?.name ?? "Someone"} asked ${agent.name} to run ${p.call.name}:\n` +
            truncate(JSON.stringify(p.call.args, null, 2), 1500);
          await deps.notify.send({ agentId: agent.id, ...contact, text: summary, approval: { approvalId: p.approvalId, summary } });
        }
      }
      const approverNames = await namesOf(deps, [...new Set(pendingApprovals.map((p) => p.approverId))]);
      if (out.text?.trim()) await replyToRequester(out.text.trim());
      await replyToRequester(`Waiting for approval from ${approverNames} before I continue.`);
      return save();
    }

    await save();
  }

  return end("failed", "I couldn't finish this within my step limit. Could you break it into smaller requests?", "max_steps");
}

// ---------------------------------------------------------------------------

/** First user turn: the request, plus recent messages from the same thread. */
async function initialInput(deps: EngineDeps, task: Task): Promise<string> {
  if (!task.conversationId) return task.input;
  const rows = await deps.db
    .select({ direction: messages.direction, body: messages.body })
    .from(messages)
    .where(eq(messages.conversationId, task.conversationId))
    .orderBy(asc(messages.createdAt));
  const last = rows.at(-1);
  const earlier = (last?.direction === "inbound" && last.body === task.input ? rows.slice(0, -1) : rows).slice(-10);
  if (!earlier.length) return task.input;
  const history = earlier.map((m) => `${m.direction === "inbound" ? "Them" : "You"}: ${m.body}`).join("\n");
  return `Earlier in this conversation:\n${history}\n\nNew message:\n${task.input}`;
}

/** The permission gate. Every tool call goes through here. */
async function gateAndRun(
  deps: EngineDeps,
  agent: LoadedAgent,
  caller: Caller,
  taskId: string,
  call: ToolCall,
): Promise<ToolResult | { approverId: string }> {
  const now = deps.now?.();
  const log = (action: string, detail: Record<string, unknown>) =>
    audit(deps.db, { orgId: agent.orgId, agentId: agent.id, taskId, actorType: "agent", actorId: agent.id, action, detail });

  if (isBuiltin(call.name)) {
    const result = await runBuiltin(deps.db, { agent, caller, taskId, now }, call.name, call.args);
    await log("tool.called", { tool: call.name, builtin: true, ok: result.ok });
    return result;
  }

  const decision = authorizeToolCall({ agent, toolRules: agent.tools, grants: agent.grants, caller, tool: call.name, now });
  if (decision.kind === "deny") {
    await log("tool.denied", { tool: call.name, reason: decision.reason });
    return { ok: false, content: denialMessage(decision.reason) };
  }
  if (decision.kind === "needs_approval") return { approverId: decision.approverId };

  return execute(deps, agent, call, log);
}

async function execute(
  deps: EngineDeps,
  agent: LoadedAgent,
  call: ToolCall,
  log: (action: string, detail: Record<string, unknown>) => Promise<void>,
): Promise<ToolResult> {
  if (!agent.executorWorkspace) return { ok: false, content: "No tool workspace is configured for this agent." };
  try {
    const result = await deps.tools.call(agent.executorWorkspace, call.name, call.args);
    await log("tool.called", { tool: call.name, ok: result.ok });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log("tool.failed", { tool: call.name, error: message });
    return { ok: false, content: `Tool error: ${message}` };
  }
}

/**
 * After approvals are decided, fill in the results of the paused tool calls.
 * Returns true if some approvals are still pending.
 */
async function resolvePendingCalls(
  deps: EngineDeps,
  agent: LoadedAgent,
  caller: Caller,
  task: Task,
  transcript: TranscriptItem[],
): Promise<boolean> {
  const lastAssistant = transcript.findLastIndex((t) => t.role === "assistant");
  const item = transcript[lastAssistant];
  if (!item || item.role !== "assistant") return false;

  const answered = new Set(
    transcript.slice(lastAssistant + 1).flatMap((t) => (t.role === "tool_result" ? [t.callId] : [])),
  );
  const unanswered = item.toolCalls.filter((c) => !answered.has(c.id));

  const rows = await deps.db.select().from(approvals).where(eq(approvals.taskId, task.id));
  const byCall = new Map(rows.map((r) => [r.toolCallId, r]));
  if (unanswered.some((c) => byCall.get(c.id)?.status === "pending")) return true;

  const log = (action: string, detail: Record<string, unknown>) =>
    audit(deps.db, { orgId: agent.orgId, agentId: agent.id, taskId: task.id, actorType: "agent", actorId: agent.id, action, detail });

  for (const call of unanswered) {
    const approval = byCall.get(call.id);
    let result: ToolResult;
    if (approval?.status === "approved") {
      // Re-check: access may have changed while we waited.
      const d = authorizeToolCall({ agent, toolRules: agent.tools, grants: agent.grants, caller, tool: call.name, now: deps.now?.() });
      result = d.kind === "deny" ? { ok: false, content: denialMessage(d.reason) } : await execute(deps, agent, call, log);
    } else {
      const who = approval ? await namesOf(deps, [approval.approverId]) : "the approver";
      const status = approval?.status === "expired" ? "expired before anyone approved it" : `was denied by ${who}`;
      result = { ok: false, content: `This action ${status}.${approval?.reason ? ` Reason: ${approval.reason}` : ""}` };
    }
    transcript.push({ role: "tool_result", callId: call.id, tool: call.name, ok: result.ok, content: result.content });
  }
  return false;
}

function denialMessage(reason: "agent_lacks_tool" | "caller_lacks_access" | "no_approver"): string {
  switch (reason) {
    case "agent_lacks_tool":
      return "You don't have this tool.";
    case "caller_lacks_access":
      return "Not permitted: the person you're working for isn't allowed to have you do this.";
    case "no_approver":
      return "This action needs approval, but you have no manager to approve it.";
  }
}

async function namesOf(deps: EngineDeps, ids: string[]): Promise<string> {
  const names: string[] = [];
  for (const id of ids) {
    const p = await deps.db.query.people.findFirst({ where: eq(people.id, id) });
    names.push(p?.name ?? "an approver");
  }
  return names.join(", ");
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

