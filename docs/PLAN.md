# How AI employees work — MVP plan

## 1. What an AI employee is

An AI employee is one record (`agents`) plus everything attached to it. Channels are only ways to reach it.

| Part | What it is | Where it lives |
|---|---|---|
| **Profile** | Name, job title, instructions, model, status (active/paused) | `agents` |
| **Manager** | The human responsible for it. Approves its risky actions by default | `agents.manager_id` |
| **Skills** | Markdown playbooks: *how* it does its job | `agent_skills` |
| **Tools & connectors** | What it *can* do: Gmail, ATS, BigQuery, Slack… | Executor workspace + `agent_tools` rules |
| **Channels** | Where people reach it: its Slack bot, inbox, WhatsApp number | `agent_channels` |
| **Access grants** | *Who* may ask it for *what* | `access_grants` |
| **Routines** | Work it does on a schedule | `routines` |
| **Memory** | What it knows, scoped by who may see it | `memories` |
| **Budget** | Monthly spend cap | `agents.monthly_budget_usd` |

## 2. Connectors and credentials

All tool access goes through **Executor**. Each AI employee gets its **own Executor workspace**,
holding only the connectors and credentials that employee needs. The agent never sees a secret.

Two credential modes:

1. **Agent-owned (MVP).** The agent has its own accounts, like a new hire: `nova@agents.example.com`,
   an ATS API key, a read-only BigQuery service account. Simple, auditable, and easy to revoke.
2. **Delegated (later).** The agent acts with the *requester's* own OAuth token ("send this from my Gmail").
   This needs per-person connector logins and is only worth building once teams ask for it.

Tool rules (`agent_tools`) are our policy layer on top of Executor:

- `tool_pattern`: `gmail.send_message`, `ats.*`, `*`
- `min_level`: the caller's minimum access level to trigger it (`talk` for read-only lookups, `assign` for actions)
- `required_scope`: the kind of work the caller's grant must cover (e.g. `candidate_outreach`)
- `requires_approval`: a human must approve each call

Executor's own policies and approval gates stay on as a second line of defence.

**Rule of thumb for new tools:** read-only → `talk`; writes inside the company → `assign`;
anything leaving the company (emails, messages to customers or candidates) or anything destructive → `assign` + approval.

## 3. Who may ask for what

Every action passes **two checks, and both must pass**:

```
caller's grants on this agent   ∩   agent's tool rules   =   what actually happens
```

**Access grants** give a person, a team, a role, or everyone a level on one agent:

| Level | Can |
|---|---|
| `talk` | Ask questions; use read-only tools marked `talk` |
| `assign` | Give it work that takes actions |
| `manage` | Edit its skills and routines; approve its risky actions |
| `admin` | Change its tools and its grants |

- `scopes` narrow a grant: Sales may `assign` Nova work, but only with scope `sourcing`.
- Grants are checked one at a time and never added together.
- The agent's manager has implicit `manage`; org admins have implicit `admin`.
- Grants can expire (temporary access for a project or a contractor).

**Permission is checked when the agent calls a tool, not by guessing the intent of the request.**
The agent is told up front what this caller is allowed to have it do, so it doesn't plan work it can't
finish. If it tries anyway, the gate stops it and the agent explains why.

**Identity trust:**

- An unknown sender gets *receptionist mode*: a polite reply and a hand-off to the manager, never an action.
- A known sender whose message can't be proven (an email failing SPF/DKIM, or a WhatsApp number with no OTP check yet) is limited to `talk`.

**Approvals:** when a tool needs approval, the task pauses and the approver (the agent's manager) gets
an Approve/Deny message on their preferred channel. If they approve, the call runs and the task
continues. If they deny, the agent is told and explains this to the requester. When the manager makes
the request themselves, it runs straight away.

## 4. Life of a request

```
1. Channel adapter  verify webhook signature → InboundEnvelope
2. Route            agent_channels: which agent was addressed?
3. Identify         person_identities → person + trust level
4. Authorize        authorizeRequest → allow | receptionist | reject
5. Record           conversation + message, task (status: queued)
6. Run              system prompt = instructions + skills + caller's permissions
                    + memories this caller may see + recent thread messages
7. Tool loop        model asks for a tool → authorizeToolCall
                      allow           → execute via Executor, feed result back
                      deny            → feed the reason back, the agent explains
                      needs_approval  → save transcript, create approval, pause
8. Reply            final answer → same channel and thread
9. Remember         agent saves memories (memory.save) with a visibility scope
10. Audit           every step written to audit_log; tokens and cost on the task
```

Because the whole transcript is saved on the task, a task can pause for hours (waiting for an approval)
and continue without losing anything. This is why the runner drives the model step by step itself
(Claude Messages API with tool use) rather than running one long in-memory agent session.

## 5. Routines

A routine is `cron + timezone + prompt + run_as + deliver_to`.

- Each run creates a normal task with `source = routine` and `requested_by = run_as`.
  It goes through exactly the same permission checks as a human request.
- **Access is re-checked at every run.** If the `run_as` person loses access or leaves the company, the
  routine is paused and the manager is told.
- Results go to `deliver_to` (a Slack channel, an email address). Failures alert the manager.
- People with `manage` can create routines by asking in chat ("every Friday, send me…"). People with only
  `assign` can propose one, and it goes to the manager for approval.
- Missed runs (downtime) run once, not once for each missed slot.

## 6. Memory

- **One memory per agent, across all channels.** Something said on WhatsApp is known in Slack.
- **Visibility:** `private` (only the person it's about or from), `team`, `agent_wide`.
- The agent writes memory with a built-in `memory.save` tool:
  - Content from a DM defaults to `private` to the requester.
  - It may only save `private` memories for the requester, and `team` memories for the requester's team.
- Recall filters by the requester first, then ranks by relevance. It uses Postgres full-text search for now and can move to embeddings later.
- Managers can view, edit and archive memories in the admin console.

## 7. Agent to agent

An agent can hand work to another agent with a built-in `agent.delegate` tool. This creates a child task
(`parent_task_id`). The child runs **as the original human requester**, so delegating can't be used to
gain access. The calling agent's own grant on the target agent must also allow it.

## 8. Oversight

- **Pause switch:** a paused agent rejects every request and skips routines.
- **Budget:** when the monthly cap is reached, new tasks are refused and the manager is notified.
- **Audit log:** every message, access decision, tool call, approval, and memory write.
- **Admin console:** agents, grants, tools, routines, the task feed, pending approvals, memories, and spend.

## 9. Architecture

```
            ┌────────────── Channel adapters ──────────────┐
            │ Slack (Bolt) · Email (Postmark) · WhatsApp     │
            └──────────────┬───────────────────────────────┘
                           ▼
 API server ── engine/router: route · identify · authorize · record · enqueue
                           ▼
 Job queue (pg-boss on Postgres; no extra infrastructure)
                           ▼
 Worker ──── engine/runner: prompt · model step · tool gate · approvals
                 │                     │
         Claude Messages API     Executor (per-agent workspace, MCP)
                           ▼
                       Postgres (everything in this repo's schema)
```

The engine is independent of any channel. The model and the tool executor are behind interfaces, so
tests run the full flow with a scripted fake model and fake tools.

## 10. Build phases

| # | Phase | Done when |
|---|---|---|
| 1 | ✅ Data model, identity, access, memory visibility | Schema migrated; 24 tests pass |
| 2 | ✅ **Engine core** (router, runner, tool gate, approvals, memory tools, routine runs, audit) | The full flow passes in tests with a fake model: allowed, denied, approval → resume, receptionist |
| 3 | Claude model adapter + Executor tool adapter | A real agent answers and calls a real read-only tool |
| 4 | Slack adapter + API server + job queue | Someone @mentions Nova in Slack and gets an answer in the thread; approvals via buttons |
| 5 | Routine scheduler | Atlas posts the weekday digest on time |
| 6 | Email adapter | Emailing Nova gets a reply in the same thread; spoofed senders are limited to `talk` |
| 7 | Admin console | A manager can create an agent, grant access, and approve or deny actions without touching the database |
| 8 | WhatsApp, delegated credentials, phone | — |

## 11. Decisions still open

1. **Slack setup:** one Slack app per agent (each a real user with its own name in the sidebar, but more setup) or one app with many personas (simpler). *Recommendation:* one app per agent; it feels like a colleague.
2. **Credentials:** agent-owned only for the MVP? *Recommendation:* yes.
3. **Hosting:** a single container (API and worker) plus managed Postgres, e.g. Fly.io or Railway with Neon.
