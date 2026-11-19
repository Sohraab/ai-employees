import { createDb } from "./client.js";
import { seed } from "./seed-data.js";

const { db, close } = createDb();
const result = await seed(db);
await close();
console.log(`Seeded org ${result.orgId} with agents: Nova (sourcer), Atlas (ops-reporter).`);
