/**
 * HTTP endpoints. Slack wants an answer within 3 seconds, so every handler
 * verifies the request, answers right away and does the work in `background`.
 */
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { completeInstall, connectWorkspace, hireInSlack, type ProvisioningContext } from "../channels/slack-provisioning.js";
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
  /** Automatic Slack setup. Without it, only hand-configured Slack apps work. */
  provisioning?: ProvisioningContext;
  /** Bearer token for /admin endpoints (until the admin console has real sign-in). */
  adminToken?: string;
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
    const secrets = await slackSecrets(slug);
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
    let payload: { type?: string; challenge?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      return c.text("bad request", 400);
    }

    // Slack checks the events URL while it creates the app, before we have the
    // app's signing secret. Echoing the challenge reveals nothing and does nothing.
    if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });
    if (!(await verified(slug, c.req.raw, body))) return c.text("invalid signature", 401);

    // Slack retries when we're slow; the first delivery is already being handled.
    if (c.req.header("x-slack-retry-num")) return c.body(null, 200);

    background(
      (async () => {
        const agent = await slackAgent(slug);
        if (!agent) return;
        const env = slackEventToEnvelope(payload as Parameters<typeof slackEventToEnvelope>[0], {
          orgId: agent.orgId,
          botUserId: agent.botUserId,
        });
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

  // ---------------------------------------------------------------------------
  // Automatic Slack setup
  // ---------------------------------------------------------------------------

  /** Slack sends the admin here after they click "Allow" on an employee's install page. */
  app.get("/slack/oauth/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (error) return page(c, "Not added", "The app wasn't added to Slack. You can use the same link to try again.", 400);
    if (!opts.provisioning || !code || !state) return page(c, "Link not valid", "This install link isn't valid.", 400);

    const result = await completeInstall(opts.provisioning, { code, state });
    if (!result.ok) {
      return page(c, "Link expired", "This install link has expired or was already used. Ask for a new one.", 400);
    }
    return page(
      c,
      `${result.agentName} has joined your Slack`,
      `Say hi: DM ${result.agentName}, or invite them to a channel and @mention them.`,
    );
  });

  const admin = new Hono();
  admin.use("*", async (c, next) => {
    if (!opts.adminToken || !opts.provisioning) return c.json({ error: "admin API not configured" }, 503);
    const given = Buffer.from(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(opts.adminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  /** One-time: store the Slack app configuration (refresh) token for an org. */
  admin.post("/slack/connect", async (c) => {
    const { orgId, refreshToken } = await c.req.json<{ orgId: string; refreshToken: string }>();
    if (!orgId || !refreshToken) return c.json({ error: "orgId and refreshToken are required" }, 400);
    return c.json(await connectWorkspace(opts.provisioning!, orgId, refreshToken));
  });

  /** Create this employee's Slack app (if needed) and get an "Add to Slack" link. */
  admin.post("/agents/:slug/slack", async (c) => {
    const agent = await db.query.agents.findFirst({ where: eq(agents.slug, c.req.param("slug")) });
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json(await hireInSlack(opts.provisioning!, agent.id));
  });

  app.route("/admin", admin);

  return app;
}

function page(c: Context, title: string, message: string, status: 200 | 400 = 200) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d1c1d}` +
      `h1{font-size:1.5rem}</style></head><body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`,
    status,
  );
}
