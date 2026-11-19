/**
 * Give an AI employee its own Slack app and print its "Add to Slack" link.
 *   npm run slack:hire -- <agent-slug>
 * Running it again prints a fresh link (e.g. if the old one expired).
 */
import { eq } from "drizzle-orm";
import { hireInSlack } from "../channels/slack-provisioning.js";
import { agents } from "../db/schema.js";
import { scriptProvisioning } from "./provisioning-context.js";

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: npm run slack:hire -- <agent-slug>");
  process.exit(1);
}

const ctx = scriptProvisioning();
const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.slug, slug) });
if (!agent) throw new Error(`No agent with slug "${slug}"`);

const result = await hireInSlack(ctx, agent.id);
await ctx.close();
console.log(result.created ? `Created ${agent.name}'s Slack app (${result.appId}).` : `${agent.name} already has a Slack app (${result.appId}).`);
if (result.installed) console.log(`${agent.name} is already installed. The link below reinstalls it.`);
console.log(`\nA Slack workspace admin opens this link and clicks Allow:\n${result.installUrl}\n`);
console.log("Optional: upload a profile picture under the app's Basic Information page on api.slack.com/apps.");
