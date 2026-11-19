/** Shared database lookups for the engine. */
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, people, personIdentities, tasks, type Channel } from "../db/schema.js";
import type { Caller, IdentityTrust } from "../core/access.js";

export async function loadAgent(db: Db, agentId: string) {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    with: { grants: true, tools: true, skills: true, manager: true },
  });
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  return agent;
}

export type LoadedAgent = Awaited<ReturnType<typeof loadAgent>>;

export async function loadCaller(db: Db, personId: string, trust: IdentityTrust): Promise<Caller | null> {
  const person = await db.query.people.findFirst({ where: eq(people.id, personId) });
  if (!person || !person.active) return null;
  return { id: person.id, teamId: person.teamId, role: person.role, isOrgAdmin: person.isOrgAdmin, trust };
}

const CONTACT_PREFERENCE: Channel[] = ["slack", "email", "whatsapp", "phone"];

/** Best verified channel to reach a person on, e.g. for approval requests. */
export async function contactFor(db: Db, personId: string): Promise<{ channel: Channel; target: string } | null> {
  const ids = await db
    .select()
    .from(personIdentities)
    .where(and(eq(personIdentities.personId, personId), isNotNull(personIdentities.verifiedAt)));
  for (const channel of CONTACT_PREFERENCE) {
    const hit = ids.find((i) => i.channel === channel);
    if (hit) return { channel, target: hit.handle };
  }
  return null;
}

/** Money spent by an agent since the start of the current calendar month (UTC). */
export async function monthToDateSpend(db: Db, agentId: string, now: Date): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${tasks.costUsd}), 0)` })
    .from(tasks)
    .where(and(eq(tasks.agentId, agentId), gte(tasks.createdAt, monthStart)));
  return Number(row?.total ?? 0);
}
