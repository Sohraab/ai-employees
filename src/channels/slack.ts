/**
 * Slack: one Slack app per AI employee, so each one shows up in Slack as its
 * own colleague with its own name, avatar and DMs.
 *
 * Per employee (by agent slug) we need two secrets, from the environment:
 *   SLACK_BOT_TOKEN__<SLUG>       xoxb-… bot token
 *   SLACK_SIGNING_SECRET__<SLUG>  to verify that requests really come from Slack
 * Events go to  POST /slack/<slug>/events
 * Buttons go to POST /slack/<slug>/interactions
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { envKey } from "../adapters/executor.js";
import type { InboundEnvelope, OutboundMessage } from "./types.js";

export interface SlackAppSecrets {
  botToken: string;
  signingSecret: string;
}

export type SlackSecretsLookup = (agentSlug: string) => SlackAppSecrets | undefined;

export function slackSecretsFromEnv(env = process.env): SlackSecretsLookup {
  return (slug) => {
    const key = envKey(slug);
    const botToken = env[`SLACK_BOT_TOKEN__${key}`];
    const signingSecret = env[`SLACK_SIGNING_SECRET__${key}`];
    return botToken && signingSecret ? { botToken, signingSecret } : undefined;
  };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/** Slack request signing (v0). Rejects requests older than 5 minutes (replay protection). */
export function verifySlackSignature(
  signingSecret: string,
  headers: { timestamp?: string | null; signature?: string | null },
  rawBody: string,
  now = Date.now(),
): boolean {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  files?: { name: string; url_private: string; mimetype?: string }[];
}

/**
 * Turns a Slack Events API callback into an envelope, or null for events the
 * agent should ignore (its own messages, edits, joins, other bots).
 */
export function slackEventToEnvelope(
  payload: { type: string; event?: SlackMessageEvent },
  ctx: { orgId: string; botUserId: string; receivedAt?: Date },
): InboundEnvelope | null {
  const event = payload.event;
  if (payload.type !== "event_callback" || !event) return null;
  if (event.bot_id || event.subtype || !event.user || event.user === ctx.botUserId) return null;

  const isMention = event.type === "app_mention";
  const isDm = event.type === "message" && event.channel_type === "im";
  if (!isMention && !isDm) return null;

  const text = (event.text ?? "").replaceAll(`<@${ctx.botUserId}>`, "").trim();
  if (!text && !event.files?.length) return null;

  return {
    orgId: ctx.orgId,
    channel: "slack",
    agentAddress: ctx.botUserId,
    senderHandle: event.user,
    text,
    // Channel mentions: one conversation per thread. DMs: one running conversation,
    // unless the person replies inside a thread.
    threadRef: event.thread_ts ?? (isDm ? dmThreadRef(event.channel) : event.ts),
    replyTarget: event.channel,
    attachments: (event.files ?? []).map((f) => ({ name: f.name, url: f.url_private, mimeType: f.mimetype })),
    proof: { signatureValid: true },
    receivedAt: ctx.receivedAt ?? new Date(),
    raw: payload,
  };
}

const DM_PREFIX = "dm:";
const dmThreadRef = (channel: string) => `${DM_PREFIX}${channel}`;

export interface SlackApprovalClick {
  approvalId: string;
  decision: "approved" | "denied";
  slackUserId: string;
  responseUrl?: string;
}

/** Parses an Approve/Deny button click from the interactions endpoint. */
export function parseApprovalClick(formBody: string): SlackApprovalClick | null {
  const raw = new URLSearchParams(formBody).get("payload");
  if (!raw) return null;
  const payload = JSON.parse(raw) as {
    type: string;
    user?: { id: string };
    response_url?: string;
    actions?: { action_id: string; value?: string }[];
  };
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || !action?.value || !payload.user) return null;
  if (action.action_id !== APPROVE && action.action_id !== DENY) return null;
  return {
    approvalId: action.value,
    decision: action.action_id === APPROVE ? "approved" : "denied",
    slackUserId: payload.user.id,
    responseUrl: payload.response_url,
  };
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

const APPROVE = "approval_approve";
const DENY = "approval_deny";

/** Minimal surface of Slack's WebClient that we use (swappable in tests). */
export interface SlackPoster {
  postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }): Promise<unknown>;
}

export class SlackSender {
  private clients = new Map<string, SlackPoster>();

  constructor(
    private secrets: SlackSecretsLookup,
    /** Maps an agent id to its slug (which selects the Slack app). */
    private slugOf: (agentId: string) => Promise<string | undefined>,
    private makeClient: (token: string) => SlackPoster = (token) => {
      const web = new WebClient(token);
      return { postMessage: (args) => web.chat.postMessage(args as Parameters<typeof web.chat.postMessage>[0]) };
    },
  ) {}

  async send(msg: OutboundMessage): Promise<void> {
    const slug = await this.slugOf(msg.agentId);
    const app = slug ? this.secrets(slug) : undefined;
    if (!slug || !app) throw new Error(`No Slack app configured for agent ${msg.agentId}`);

    let client = this.clients.get(slug);
    if (!client) {
      client = this.makeClient(app.botToken);
      this.clients.set(slug, client);
    }

    // Posting to a user id (U…) opens a DM from this employee's app.
    await client.postMessage({
      channel: msg.target,
      text: msg.text,
      thread_ts: msg.threadRef && !msg.threadRef.startsWith(DM_PREFIX) ? msg.threadRef : undefined,
      blocks: msg.approval ? approvalBlocks(msg.text, msg.approval.approvalId) : undefined,
    });
  }
}

export function approvalBlocks(text: string, approvalId: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(text).slice(0, 2900) } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: APPROVE, value: approvalId },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: DENY, value: approvalId },
      ],
    },
  ];
}

/** Replaces the approval message (buttons) with the outcome. */
export async function answerApprovalClick(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
  });
}

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Slack app manifest for one AI employee. Paste it at api.slack.com/apps →
 * Create New App → From a manifest.
 */
export function slackManifest(params: { name: string; role: string; slug: string; baseUrl: string }) {
  const base = params.baseUrl.replace(/\/$/, "");
  return {
    display_information: { name: params.name, description: params.role },
    features: {
      bot_user: { display_name: params.name, always_online: true },
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: {
      scopes: { bot: ["app_mentions:read", "chat:write", "im:history", "im:read", "im:write", "users:read", "files:read"] },
    },
    settings: {
      event_subscriptions: {
        request_url: `${base}/slack/${params.slug}/events`,
        bot_events: ["app_mention", "message.im"],
      },
      interactivity: { is_enabled: true, request_url: `${base}/slack/${params.slug}/interactions` },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  };
}
