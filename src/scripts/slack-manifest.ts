/**
 * Prints the Slack app manifest for one AI employee.
 *   npm run slack:manifest -- <agent-slug> <public-base-url>
 */
import { eq } from "drizzle-orm";
import { slackManifest } from "../channels/slack.js";
import { createDb } from "../db/client.js";
import { agents } from "../db/schema.js";

const [slug, baseUrl] = process.argv.slice(2);
if (!slug || !baseUrl) {
  console.error("Usage: npm run slack:manifest -- <agent-slug> <public-base-url>");
  process.exit(1);
}

const { db, close } = createDb();
const agent = await db.query.agents.findFirst({ where: eq(agents.slug, slug) });
await close();
if (!agent) {
  console.error(`No agent with slug "${slug}"`);
  process.exit(1);
}
console.log(JSON.stringify(slackManifest({ name: agent.name, role: agent.role, slug, baseUrl }), null, 2));
