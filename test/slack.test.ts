import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ChannelNotifier } from "../src/channels/notifier.js";
import {
  parseApprovalClick,
  SlackSender,
  slackEventToEnvelope,
  slackManifest,
  verifySlackSignature,
  type SlackPoster,
} from "../src/channels/slack.js";
import * as s from "../src/db/schema.js";
import type { EngineDeps } from "../src/engine/types.js";
import { createApp } from "../src/server/app.js";
import { FakeTools, freshDb, ScriptedModel } from "./helpers.js";

const SECRET = "test-signing-secret";
const NOW = 1_800_000_000_000;

function sign(body: string, ts = Math.floor(NOW / 1000)) {
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return { "x-slack-request-timestamp": String(ts), "x-slack-signature": sig };
}

describe("Slack request signing", () => {
  it("accepts genuine requests and rejects tampered or old ones", () => {
    const body = '{"a":1}';
    const h = sign(body);
    const headers = { timestamp: h["x-slack-request-timestamp"], signature: h["x-slack-signature"] };
    expect(verifySlackSignature(SECRET, headers, body, NOW)).toBe(true);
    expect(verifySlackSignature(SECRET, headers, '{"a":2}', NOW)).toBe(false);
    expect(verifySlackSignature("other-secret", headers, body, NOW)).toBe(false);
    expect(verifySlackSignature(SECRET, headers, body, NOW + 10 * 60_000)).toBe(false);
  });
});

describe("Slack events → envelopes", () => {
  const ctx = { orgId: "org", botUserId: "B_NOVA" };
  const event = (e: Record<string, unknown>) =>
    ({ type: "event_callback", event: { type: "message", channel: "C1", ts: "1.0", ...e } }) as Parameters<typeof slackEventToEnvelope>[0];

  it("turns a channel mention into a threaded request without the mention", () => {
    const env = slackEventToEnvelope(event({ type: "app_mention", user: "U1", text: "<@B_NOVA> find designers" }), ctx);
    expect(env).toMatchObject({ text: "find designers", senderHandle: "U1", threadRef: "1.0", replyTarget: "C1" });
  });

  it("keeps a DM as one running conversation", () => {
    const env = slackEventToEnvelope(event({ type: "message", channel_type: "im", user: "U1", text: "hi", channel: "D9" }), ctx);
    expect(env?.threadRef).toBe("dm:D9");
  });

  it("ignores bots, its own messages, edits and plain channel chatter", () => {
    expect(slackEventToEnvelope(event({ type: "message", channel_type: "im", bot_id: "B1", text: "x" }), ctx)).toBeNull();
    expect(slackEventToEnvelope(event({ type: "app_mention", user: "B_NOVA", text: "x" }), ctx)).toBeNull();
    expect(slackEventToEnvelope(event({ type: "message", channel_type: "im", user: "U1", subtype: "message_changed" }), ctx)).toBeNull();
    expect(slackEventToEnvelope(event({ type: "message", channel_type: "channel", user: "U1", text: "x" }), ctx)).toBeNull();
  });
});

describe("Slack sender", () => {
  it("sends from the right employee's app, in thread, with approval buttons", async () => {
    const posted: { token: string; args: Record<string, unknown> }[] = [];
    const sender = new SlackSender(
      (slug) => ({ botToken: `xoxb-${slug}`, signingSecret: "x" }),
      async (id) => (id === "agent-nova" ? "sourcer" : undefined),
      (token): SlackPoster => ({ postMessage: async (args) => void posted.push({ token, args }) }),
    );

    await sender.send({ agentId: "agent-nova", channel: "slack", target: "C1", threadRef: "1.0", text: "Hello" });
    await sender.send({ agentId: "agent-nova", channel: "slack", target: "D9", threadRef: "dm:D9", text: "In DM" });
    await sender.send({
      agentId: "agent-nova",
      channel: "slack",
      target: "U_HEAD",
      text: "Approve <this>?",
      approval: { approvalId: "ap_1", summary: "s" },
    });

    expect(posted[0]).toMatchObject({ token: "xoxb-sourcer", args: { channel: "C1", thread_ts: "1.0" } });
    expect(posted[1]!.args.thread_ts).toBeUndefined();
    const blocks = posted[2]!.args.blocks as { type: string; elements?: { value: string }[]; text?: { text: string } }[];
    expect(blocks[0]!.text!.text).toBe("Approve &lt;this&gt;?");
    expect(blocks[1]!.elements!.map((e) => e.value)).toEqual(["ap_1", "ap_1"]);
    await expect(sender.send({ agentId: "unknown", channel: "slack", target: "C1", text: "x" })).rejects.toThrow();
  });

  it("builds a manifest pointing at this employee's endpoints", () => {
    const m = slackManifest({ name: "Nova", role: "Recruiting Sourcer", slug: "sourcer", baseUrl: "https://ai.example.com/" });
    expect(m.settings.event_subscriptions.request_url).toBe("https://ai.example.com/slack/sourcer/events");
    expect(m.settings.interactivity.request_url).toBe("https://ai.example.com/slack/sourcer/interactions");
    expect(m.features.bot_user.display_name).toBe("Nova");
  });
});

describe("Slack end to end over HTTP", () => {
  async function setup(steps: ConstructorParameters<typeof ScriptedModel>[0]) {
    const { db, data } = await freshDb();
    const posted: Record<string, unknown>[] = [];
    const model = new ScriptedModel(steps);
    const deps: EngineDeps = {
      db,
      model,
      tools: new FakeTools(),
      notify: new ChannelNotifier({
        slack: new SlackSender(
          () => ({ botToken: "xoxb", signingSecret: SECRET }),
          async () => "sourcer",
          () => ({ postMessage: async (args) => void posted.push(args) }),
        ),
      }),
    };
    const pending: Promise<unknown>[] = [];
    const app = createApp({
      deps,
      slackSecrets: (slug) => (slug === "sourcer" ? { botToken: "xoxb", signingSecret: SECRET } : undefined),
      background: (w) => void pending.push(w),
      now: () => NOW,
    });
    const settle = async () => {
      while (pending.length) await pending.shift();
    };
    return { db, data, app, posted, model, settle };
  }

  const eventBody = (text: string, user = "U_RECRUITER") =>
    JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", user, text: `<@B_NOVA> ${text}`, channel: "C_TALENT", ts: "100.1" },
    });

  it("answers Slack's URL check and rejects unsigned requests", async () => {
    const { app } = await setup([]);
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const ok = await app.request("/slack/sourcer/events", { method: "POST", body, headers: sign(body) });
    expect(await ok.json()).toEqual({ challenge: "abc" });

    const bad = await app.request("/slack/sourcer/events", { method: "POST", body, headers: { "x-slack-signature": "v0=nope" } });
    expect(bad.status).toBe(401);
    const unknownApp = await app.request("/slack/nobody/events", { method: "POST", body, headers: sign(body) });
    expect(unknownApp.status).toBe(401);
  });

  it("replies in the thread, and an Approve click resumes the task", async () => {
    const { db, app, posted, settle } = await setup([
      { toolCalls: [{ id: "c1", name: "gmail.send_message", args: { to: "cand@example.org" } }] },
      { text: "Sent the outreach." },
    ]);

    const body = eventBody("email this candidate");
    const res = await app.request("/slack/sourcer/events", { method: "POST", body, headers: sign(body) });
    expect(res.status).toBe(200);
    await settle();

    const approvalMsg = posted.find((p) => p.channel === "U_HEAD_TALENT")!;
    expect(approvalMsg.blocks).toBeDefined();
    expect(posted.find((p) => p.channel === "C_TALENT")).toMatchObject({ thread_ts: "100.1" });

    const approvalId = (approvalMsg.blocks as { elements?: { value: string }[] }[])[1]!.elements![0]!.value;
    const click = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U_HEAD_TALENT" },
        actions: [{ action_id: "approval_approve", value: approvalId }],
      }),
    }).toString();
    const clickRes = await app.request("/slack/sourcer/interactions", {
      method: "POST",
      body: click,
      headers: { ...sign(click), "content-type": "application/x-www-form-urlencoded" },
    });
    expect(clickRes.status).toBe(200);
    await settle();

    const [task] = await db.select().from(s.tasks);
    expect(task!.status).toBe("completed");
    expect(posted.at(-1)).toMatchObject({ channel: "C_TALENT", text: "Sent the outreach.", thread_ts: "100.1" });
  });

  it("ignores Slack retries so a message is handled once", async () => {
    const { db, app, settle } = await setup([{ text: "hi" }]);
    const body = eventBody("hello");
    await app.request("/slack/sourcer/events", { method: "POST", body, headers: sign(body) });
    await app.request("/slack/sourcer/events", { method: "POST", body, headers: { ...sign(body), "x-slack-retry-num": "1" } });
    await settle();
    expect(await db.select().from(s.tasks)).toHaveLength(1);
  });

  it("won't let a click from someone who can't approve count", async () => {
    const { db, data, app, posted, settle } = await setup([{ toolCalls: [{ id: "c1", name: "gmail.send_message", args: {} }] }]);
    const body = eventBody("email this candidate");
    await app.request("/slack/sourcer/events", { method: "POST", body, headers: sign(body) });
    await settle();
    const approvalMsg = posted.find((p) => p.channel === "U_HEAD_TALENT")!;
    const approvalId = (approvalMsg.blocks as { elements?: { value: string }[] }[])[1]!.elements![0]!.value;

    const click = new URLSearchParams({
      payload: JSON.stringify({ type: "block_actions", user: { id: "U_RECRUITER" }, actions: [{ action_id: "approval_approve", value: approvalId }] }),
    }).toString();
    await app.request("/slack/sourcer/interactions", { method: "POST", body: click, headers: sign(click) });
    await settle();

    const approval = await db.query.approvals.findFirst({ where: eq(s.approvals.id, approvalId) });
    expect(approval!.status).toBe("pending");
    expect(data.people.recruiter.id).toBeDefined();
  });

  it("parses only approval button clicks", () => {
    const other = new URLSearchParams({ payload: JSON.stringify({ type: "view_submission" }) }).toString();
    expect(parseApprovalClick(other)).toBeNull();
  });
});
