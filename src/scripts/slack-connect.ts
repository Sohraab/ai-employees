/**
 * One-time: connect Slack so AI employees can get their own Slack apps automatically.
 *   npm run slack:connect -- <refresh-token> [org-slug]
 *
 * Get the refresh token at https://api.slack.com/apps → "Your App Configuration
 * Tokens" → Generate Token (pick your workspace). Copy the *Refresh Token*.
 */
import { eq } from "drizzle-orm";
import { connectWorkspace } from "../channels/slack-provisioning.js";
import { organizations } from "../db/schema.js";
import { scriptProvisioning } from "./provisioning-context.js";

const [refreshToken, orgSlug] = process.argv.slice(2);
if (!refreshToken) {
  console.error("Usage: npm run slack:connect -- <refresh-token> [org-slug]");
  process.exit(1);
}

const ctx = scriptProvisioning();
const org = orgSlug
  ? await ctx.db.query.organizations.findFirst({ where: eq(organizations.slug, orgSlug) })
  : await ctx.db.query.organizations.findFirst();
if (!org) throw new Error("Organization not found");

const { teamId } = await connectWorkspace(ctx, org.id, refreshToken);
await ctx.close();
console.log(`Slack connected for ${org.name}${teamId ? ` (workspace ${teamId})` : ""}. Tokens are renewed automatically.`);
