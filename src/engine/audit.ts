import type { Db } from "../db/client.js";
import { auditLog } from "../db/schema.js";

export async function audit(
  db: Db,
  entry: {
    orgId: string;
    agentId?: string | null;
    taskId?: string | null;
    actorType: "person" | "agent" | "system";
    actorId?: string | null;
    action: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    orgId: entry.orgId,
    agentId: entry.agentId ?? null,
    taskId: entry.taskId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    detail: entry.detail ?? {},
  });
}
