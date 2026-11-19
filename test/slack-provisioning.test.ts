import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ChannelNotifier } from "../src/channels/notifier.js";
import { SlackSender } from "../src/channels/slack.js";
import {
  completeInstall,
  configToken,
  connectWorkspace,
  hireInSlack,
  slackSecretsFromDb,
  type ProvisioningContext,
  type SlackAdminApi,
} from "../src/channels/slack-provisioning.js";
import { secretBox } from "../src/core/secrets.js";
import * as s from "../src/db/schema.js";
import type { EngineDeps } from "../src/engine/types.js";
import { createApp } from "../src/server/app.js";
import { FakeTools, freshDb, ScriptedModel } from "./helpers.js";

const KEY = randomBytes(32).toString("base64");
const BASE = "https://ai.example.com";

/** Pretends to be Slack's admin APIs and records what was asked. */
class FakeSlackAdmin implements SlackAdminApi {
  rotations = 0;
  manifests: Record<string, unknown>[] = [];
  exchanges: { clientId: string; clientSecret: string; code: string; redirectUri: string }[] = [];
  expiresInMs = 12 * 60 * 60_000;

  async rotateConfigToken(refreshToken: string) {
    this.rotations++;
    return {
      token: `xoxe.xoxp-config-${this.rotations}`,
      refreshToken: `${refreshToken}-r${this.rotations}`,
      expiresAt: new Date(Date.now() + this.expiresInMs),
      teamId: "T_EXAMPLE",
    };
  }
  async createApp(_token: string, manifest: object) {
    this.manifests.push(manifest as Record<string, unknown>);
    const n = this.manifests.length;
    return { appId: `A_${n}`, clientId: `client-${n}`, clientSecret: `client-secret-${n}`, signingSecret: `signing-secret-${n}` };
  }
  async exchangeCode(args: { clientId: string; clientSecret: string; code: string; redirectUri: string }) {
    this.exchanges.push(args);
    return { botToken: `xoxb-real-${args.clientId}`, botUserId: `U_BOT_${args.clientId}`, teamId: "T_EXAMPLE" };
  }
}

async function setup() {
  const { db, data } = await freshDb();
  const api = new FakeSlackAdmin();
  const ctx: ProvisioningContext = { db, api, box: secretBox(KEY), baseUrl: BASE };
  return { db, data, api, ctx };
}

describe("secret storage", () => {
  it("encrypts and decrypts, and detects tampering or the wrong key", () => {
    const box = secretBox(KEY);
    const sealed = box.encrypt("xoxb-secret");
    expect(sealed).not.toContain("xoxb-secret");
    expect(box.decrypt(sealed)).toBe("xoxb-secret");
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));

    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => secretBox(randomBytes(32).toString("base64")).decrypt(sealed)).toThrow();
    expect(() => secretBox("too-short")).toThrow(/32 bytes/);
  });
});

describe("connecting Slack once", () => {
  it("stores the configuration token encrypted and renews it before it expires", async () => {
    const { db, data, api, ctx } = await setup();
    await connectWorkspace(ctx, data.orgId, "xoxe-refresh");

    const [row] = await db.select().from(s.slackWorkspaces);
    expect(row!.teamId).toBe("T_EXAMPLE");
    expect(row!.configTokenEnc).not.toContain("xoxe");
    expect(await configToken(ctx, data.orgId)).toBe("xoxe.xoxp-config-1");
    expect(api.rotations).toBe(1);

    // Five minutes before expiry it renews itself.
    const later = { ...ctx, now: () => new Date(Date.now() + 12 * 60 * 60_000 - 5 * 60_000) };
    expect(await configToken(later, data.orgId)).toBe("xoxe.xoxp-config-2");
    expect(api.rotations).toBe(2);
  });

  it("explains what to do when Slack isn't connected", async () => {
    const { data, ctx } = await setup();
    await expect(hireInSlack(ctx, data.agents.sourcer.id)).rejects.toThrow(/slack:connect/);
  });
});

describe("hiring an employee into Slack", () => {
  it("creates the employee's own app and returns an Add to Slack link", async () => {
    const { db, data, api, ctx } = await setup();
    await connectWorkspace(ctx, data.orgId, "xoxe-refresh");

    const hired = await hireInSlack(ctx, data.agents.sourcer.id);

    expect(hired).toMatchObject({ appId: "A_1", created: true, installed: false });
    const manifest = api.manifests[0] as {
      display_information: { name: string };
      oauth_config: { redirect_urls: string[] };
      settings: { event_subscriptions: { request_url: string } };
    };
    expect(manifest.display_information.name).toBe("Nova");
    expect(manifest.oauth_config.redirect_urls).toEqual([`${BASE}/slack/oauth/callback`]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(`${BASE}/slack/sourcer/events`);

    const url = new URL(hired.installUrl);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("scope")).toContain("chat:write");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{48}$/);

    const [stored] = await db.select().from(s.agentSlackApps);
    expect(stored!.signingSecretEnc).not.toContain("signing-secret");

    // Asking again doesn't create a second app; it just gives a fresh link.
    const again = await hireInSlack(ctx, data.agents.sourcer.id);
    expect(again.created).toBe(false);
    expect(api.manifests).toHaveLength(1);
    expect(new URL(again.installUrl).searchParams.get("state")).not.toBe(url.searchParams.get("state"));
  });

  it("finishes the install: stores the bot token and routes the bot's messages to the employee", async () => {
    const { db, data, ctx } = await setup();
    await connectWorkspace(ctx, data.orgId, "xoxe-refresh");
    const { installUrl } = await hireInSlack(ctx, data.agents.sourcer.id);
    const state = new URL(installUrl).searchParams.get("state")!;

    expect(await completeInstall(ctx, { code: "c", state: "wrong" })).toEqual({ ok: false, reason: "invalid_or_expired_link" });
    expect(await completeInstall(ctx, { code: "c", state })).toEqual({ ok: true, agentName: "Nova" });

    const channels = await db.select().from(s.agentChannels).where(eq(s.agentChannels.agentId, data.agents.sourcer.id));
    expect(channels.filter((c) => c.channel === "slack").map((c) => c.address)).toEqual(["U_BOT_client-1"]);
    expect(await slackSecretsFromDb(db, ctx.box)("sourcer")).toEqual({
      signingSecret: "signing-secret-1",
      botToken: "xoxb-real-client-1",
    });

    // Links are single-use.
    expect((await completeInstall(ctx, { code: "c", state })).ok).toBe(false);
  });

  it("rejects expired install links", async () => {
    const { data, ctx } = await setup();
    await connectWorkspace(ctx, data.orgId, "xoxe-refresh");
    const { installUrl } = await hireInSlack(ctx, data.agents.sourcer.id);
    const state = new URL(installUrl).searchParams.get("state")!;
    const eightDaysLater = { ...ctx, now: () => new Date(Date.now() + 8 * 24 * 60 * 60_000) };
    expect((await completeInstall(eightDaysLater, { code: "c", state })).ok).toBe(false);
  });
});

describe("over HTTP", () => {
  async function server() {
    const env = await setup();
    const pending: Promise<unknown>[] = [];
    const posted: { token: string; args: Record<string, unknown> }[] = [];
    const lookup = slackSecretsFromDb(env.db, env.ctx.box);
    const deps: EngineDeps = {
      db: env.db,
      model: new ScriptedModel([{ text: "Hi! I'm Nova." }]),
      tools: new FakeTools(),
      notify: new ChannelNotifier({
        slack: new SlackSender(lookup, async () => "sourcer", (token) => ({ postMessage: async (args) => void posted.push({ token, args }) })),
      }),
    };
    const app = createApp({
      deps,
      slackSecrets: lookup,
      provisioning: env.ctx,
      adminToken: "admin-secret",
      background: (w) => void pending.push(w),
    });
    const settle = async () => {
      while (pending.length) await pending.shift();
    };
    return { ...env, app, posted, settle };
  }

  const admin = { authorization: "Bearer admin-secret", "content-type": "application/json" };

  it("protects the admin endpoints", async () => {
    const { app } = await server();
    expect((await app.request("/admin/agents/sourcer/slack", { method: "POST" })).status).toBe(401);
    expect((await app.request("/admin/agents/sourcer/slack", { method: "POST", headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("goes from hire to a working Slack employee", async () => {
    const { app, data, posted, settle } = await server();

    // 1. Connect Slack once.
    const connect = await app.request("/admin/slack/connect", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ orgId: data.orgId, refreshToken: "xoxe-refresh" }),
    });
    expect(connect.status).toBe(200);

    // 2. Hire Nova into Slack.
    const hire = await app.request("/admin/agents/sourcer/slack", { method: "POST", headers: admin });
    const { installUrl } = (await hire.json()) as { installUrl: string };

    // 3. The admin clicks Allow; Slack redirects back.
    const state = new URL(installUrl).searchParams.get("state")!;
    const callback = await app.request(`/slack/oauth/callback?code=abc&state=${state}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Nova has joined your Slack");

    // 4. Someone DMs Nova; the request is signed with her app's own secret.
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "message", channel_type: "im", user: "U_RECRUITER", text: "hi", channel: "D1", ts: "1.0" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", "signing-secret-1").update(`v0:${ts}:${body}`).digest("hex")}`;
    const res = await app.request("/slack/sourcer/events", {
      method: "POST",
      body,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    });
    expect(res.status).toBe(200);
    await settle();

    expect(posted).toEqual([{ token: "xoxb-real-client-1", args: { channel: "D1", text: "Hi! I'm Nova.", thread_ts: undefined, blocks: undefined } }]);
  });

  it("shows a clear page for cancelled or bad install links", async () => {
    const { app } = await server();
    expect(await (await app.request("/slack/oauth/callback?error=access_denied")).text()).toContain("wasn't added");
    expect(await (await app.request("/slack/oauth/callback?code=x&state=bogus")).text()).toContain("expired");
  });
});
