/**
 * Automatic Slack setup: one Slack app per AI employee, without anyone
 * creating apps or copying tokens by hand.
 *
 *  1. Once: a Slack admin creates an app configuration token at
 *     api.slack.com/apps ("Your App Configuration Tokens") and gives it to
 *     `connectWorkspace`. Slack expires it every 12 hours; we renew it with the
 *     refresh token automatically.
 *  2. Per employee: `hireInSlack` creates the employee's app from a manifest
 *     and returns an "Add to Slack" link.
 *  3. A workspace admin opens the link and clicks Allow. Slack redirects to
 *     /slack/oauth/callback and `completeInstall` stores the bot token and
 *     registers the bot's Slack user id as the employee's Slack address.
 */
import { randomBytes } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { and, eq, gt } from "drizzle-orm";
import type { SecretBox } from "../core/secrets.js";
import type { Db } from "../db/client.js";
import { agentChannels, agentSlackApps, agents, slackWorkspaces } from "../db/schema.js";
import { audit } from "../engine/audit.js";
import { BOT_SCOPES, slackManifest, type SlackSecretsLookup } from "./slack.js";

/** The Slack Web API calls provisioning needs. Swappable in tests. */
export interface SlackAdminApi {
  rotateConfigToken(refreshToken: string): Promise<{ token: string; refreshToken: string; expiresAt: Date; teamId?: string }>;
  createApp(configToken: string, manifest: object): Promise<{ appId: string; clientId: string; clientSecret: string; signingSecret: string }>;
  exchangeCode(args: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{
    botToken: string;
    botUserId: string;
    teamId?: string;
  }>;
}

export function slackAdminApi(web = new WebClient()): SlackAdminApi {
  return {
    async rotateConfigToken(refreshToken) {
      const r = await web.tooling.tokens.rotate({ refresh_token: refreshToken });
      if (!r.token || !r.refresh_token || !r.exp) throw new Error("Slack did not return a new configuration token");
      return { token: r.token, refreshToken: r.refresh_token, expiresAt: new Date(r.exp * 1000), teamId: r.team_id };
    },
    async createApp(configToken, manifest) {
      const r = await web.apps.manifest.create({ token: configToken, manifest: manifest as never });
      const c = r.credentials;
      if (!r.app_id || !c?.client_id || !c.client_secret || !c.signing_secret) {
        throw new Error(`Slack did not create the app: ${JSON.stringify(r.errors ?? r.error)}`);
      }
      return { appId: r.app_id, clientId: c.client_id, clientSecret: c.client_secret, signingSecret: c.signing_secret };
    },
    async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
      const r = await web.oauth.v2.access({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
      if (!r.access_token || !r.bot_user_id) throw new Error("Slack did not return a bot token");
      return { botToken: r.access_token, botUserId: r.bot_user_id, teamId: r.team?.id };
    },
  };
}

export interface ProvisioningContext {
  db: Db;
  api: SlackAdminApi;
  box: SecretBox;
  /** Public base URL of this server, e.g. https://ai.example.com */
  baseUrl: string;
  now?: () => Date;
}

const INSTALL_LINK_TTL_MS = 7 * 24 * 60 * 60_000;
const RENEW_BEFORE_MS = 10 * 60_000;

export const redirectUri = (baseUrl: string) => `${baseUrl.replace(/\/$/, "")}/slack/oauth/callback`;

/** Step 1: store the admin's configuration token (renewed immediately, which also checks it works). */
export async function connectWorkspace(ctx: ProvisioningContext, orgId: string, refreshToken: string): Promise<{ teamId?: string }> {
  const fresh = await ctx.api.rotateConfigToken(refreshToken);
  const values = {
    configTokenEnc: ctx.box.encrypt(fresh.token),
    refreshTokenEnc: ctx.box.encrypt(fresh.refreshToken),
    configTokenExpiresAt: fresh.expiresAt,
    teamId: fresh.teamId ?? null,
  };
  await ctx.db.insert(slackWorkspaces).values({ orgId, ...values }).onConflictDoUpdate({ target: slackWorkspaces.orgId, set: values });
  return { teamId: fresh.teamId };
}

/** A valid configuration token, renewed if it is about to expire. */
export async function configToken(ctx: ProvisioningContext, orgId: string): Promise<string> {
  const ws = await ctx.db.query.slackWorkspaces.findFirst({ where: eq(slackWorkspaces.orgId, orgId) });
  if (!ws) throw new Error("Slack isn't connected yet. Run `npm run slack:connect` with an app configuration refresh token.");

  const now = ctx.now?.() ?? new Date();
  if (ws.configTokenExpiresAt.getTime() - now.getTime() > RENEW_BEFORE_MS) return ctx.box.decrypt(ws.configTokenEnc);

  const fresh = await ctx.api.rotateConfigToken(ctx.box.decrypt(ws.refreshTokenEnc));
  await ctx.db
    .update(slackWorkspaces)
    .set({
      configTokenEnc: ctx.box.encrypt(fresh.token),
      refreshTokenEnc: ctx.box.encrypt(fresh.refreshToken),
      configTokenExpiresAt: fresh.expiresAt,
    })
    .where(eq(slackWorkspaces.orgId, orgId));
  return fresh.token;
}

export interface HireResult {
  appId: string;
  installUrl: string;
  created: boolean;
  installed: boolean;
}

/** Step 2: create the employee's Slack app (once) and return an "Add to Slack" link. */
export async function hireInSlack(ctx: ProvisioningContext, agentId: string): Promise<HireResult> {
  const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.id, agentId), with: { slackApp: true } });
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  let created = false;
  if (!agent.slackApp) {
    const token = await configToken(ctx, agent.orgId);
    const manifest = slackManifest({ name: agent.name, role: agent.role, slug: agent.slug, baseUrl: ctx.baseUrl });
    const app = await ctx.api.createApp(token, manifest);
    await ctx.db.insert(agentSlackApps).values({
      agentId: agent.id,
      appId: app.appId,
      clientId: app.clientId,
      clientSecretEnc: ctx.box.encrypt(app.clientSecret),
      signingSecretEnc: ctx.box.encrypt(app.signingSecret),
    });
    await audit(ctx.db, {
      orgId: agent.orgId,
      agentId: agent.id,
      actorType: "system",
      action: "slack.app_created",
      detail: { appId: app.appId },
    });
    created = true;
  }

  const row = (await ctx.db.query.agentSlackApps.findFirst({ where: eq(agentSlackApps.agentId, agent.id) }))!;
  return { appId: row.appId, installUrl: await newInstallUrl(ctx, agent.id), created, installed: row.installedAt != null };
}

/** A fresh, single-use "Add to Slack" link for an employee whose app exists. */
export async function newInstallUrl(ctx: ProvisioningContext, agentId: string): Promise<string> {
  const state = randomBytes(24).toString("hex");
  const now = ctx.now?.() ?? new Date();
  const [row] = await ctx.db
    .update(agentSlackApps)
    .set({ installState: state, installStateExpiresAt: new Date(now.getTime() + INSTALL_LINK_TTL_MS) })
    .where(eq(agentSlackApps.agentId, agentId))
    .returning();
  if (!row) throw new Error("This employee has no Slack app yet");

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", row.clientId);
  url.searchParams.set("scope", BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri(ctx.baseUrl));
  url.searchParams.set("state", state);
  return url.toString();
}

export type InstallResult = { ok: true; agentName: string } | { ok: false; reason: "invalid_or_expired_link" };

/** Step 3: Slack redirected back after "Allow". Store the bot token and route the bot's messages to this employee. */
export async function completeInstall(ctx: ProvisioningContext, params: { code: string; state: string }): Promise<InstallResult> {
  const now = ctx.now?.() ?? new Date();
  const row = await ctx.db.query.agentSlackApps.findFirst({
    where: and(eq(agentSlackApps.installState, params.state), gt(agentSlackApps.installStateExpiresAt, now)),
    with: { agent: true },
  });
  if (!row) return { ok: false, reason: "invalid_or_expired_link" };

  const result = await ctx.api.exchangeCode({
    clientId: row.clientId,
    clientSecret: ctx.box.decrypt(row.clientSecretEnc),
    code: params.code,
    redirectUri: redirectUri(ctx.baseUrl),
  });

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(agentSlackApps)
      .set({
        botTokenEnc: ctx.box.encrypt(result.botToken),
        botUserId: result.botUserId,
        teamId: result.teamId ?? null,
        installedAt: now,
        installState: null,
        installStateExpiresAt: null,
      })
      .where(eq(agentSlackApps.agentId, row.agentId));
    // The bot's Slack user id is how incoming messages find this employee.
    await tx.delete(agentChannels).where(and(eq(agentChannels.agentId, row.agentId), eq(agentChannels.channel, "slack")));
    await tx.insert(agentChannels).values({ agentId: row.agentId, channel: "slack", address: result.botUserId, config: { appId: row.appId } });
  });

  await audit(ctx.db, {
    orgId: row.agent.orgId,
    agentId: row.agentId,
    actorType: "system",
    action: "slack.installed",
    detail: { appId: row.appId, botUserId: result.botUserId, teamId: result.teamId ?? null },
  });
  return { ok: true, agentName: row.agent.name };
}

/** Looks up an employee's Slack secrets from the database (apps created by provisioning). */
export function slackSecretsFromDb(db: Db, box: SecretBox): SlackSecretsLookup {
  return async (slug) => {
    const [row] = await db
      .select({ signing: agentSlackApps.signingSecretEnc, bot: agentSlackApps.botTokenEnc })
      .from(agentSlackApps)
      .innerJoin(agents, eq(agents.id, agentSlackApps.agentId))
      .where(eq(agents.slug, slug))
      .limit(1);
    if (!row) return undefined;
    return { signingSecret: box.decrypt(row.signing), botToken: row.bot ? box.decrypt(row.bot) : undefined };
  };
}

/** Tries each lookup in order: database first, then hand-configured environment variables. */
export function firstOf(...lookups: SlackSecretsLookup[]): SlackSecretsLookup {
  return async (slug) => {
    for (const lookup of lookups) {
      const hit = await lookup(slug);
      if (hit) return hit;
    }
    return undefined;
  };
}
