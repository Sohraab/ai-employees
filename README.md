# AI Employees

AI employees with their own memory, skills, tools, routines and access rules, reachable from
Slack, email, WhatsApp and (later) phone, the way you'd reach a colleague.

This repo currently holds **step 1: the data model** and the core rules for identity, access and memory.
The agent runtime, channel adapters and admin console come next (see the roadmap below).

## Core ideas

- **One agent, many channels.** An AI employee's memory, permissions and work live in the backend.
  Slack, email, WhatsApp and phone are thin adapters that produce one standard `InboundEnvelope`
  (`src/channels/types.ts`).
- **Two checks on every action.** Is the *caller* allowed to ask this agent for this (`access_grants`)?
  Is the *agent* allowed to do it (`agent_tools`, enforced again by Executor)?
  **Effective permission = caller's grant ∩ agent's capability.**
- **Memory is shared across channels but scoped by visibility:** `private` (only the person who said it),
  `team`, or `agent_wide`. What Alice said in a DM never reaches Bob.
- **Routines run as a real person** (`run_as`), so a scheduled job is never more powerful than its owner.
- **Every request becomes a task**, with an audit trail, cost, and optional human approval.

## Request flow

```
Slack / Email / WhatsApp / Phone
        │ channel adapter
        ▼
1. Normalize   → InboundEnvelope
2. Identify    → person_identities → people        (core/identity.ts)
3. Authorize   → access_grants                     (core/access.ts: authorizeRequest)
4. Create task → tasks
5. Run agent   → instructions + skills + memories (core/memory.ts) + Executor tools
6. Gate tools  → agent_tools ∩ grants → allow / needs_approval / deny  (authorizeToolCall)
7. Reply       → same channel (or another)
8. Remember    → memories with a visibility scope
9. Audit       → audit_log
```

Routines (scheduled tasks) start at step 4.

## Data model

| Table | Purpose |
|---|---|
| `organizations`, `teams`, `people` | The humans and how they are grouped |
| `person_identities` | A person's Slack id / email / phone, with verification status |
| `agents` | The AI employee: role, instructions, model, manager, Executor workspace, budget |
| `agent_skills` | Markdown skills the agent loads when relevant |
| `agent_tools` | Tools the agent may use, minimum caller level, required scope, approval needed |
| `agent_channels` | Where the agent can be reached (its Slack bot, inbox, number) |
| `access_grants` | Who may use the agent: person / team / role / everyone, level and scopes |
| `routines` | Cron jobs: prompt, `run_as`, where to deliver results |
| `conversations`, `messages` | Threads per channel |
| `tasks` | Every unit of work, with status, cost, parent task for agent-to-agent handoffs |
| `approvals` | Paused tool calls waiting for a human decision |
| `memories` | Per-agent memory with `private` / `team` / `agent_wide` visibility, full-text indexed |
| `audit_log` | Append-only record of everything |

Schema: [`src/db/schema.ts`](src/db/schema.ts). Generated SQL: [`drizzle/0000_init.sql`](drizzle/0000_init.sql).

### Access levels

| Level | Can |
|---|---|
| `talk` | Ask questions, get answers, use read-only tools marked `talk` |
| `assign` | Give it work that calls tools or takes actions |
| `manage` | Edit its skills and routines; approves its risky actions |
| `admin` | Change its tool access and who it works for |

A grant's `scopes` narrow it (e.g. `["candidate_outreach"]`); an empty list covers every scope at that level.
Grants are checked one at a time and never combined. The agent's manager has implicit `manage`, and org admins have implicit `admin`.
Senders whose identity isn't verified for this message (e.g. an email failing DKIM, or a phone number with no OTP check yet) are limited to `talk`.

## Getting started

```bash
npm install
```

```bash
docker compose up -d
```

```bash
cp .env.example .env
```

```bash
npm run db:migrate && npm run db:seed
```

```bash
npm test
```

Tests apply the real migration to an in-process Postgres (PGlite), so `npm test` needs no Docker.

After changing `src/db/schema.ts`, run `npm run db:generate` to create a new migration.

## Seed data

`src/db/seed-data.ts` creates an example org with two AI employees:

- **Nova, Recruiting Sourcer.** The Talent team can assign work. Sales can request sourcing but not
  candidate outreach. Outreach emails need the Head of Talent's approval.
- **Atlas, Ops Reporter.** Everyone can talk to Atlas, and Ops can assign work.
  A weekday 8:47 metrics digest runs as the Ops lead and posts to Slack.

## Roadmap

1. ✅ Data model, identity, access rules, memory visibility, tests
2. Slack adapter (Bolt) and event router: envelope → identify → authorize → task
3. Agent runtime: Claude Agent SDK, with Executor as the MCP tool server; tool calls gated by `authorizeToolCall`
4. Approvals through Slack buttons; audit log writes
5. Routine scheduler (Inngest, Trigger.dev or Temporal)
6. Email adapter (inbound via Postmark or Resend, with SPF/DKIM checks)
7. Admin console (Next.js): agents, grants, routines, task feed, memories, costs
8. WhatsApp adapter, then phone
