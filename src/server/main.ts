/**
 * Runs the HTTP server and the task worker in one process.
 * Tasks are queued in Postgres (pg-boss), so a restart doesn't lose work.
 */
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { ClaudeModel } from "../adapters/claude.js";
import { ExecutorTools } from "../adapters/executor.js";
import { ChannelNotifier } from "../channels/notifier.js";
import { SlackSender, slackSecretsFromEnv, type SlackSecretsLookup } from "../channels/slack.js";
import { firstOf, slackAdminApi, slackSecretsFromDb, type ProvisioningContext } from "../channels/slack-provisioning.js";
import { secretBox } from "../core/secrets.js";
import { createDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { runTask } from "../engine/runner.js";
import type { EngineDeps } from "../engine/types.js";
import { createApp } from "./app.js";

const RUN_TASK = "run-task";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const { db } = createDb(databaseUrl);
const boss = new PgBoss(databaseUrl);
boss.on("error", (err) => console.error("pg-boss error", err));
await boss.start();
await boss.createQueue(RUN_TASK);

const slugCache = new Map<string, string>();
const slugOf = async (agentId: string) => {
  if (!slugCache.has(agentId)) {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent) slugCache.set(agentId, agent.slug);
  }
  return slugCache.get(agentId);
};

// Slack apps created automatically live (encrypted) in the database; hand-made ones in env vars.
const box = process.env.SECRETS_KEY ? secretBox(process.env.SECRETS_KEY) : undefined;
const slackSecrets: SlackSecretsLookup = box ? firstOf(slackSecretsFromDb(db, box), slackSecretsFromEnv()) : slackSecretsFromEnv();
const provisioning: ProvisioningContext | undefined =
  box && process.env.PUBLIC_URL ? { db, api: slackAdminApi(), box, baseUrl: process.env.PUBLIC_URL } : undefined;
if (!provisioning) console.warn("Automatic Slack setup is off: set SECRETS_KEY and PUBLIC_URL to turn it on.");
const deps: EngineDeps = {
  db,
  model: new ClaudeModel({ effort: (process.env.AGENT_EFFORT as "high" | undefined) ?? "high" }),
  tools: ExecutorTools.fromEnv(),
  notify: new ChannelNotifier({ slack: new SlackSender(slackSecrets, slugOf) }),
  enqueue: async (taskId) => {
    await boss.send(RUN_TASK, { taskId }, { singletonKey: taskId, retryLimit: 0 });
  },
};

// Worker: one job per task run (a task resumed after an approval is a new job).
await boss.work<{ taskId: string }>(RUN_TASK, { localConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) }, async (jobs) => {
  for (const job of jobs) {
    try {
      await runTask(deps, job.data.taskId);
    } catch (err) {
      console.error(`task ${job.data.taskId} crashed`, err);
      throw err;
    }
  }
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp({ deps, slackSecrets, provisioning, adminToken: process.env.ADMIN_TOKEN }).fetch, port });
console.log(`AI employees listening on :${port}`);
