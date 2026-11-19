/**
 * Data model for AI employees.
 *
 * Core idea: an AI employee (agent) is ONE entity with its own memory, skills,
 * tools, routines and access rules. Slack, email, WhatsApp and phone are only
 * channels that reach it. Every request is checked twice:
 *   1. may this caller use this agent for this kind of work?  (access_grants)
 *   2. may the agent itself do it?                           (agent_tools)
 * The effective permission is the intersection of the two.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const channelEnum = pgEnum("channel", ["slack", "email", "whatsapp", "phone", "web"]);

/** Ordered from least to most powerful. See ACCESS_LEVEL_RANK in core/access.ts. */
export const accessLevelEnum = pgEnum("access_level", ["talk", "assign", "manage", "admin"]);

export const grantSubjectEnum = pgEnum("grant_subject", ["person", "team", "role", "everyone"]);

export const agentStatusEnum = pgEnum("agent_status", ["active", "paused", "archived"]);

export const taskStatusEnum = pgEnum("task_status", [
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "denied",
  "cancelled",
]);

export const taskSourceEnum = pgEnum("task_source", ["channel", "routine", "agent", "api"]);

export const memoryVisibilityEnum = pgEnum("memory_visibility", ["private", "team", "agent_wide"]);

export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved", "denied", "expired"]);

export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound"]);

export const actorTypeEnum = pgEnum("actor_type", ["person", "agent", "system"]);

// Small helpers
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Organization & humans
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: createdAt(),
});

export const teams = pgTable(
  "teams",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("teams_org_name_uq").on(t.orgId, t.name)],
);

export const people = pgTable(
  "people",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Job role, used by role-based grants, e.g. "recruiter", "head_of_talent". */
    role: text("role"),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    /** Org admins can manage every agent. */
    isOrgAdmin: boolean("is_org_admin").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("people_org_idx").on(t.orgId), index("people_team_idx").on(t.teamId)],
);

/**
 * How a person shows up on each channel: Slack user id, email address,
 * E.164 phone number for WhatsApp/phone. Unverified identities are never
 * trusted for actions (see core/identity.ts).
 */
export const personIdentities = pgTable(
  "person_identities",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    /** Normalized handle: lowercase email, E.164 phone, Slack user id. */
    handle: text("handle").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("person_identities_org_channel_handle_uq").on(t.orgId, t.channel, t.handle),
    index("person_identities_person_idx").on(t.personId),
  ],
);

// ---------------------------------------------------------------------------
// AI employees
// ---------------------------------------------------------------------------

export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Job title, e.g. "Recruiting Sourcer". */
    role: text("role").notNull(),
    /** System prompt: who the agent is, how it works, what it must never do. */
    instructions: text("instructions").notNull(),
    /** Which Claude model this employee runs on, e.g. "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5". */
    model: text("model").notNull(),
    /** How hard it thinks: low | medium | high | xhigh | max. Null = the app default ("high"). */
    effort: text("effort").$type<"low" | "medium" | "high" | "xhigh" | "max">(),
    status: agentStatusEnum("status").notNull().default("active"),
    /** The human responsible for this agent. Default approver for risky actions. */
    managerId: uuid("manager_id").references(() => people.id, { onDelete: "set null" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    /** Executor workspace holding this agent's tool catalog and credentials. */
    executorWorkspace: text("executor_workspace"),
    /** Hard spend cap per calendar month, in USD. Null = no cap. */
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 10, scale: 2 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agents_org_slug_uq").on(t.orgId, t.slug)],
);

/** Skills are markdown instruction files the agent loads when relevant. */
export const agentSkills = pgTable(
  "agent_skills",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agent_skills_agent_name_uq").on(t.agentId, t.name)],
);

/**
 * What the agent itself may do. `toolPattern` matches Executor tool names,
 * e.g. "gmail.send_message" or "greenhouse.*".
 */
export const agentTools = pgTable(
  "agent_tools",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolPattern: text("tool_pattern").notNull(),
    /** A human must approve each call (sent to the agent's manager by default). */
    requiresApproval: boolean("requires_approval").notNull().default(false),
    /** The caller must hold this scope in their grant to trigger the tool. */
    requiredScope: text("required_scope"),
    /** Minimum caller access level needed to trigger this tool. */
    minLevel: accessLevelEnum("min_level").notNull().default("assign"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_tools_agent_pattern_uq").on(t.agentId, t.toolPattern)],
);

/** Where the agent can be reached: its Slack bot, inbox, WhatsApp number. */
export const agentChannels = pgTable(
  "agent_channels",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    /** Slack bot user id, inbox address, E.164 number. */
    address: text("address").notNull(),
    /** Non-secret channel settings. Secrets live in env/secret manager. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_channels_channel_address_uq").on(t.channel, t.address)],
);

/**
 * Who may use an agent and for what.
 *   subjectType = person   -> subjectId is a person id
 *   subjectType = team     -> subjectId is a team id
 *   subjectType = role     -> subjectId is a role string (people.role)
 *   subjectType = everyone -> subjectId is null (everyone in the org)
 */
export const accessGrants = pgTable(
  "access_grants",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    subjectType: grantSubjectEnum("subject_type").notNull(),
    subjectId: text("subject_id"),
    level: accessLevelEnum("level").notNull(),
    /** Narrows what kinds of work this grant covers, e.g. ["candidate_outreach"]. */
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    grantedById: uuid("granted_by_id").references(() => people.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("access_grants_agent_idx").on(t.agentId),
    check(
      "access_grants_subject_id_ck",
      sql`(${t.subjectType} = 'everyone' AND ${t.subjectId} IS NULL) OR (${t.subjectType} <> 'everyone' AND ${t.subjectId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Recurring work. A routine runs with the permissions of `runAsId`, so it is
 * never more powerful than the person it runs for.
 */
export const routines = pgTable(
  "routines",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    prompt: text("prompt").notNull(),
    runAsId: uuid("run_as_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    deliverChannel: channelEnum("deliver_channel").notNull(),
    /** Slack channel id, email address, phone number. */
    deliverTarget: text("deliver_target").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => people.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("routines_due_idx").on(t.enabled, t.nextRunAt)],
);

// ---------------------------------------------------------------------------
// Slack provisioning (one Slack app per AI employee, created automatically)
// ---------------------------------------------------------------------------

/**
 * The Slack admin's app configuration token, used to create one app per
 * employee. Slack expires these tokens every 12 hours; the refresh token
 * renews them. Secrets are stored encrypted (core/secrets.ts).
 */
export const slackWorkspaces = pgTable("slack_workspaces", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  configTokenEnc: text("config_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  configTokenExpiresAt: timestamp("config_token_expires_at", { withTimezone: true }).notNull(),
  teamId: text("team_id"),
  updatedAt: updatedAt(),
});

/** Each AI employee's own Slack app and its credentials. */
export const agentSlackApps = pgTable(
  "agent_slack_apps",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull().unique(),
    clientId: text("client_id").notNull(),
    clientSecretEnc: text("client_secret_enc").notNull(),
    signingSecretEnc: text("signing_secret_enc").notNull(),
    /** Set once a workspace admin clicks "Add to Slack". */
    botTokenEnc: text("bot_token_enc"),
    botUserId: text("bot_user_id"),
    teamId: text("team_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }),
    /** One-time value tying the "Add to Slack" redirect back to this employee. */
    installState: text("install_state").unique(),
    installStateExpiresAt: timestamp("install_state_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

// ---------------------------------------------------------------------------
// Conversations & work
// ---------------------------------------------------------------------------

/** A thread on one channel: Slack thread, email thread, WhatsApp chat. */
export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    /** Channel-native thread id: Slack thread_ts, email Message-ID root, wa chat id. */
    threadRef: text("thread_ref").notNull(),
    startedById: uuid("started_by_id").references(() => people.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversations_agent_channel_thread_uq").on(t.agentId, t.channel, t.threadRef)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    /** Null for unknown senders and for the agent's own outbound messages. */
    senderPersonId: uuid("sender_person_id").references(() => people.id, { onDelete: "set null" }),
    senderHandle: text("sender_handle"),
    body: text("body").notNull(),
    /** Original channel payload, for debugging. */
    raw: jsonb("raw"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

/** Every unit of work, from a quick question to a long multi-step job. */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The person whose permissions the task runs with. */
    requestedById: uuid("requested_by_id").references(() => people.id, { onDelete: "set null" }),
    source: taskSourceEnum("source").notNull(),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** Set when another agent delegated this task. */
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    status: taskStatusEnum("status").notNull().default("queued"),
    input: text("input").notNull(),
    output: text("output"),
    error: text("error"),
    /** How far we trust the requester's identity for this request. */
    callerTrust: text("caller_trust").$type<"verified" | "unverified">().notNull().default("verified"),
    replyChannel: channelEnum("reply_channel"),
    replyTarget: text("reply_target"),
    /** Full model transcript, so a task can pause for approval and resume later. */
    transcript: jsonb("transcript").$type<unknown[]>().notNull().default([]),
    /**
     * System prompt and tool list, fixed when the task starts. They must stay
     * byte-identical while the task runs (the model's thinking is tied to them).
     */
    modelContext: jsonb("model_context").$type<{ model: string; effort?: string | null; system: string; tools: unknown[] }>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_agent_status_idx").on(t.agentId, t.status),
    index("tasks_requested_by_idx").on(t.requestedById),
    index("tasks_parent_idx").on(t.parentTaskId),
  ],
);

/** A paused tool call waiting for a human decision. */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** The model's id for this tool call, used to resume the transcript. */
    toolCallId: text("tool_call_id").notNull(),
    tool: text("tool").notNull(),
    args: jsonb("args").notNull(),
    approverId: uuid("approver_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    status: approvalStatusEnum("status").notNull().default("pending"),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_approver_status_idx").on(t.approverId, t.status),
    index("approvals_task_idx").on(t.taskId),
  ],
);

// ---------------------------------------------------------------------------
// Memory & audit
// ---------------------------------------------------------------------------

/**
 * One memory store per agent, shared across all channels, scoped by visibility:
 *   private    -> only used when `ownerPersonId` is the requester
 *   team       -> only used when the requester is in `teamId`
 *   agent_wide -> the agent's own know-how, used for everyone
 */
export const memories = pgTable(
  "memories",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    visibility: memoryVisibilityEnum("visibility").notNull(),
    ownerPersonId: uuid("owner_person_id").references(() => people.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("memories_agent_visibility_idx").on(t.agentId, t.visibility),
    index("memories_fts_idx").using("gin", sql`to_tsvector('english', ${t.content})`),
    check(
      "memories_scope_ck",
      sql`(${t.visibility} = 'private' AND ${t.ownerPersonId} IS NOT NULL)
        OR (${t.visibility} = 'team' AND ${t.teamId} IS NOT NULL)
        OR (${t.visibility} = 'agent_wide')`,
    ),
  ],
);

/** Append-only record of everything that happened. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    /** e.g. "message.received", "access.denied", "tool.called", "approval.decided". */
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_log_agent_created_idx").on(t.agentId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Relations (for drizzle's relational query API)
// ---------------------------------------------------------------------------

export const peopleRelations = relations(people, ({ one, many }) => ({
  team: one(teams, { fields: [people.teamId], references: [teams.id] }),
  identities: many(personIdentities),
}));

export const personIdentitiesRelations = relations(personIdentities, ({ one }) => ({
  person: one(people, { fields: [personIdentities.personId], references: [people.id] }),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  slackApp: one(agentSlackApps, { fields: [agents.id], references: [agentSlackApps.agentId] }),
  manager: one(people, { fields: [agents.managerId], references: [people.id] }),
  team: one(teams, { fields: [agents.teamId], references: [teams.id] }),
  skills: many(agentSkills),
  tools: many(agentTools),
  channels: many(agentChannels),
  grants: many(accessGrants),
  routines: many(routines),
  memories: many(memories),
}));

export const agentSlackAppsRelations = relations(agentSlackApps, ({ one }) => ({
  agent: one(agents, { fields: [agentSlackApps.agentId], references: [agents.id] }),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, { fields: [agentSkills.agentId], references: [agents.id] }),
}));

export const agentToolsRelations = relations(agentTools, ({ one }) => ({
  agent: one(agents, { fields: [agentTools.agentId], references: [agents.id] }),
}));

export const agentChannelsRelations = relations(agentChannels, ({ one }) => ({
  agent: one(agents, { fields: [agentChannels.agentId], references: [agents.id] }),
}));

export const accessGrantsRelations = relations(accessGrants, ({ one }) => ({
  agent: one(agents, { fields: [accessGrants.agentId], references: [agents.id] }),
}));

export const routinesRelations = relations(routines, ({ one }) => ({
  agent: one(agents, { fields: [routines.agentId], references: [agents.id] }),
  runAs: one(people, { fields: [routines.runAsId], references: [people.id] }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  requestedBy: one(people, { fields: [tasks.requestedById], references: [people.id] }),
  conversation: one(conversations, { fields: [tasks.conversationId], references: [conversations.id] }),
  parent: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id], relationName: "subtasks" }),
  subtasks: many(tasks, { relationName: "subtasks" }),
  approvals: many(approvals),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  agent: one(agents, { fields: [memories.agentId], references: [agents.id] }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Channel = (typeof channelEnum.enumValues)[number];
export type AccessLevel = (typeof accessLevelEnum.enumValues)[number];
export type MemoryVisibility = (typeof memoryVisibilityEnum.enumValues)[number];
export type Person = typeof people.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AccessGrant = typeof accessGrants.$inferSelect;
export type AgentTool = typeof agentTools.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Routine = typeof routines.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
