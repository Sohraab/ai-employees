/**
 * Starts one run of a routine. A routine run is an ordinary task that runs
 * as `run_as`, with access re-checked every time. Working out *when* routines
 * are due (cron → next_run_at) is the scheduler's job (phase 5).
 */
import { eq } from "drizzle-orm";
import { authorizeRequest } from "../core/access.js";
import { routines, tasks } from "../db/schema.js";
import { audit } from "./audit.js";
import { contactFor, loadAgent, loadCaller } from "./lookup.js";
import { runTask } from "./runner.js";
import type { EngineDeps } from "./types.js";

export type RoutineRunResult =
  | { kind: "started"; taskId: string }
  | { kind: "skipped"; reason: "disabled" | "agent_inactive" }
  | { kind: "paused"; reason: "run_as_inactive" | "run_as_lost_access" };

export async function startRoutineRun(deps: EngineDeps, routineId: string): Promise<RoutineRunResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();

  const routine = await db.query.routines.findFirst({ where: eq(routines.id, routineId) });
  if (!routine) throw new Error(`Routine ${routineId} not found`);
  if (!routine.enabled) return { kind: "skipped", reason: "disabled" };

  const agent = await loadAgent(db, routine.agentId);
  if (agent.status !== "active") return { kind: "skipped", reason: "agent_inactive" };

  const runAs = await loadCaller(db, routine.runAsId, "verified");
  const decision = runAs ? authorizeRequest(agent, agent.grants, runAs, now) : null;

  // Routines may only take actions, so the owner needs at least `assign`.
  const ok = decision?.kind === "allow" && decision.level !== "talk";
  if (!ok) {
    const reason = runAs ? "run_as_lost_access" : "run_as_inactive";
    await db.update(routines).set({ enabled: false }).where(eq(routines.id, routine.id));
    await audit(db, {
      orgId: agent.orgId,
      agentId: agent.id,
      actorType: "system",
      action: "routine.paused",
      detail: { routineId: routine.id, reason },
    });
    if (agent.managerId) {
      const contact = await contactFor(db, agent.managerId);
      if (contact) {
        await deps.notify.send({
          agentId: agent.id,
          ...contact,
          text: `I paused ${agent.name}'s routine "${routine.name}" because the person it runs as no longer has access.`,
        });
      }
    }
    return { kind: "paused", reason };
  }

  const [task] = await db
    .insert(tasks)
    .values({
      agentId: agent.id,
      requestedById: routine.runAsId,
      source: "routine",
      routineId: routine.id,
      input: routine.prompt,
      replyChannel: routine.deliverChannel,
      replyTarget: routine.deliverTarget,
    })
    .returning();
  await db.update(routines).set({ lastRunAt: now }).where(eq(routines.id, routine.id));
  await audit(db, {
    orgId: agent.orgId,
    agentId: agent.id,
    taskId: task!.id,
    actorType: "system",
    action: "routine.started",
    detail: { routineId: routine.id },
  });

  const enqueue = deps.enqueue ?? ((id: string) => runTask(deps, id).then(() => undefined));
  await enqueue(task!.id);
  return { kind: "started", taskId: task!.id };
}
