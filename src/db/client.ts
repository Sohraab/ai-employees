import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema> | import("drizzle-orm/pglite").PgliteDatabase<typeof schema>;

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url);
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
