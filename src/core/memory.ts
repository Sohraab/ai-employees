/**
 * Memory: one store per agent, shared across every channel, filtered by who
 * is asking. What Alice said in a DM is never shown to Bob.
 */
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { memories, type Memory, type MemoryVisibility } from "../db/schema.js";

export interface Requester {
  personId: string | null;
  teamId: string | null;
}

/** Pure version of the visibility rule, shared by the query and the tests. */
export function canSeeMemory(
  m: Pick<Memory, "visibility" | "ownerPersonId" | "teamId" | "archived">,
  r: Requester,
): boolean {
  if (m.archived) return false;
  switch (m.visibility) {
    case "agent_wide":
      return true;
    case "team":
      return r.teamId != null && m.teamId === r.teamId;
    case "private":
      return r.personId != null && m.ownerPersonId === r.personId;
  }
}

function visibilityWhere(r: Requester): SQL {
  const clauses: SQL[] = [eq(memories.visibility, "agent_wide")];
  if (r.teamId) clauses.push(and(eq(memories.visibility, "team"), eq(memories.teamId, r.teamId))!);
  if (r.personId) {
    clauses.push(and(eq(memories.visibility, "private"), eq(memories.ownerPersonId, r.personId))!);
  }
  return or(...clauses)!;
}

/**
 * Memories this requester may see, best matches first. Uses Postgres
 * full-text search; swap in embeddings later without changing callers.
 */
export async function recallMemories(
  db: Db,
  params: { agentId: string; requester: Requester; query?: string; limit?: number },
): Promise<Memory[]> {
  const { agentId, requester, query, limit = 20 } = params;
  const base = and(eq(memories.agentId, agentId), eq(memories.archived, false), visibilityWhere(requester));

  if (!query?.trim()) {
    return db.select().from(memories).where(base).orderBy(desc(memories.createdAt)).limit(limit);
  }

  const tsQuery = sql`websearch_to_tsquery('english', ${query})`;
  const doc = sql`to_tsvector('english', ${memories.content})`;
  return db
    .select()
    .from(memories)
    .where(and(base, sql`${doc} @@ ${tsQuery}`))
    .orderBy(desc(sql`ts_rank(${doc}, ${tsQuery})`), desc(memories.createdAt))
    .limit(limit);
}

export async function remember(
  db: Db,
  params: {
    agentId: string;
    content: string;
    visibility: MemoryVisibility;
    ownerPersonId?: string | null;
    teamId?: string | null;
    sourceTaskId?: string | null;
    tags?: string[];
  },
): Promise<Memory> {
  const [row] = await db
    .insert(memories)
    .values({
      agentId: params.agentId,
      content: params.content,
      visibility: params.visibility,
      ownerPersonId: params.visibility === "private" ? params.ownerPersonId : null,
      teamId: params.visibility === "team" ? params.teamId : null,
      sourceTaskId: params.sourceTaskId ?? null,
      tags: params.tags ?? [],
    })
    .returning();
  return row!;
}
