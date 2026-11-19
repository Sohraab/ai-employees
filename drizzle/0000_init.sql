CREATE TYPE "public"."access_level" AS ENUM('talk', 'assign', 'manage', 'admin');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('person', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('slack', 'email', 'whatsapp', 'phone', 'web');--> statement-breakpoint
CREATE TYPE "public"."grant_subject" AS ENUM('person', 'team', 'role', 'everyone');--> statement-breakpoint
CREATE TYPE "public"."memory_visibility" AS ENUM('private', 'team', 'agent_wide');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."task_source" AS ENUM('channel', 'routine', 'agent', 'api');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'denied', 'cancelled');--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"subject_type" "grant_subject" NOT NULL,
	"subject_id" text,
	"level" "access_level" NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"granted_by_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grants_subject_id_ck" CHECK (("access_grants"."subject_type" = 'everyone' AND "access_grants"."subject_id" IS NULL) OR ("access_grants"."subject_type" <> 'everyone' AND "access_grants"."subject_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "agent_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"address" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_pattern" text NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"required_scope" text,
	"min_level" "access_level" DEFAULT 'assign' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"instructions" text NOT NULL,
	"model" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"manager_id" uuid,
	"team_id" uuid,
	"executor_workspace" text,
	"monthly_budget_usd" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"approver_id" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"task_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"thread_ref" text NOT NULL,
	"started_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"content" text NOT NULL,
	"visibility" "memory_visibility" NOT NULL,
	"owner_person_id" uuid,
	"team_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_task_id" uuid,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_scope_ck" CHECK (("memories"."visibility" = 'private' AND "memories"."owner_person_id" IS NOT NULL)
        OR ("memories"."visibility" = 'team' AND "memories"."team_id" IS NOT NULL)
        OR ("memories"."visibility" = 'agent_wide'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"sender_person_id" uuid,
	"sender_handle" text,
	"body" text NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"team_id" uuid,
	"is_org_admin" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"handle" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"prompt" text NOT NULL,
	"run_as_id" uuid NOT NULL,
	"deliver_channel" "channel" NOT NULL,
	"deliver_target" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"requested_by_id" uuid,
	"source" "task_source" NOT NULL,
	"routine_id" uuid,
	"conversation_id" uuid,
	"parent_task_id" uuid,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"input" text NOT NULL,
	"output" text,
	"error" text,
	"reply_channel" "channel",
	"reply_target" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_granted_by_id_people_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manager_id_people_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_people_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_started_by_id_people_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_person_id_people_id_fk" FOREIGN KEY ("sender_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_run_as_id_people_id_fk" FOREIGN KEY ("run_as_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_id_people_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requested_by_id_people_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_agent_idx" ON "access_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_channels_channel_address_uq" ON "agent_channels" USING btree ("channel","address");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_agent_name_uq" ON "agent_skills" USING btree ("agent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tools_agent_pattern_uq" ON "agent_tools" USING btree ("agent_id","tool_pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_slug_uq" ON "agents" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "approvals_approver_status_idx" ON "approvals" USING btree ("approver_id","status");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_agent_created_idx" ON "audit_log" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_agent_channel_thread_uq" ON "conversations" USING btree ("agent_id","channel","thread_ref");--> statement-breakpoint
CREATE INDEX "memories_agent_visibility_idx" ON "memories" USING btree ("agent_id","visibility");--> statement-breakpoint
CREATE INDEX "memories_fts_idx" ON "memories" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "people_org_idx" ON "people" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "people_team_idx" ON "people" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_identities_org_channel_handle_uq" ON "person_identities" USING btree ("org_id","channel","handle");--> statement-breakpoint
CREATE INDEX "person_identities_person_idx" ON "person_identities" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "routines_due_idx" ON "routines" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "tasks_agent_status_idx" ON "tasks" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "tasks_requested_by_idx" ON "tasks" USING btree ("requested_by_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_name_uq" ON "teams" USING btree ("org_id","name");