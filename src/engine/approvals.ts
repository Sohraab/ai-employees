/**
 * A human approves or denies a paused tool call. When the last pending
 * approval on a task is decided, the task resumes.
 */
import { and, eq } from "drizzle-orm";
import { hasAccess } from "../core/access.js";
import { approvals, tasks } from "../db/schema.js";
import { audit } from "./audit.js";
import { loadAgent, loadCaller } from "./lookup.js";
import { runTask } from "./runner.js";
import type { EngineDeps } from "./types.js";

export type DecideResult =
  | { kind: "decided"; resumed: boolean }
  | { kind: "not_found" }
  | { kind: "already_decided" }
  | { kind: "not_allowed" };

export async function decideApproval(
  deps: EngineDeps,
  params: { approvalId: string; deciderId: string; decision: "approved" | "denied"; reason?: string },
): Promise<DecideResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();

  const approval = await db.query.approvals.findFirst({ where: eq(approvals.id, params.approvalId) });
  if (!approval) return { kind: "not_found" };
  if (approval.status !== "pending") return { kind: "already_decided" };

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, approval.taskId) });
  if (!task) return { kind: "not_found" };
  const agent = await loadAgent(db, task.agentId);

  // The named approver, or anyone else who manages this agent, may decide.
  // Approvals are decided from verified channels only (Slack buttons, admin console).
  const decider = await loadCaller(db, params.deciderId, "verified");
  const allowed =
    decider != null &&
    (approval.approverId === decider.id || hasAccess(agent, agent.grants, decider, { level: "manage" }, now));
  if (!allowed) return { kind: "not_allowed" };

  // Guard against two people clicking at once: only a still-pending row is updated.
  const updated = await db
    .update(approvals)
    .set({ status: params.decision, reason: params.reason ?? null, decidedAt: now })
    .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
    .returning();
  if (!updated.length) return { kind: "already_decided" };

  await audit(db, {
    orgId: agent.orgId,
    agentId: agent.id,
    taskId: task.id,
    actorType: "person",
    actorId: params.deciderId,
    action: "approval.decided",
    detail: { approvalId: approval.id, tool: approval.tool, decision: params.decision, reason: params.reason ?? null },
  });

  const stillPending = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "pending")))
    .limit(1);
  if (stillPending.length) return { kind: "decided", resumed: false };

  const enqueue = deps.enqueue ?? ((id: string) => runTask(deps, id).then(() => undefined));
  await enqueue(task.id);
  return { kind: "decided", resumed: true };
}
