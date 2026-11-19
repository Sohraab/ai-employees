/**
 * HTTP endpoints. Slack wants an answer within 3 seconds, so every handler
 * verifies the request, answers right away and does the work in `background`.
 */
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  answerApprovalClick,
  parseApprovalClick,
  slackEventToEnvelope,
  verifySlackSignature,
  type SlackSecretsLookup,
} from "../channels/slack.js";
import { resolveCaller } from "../core/identity.js";
import { agentChannels, agents } from "../db/schema.js";
import { decideApproval } from "../engine/approvals.js";
import { handleInbound } from "../engine/router.js";
import type { EngineDeps } from "../engine/types.js";

export interface AppOptions {
  deps: EngineDeps;
  slackSecrets: SlackSecretsLookup;
  /** Runs work after the HTTP response. Tests pass a collector they can await. */
  background?: (work: Promise<unknown>) => void;
  now?: () => number;
}

export function createApp(opts: AppOptions) {
  const { deps, slackSecrets } = opts;
  const db = deps.db;
  const background =
    opts.background ?? ((work) => void work.catch((err) => console.error("background work failed", err)));
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  /** The agent behind a Slack app, plus its bot user id. Slugs are per org; this MVP serves one org. */
  async function slackAgent(slug: string) {
    const [row] = await db
      .select({ agentId: agents.id, orgId: agents.orgId, botUserId: agentChannels.address })
      .from(agents)
      .innerJoin(agentChannels, and(eq(agentChannels.agentId, agents.id), eq(agentChannels.channel, "slack")))
      .where(eq(agents.slug, slug))
      .limit(1);
    return row;
  }

  async function verified(slug: string, req: Request, body: string) {
    const secrets = slackSecrets(slug);
    if (!secrets) return false;
    return verifySlackSignature(
      secrets.signingSecret,
      { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") },
      body,
      opts.now?.(),
    );
  }

  app.post("/slack/:slug/events", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.text();
    if (!(await verified(slug, c.req.raw, body))) return c.text("invalid signature", 401);

    const payload = JSON.parse(body);
    if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });

    // Slack retries when we're slow; the first delivery is already being handled.
    if (c.req.header("x-slack-retry-num")) return c.body(null, 200);

    background(
      (async () => {
        const agent = await slackAgent(slug);
        if (!agent) return;
        const env = slackEventToEnvelope(payload, { orgId: agent.orgId, botUserId: agent.botUserId });
        if (env) await handleInbound(deps, env);
      })(),
    );
    return c.body(null, 200);
  });

  app.post("/slack/:slug/interactions", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.text();
    if (!(await verified(slug, c.req.raw, body))) return c.text("invalid signature", 401);

    const click = parseApprovalClick(body);
    if (!click) return c.body(null, 200);

    background(
      (async () => {
        const agent = await slackAgent(slug);
        if (!agent) return;
        const decider = await resolveCaller(db, {
          orgId: agent.orgId,
          channel: "slack",
          handle: click.slackUserId,
          proof: { signatureValid: true },
        });
        const result = decider
          ? await decideApproval(deps, { approvalId: click.approvalId, deciderId: decider.id, decision: click.decision })
          : ({ kind: "not_allowed" } as const);

        if (!click.responseUrl) return;
        const who = `<@${click.slackUserId}>`;
        const text =
          result.kind === "decided"
            ? click.decision === "approved"
              ? `✅ Approved by ${who}`
              : `🚫 Denied by ${who}`
            : result.kind === "already_decided"
              ? "This was already decided."
              : result.kind === "not_allowed"
                ? `${who} isn't allowed to decide this. The agent's manager can.`
                : "This approval no longer exists.";
        // Only replace the buttons when a decision was recorded or is final.
        if (result.kind !== "not_allowed") await answerApprovalClick(click.responseUrl, text);
      })(),
    );
    return c.body(null, 200);
  });

  return app;
}
