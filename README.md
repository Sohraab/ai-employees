# AI Employees

AI employees with their own memory, skills, tools, routines and access rules, reachable from
Slack, email, WhatsApp and (later) phone, the way you'd reach a colleague.

**How it all works:** see [`docs/PLAN.md`](docs/PLAN.md), covering connectors, permissions, routines, memory, approvals and the build phases.

Built so far: the data model, the rules for identity, access and memory, and the **engine** that runs requests end to end
(routing, permission-gated tool loop, approvals that pause and resume, memory tools, routine runs, budgets, audit).
Connected to real services: **Claude** (each employee picks its own model and effort), **Executor** (each
employee's own scoped connection), and **Slack** (one Slack app per employee, with Approve/Deny buttons).
Set up an employee in Slack with [`docs/SLACK_SETUP.md`](docs/SLACK_SETUP.md).

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

## Engine (`src/engine`)

| File | Does |
|---|---|
| `router.ts` | `handleInbound(envelope)`: route to agent → identify → authorize → record → create task, or reply as receptionist |
| `runner.ts` | `runTask(id)`: build prompt → model step → gate each tool call → execute / deny / pause for approval → reply |
| `approvals.ts` | `decideApproval()`: only the approver or a manager can decide; resumes the task when the last approval is in |
| `routines.ts` | `startRoutineRun()`: runs as `run_as`, re-checks access, pauses the routine and tells the manager if access is gone |
| `builtins.ts` | `memory.search` / `memory.save`, with the same permission rules |
| `prompt.ts` | System prompt: identity, skills, who it's working for, what that person may have it do, visible memories |
| `types.ts` | `AgentModel`, `ToolExecutor`, `Notifier` interfaces (Claude, Executor and channel adapters plug in here) |

## Adapters

| File | Does |
|---|---|
| `src/adapters/claude.ts` | Claude Messages API: per-employee model and effort, raw blocks replayed unchanged, refusal fallback, cost tracking |
| `src/adapters/executor.ts` | Executor over MCP: lists and calls tools one at a time through the employee's scoped connection |
| `src/channels/slack.ts` | Slack: request signing, events → envelopes, sending as the right app, approval buttons, app manifest |
| `src/server/app.ts` | HTTP endpoints: `/slack/:slug/events`, `/slack/:slug/interactions`, `/healthz` |
| `src/server/main.ts` | Server + worker; tasks queued in Postgres (pg-boss) |

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

```bash
npm start
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

1. ✅ Data model, identity, access rules, memory visibility
2. ✅ Engine core: router, permission-gated runner, approvals, memory tools, routine runs, budgets, audit
3. ✅ Claude model adapter (per-employee model and effort) and Executor tool adapter
4. ✅ Slack adapter (one app per employee) + API server + job queue (pg-boss); approvals via Slack buttons
4b. Working like a colleague: per-conversation ordering, automatic memory, awareness of its other work, asking other people (see `docs/PLAN.md`)
5. Routine scheduler (cron → `next_run_at`)
6. Email adapter (inbound via Postmark or Resend, with SPF/DKIM checks)
7. Admin console (Next.js): agents, grants, routines, task feed, memories, costs
8. WhatsApp adapter, then phone
