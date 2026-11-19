import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

const { db, close } = createDb();
await migrate(db, { migrationsFolder: "./drizzle" });
await close();
console.log("Migrations applied.");
