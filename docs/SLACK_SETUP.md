# Setting up AI employees in Slack

Each AI employee is its own Slack app, so it appears in Slack as a separate colleague with its own
name, DMs and @mention. You don't create those apps by hand. After a one-time connection, adding an
employee to Slack is **one command and one click**.

## Before you start

The server needs these settings (see `.env.example`):

```bash
PUBLIC_URL=https://ai.example.com   # public HTTPS address Slack can reach
SECRETS_KEY=…                       # encrypts Slack credentials in the database
ADMIN_TOKEN=…                       # protects the /admin endpoints
```

Generate `SECRETS_KEY` once and keep it in your secret manager. If it's lost, every employee has to be reconnected to Slack.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

For local testing, a tunnel such as `cloudflared tunnel --url http://localhost:3000` gives you a public URL.

## Once: connect Slack

1. A Slack workspace admin opens <https://api.slack.com/apps> and, under **Your App Configuration
   Tokens**, clicks **Generate Token** for your workspace.
2. Copy the **Refresh Token**. Slack expires the access token every 12 hours; the server renews it
   automatically with the refresh token.
3. Run:

```bash
npm run slack:connect -- <refresh-token>
```

The apps it creates belong to the admin whose token this is, so use an admin account that will stay
with the company.

## For each employee: one command, one click

```bash
npm run slack:hire -- sourcer
```

This creates the employee's Slack app with the right name, permissions, events and buttons, stores its
credentials encrypted, and prints an **Add to Slack** link. A workspace admin opens the link and clicks **Allow**.
That's it: the employee shows up in Slack and can be DMed or @mentioned.

The same is available over HTTP for the upcoming admin console:

```bash
curl -X POST https://ai.example.com/admin/agents/sourcer/slack -H "Authorization: Bearer $ADMIN_TOKEN"
```

Running the command again does not create a second app. It prints a fresh link, which is useful if
the old one expired (links last 7 days and work once).

**Optional:** give the employee a face. Slack has no API for app icons, so upload a picture under the
app's **Basic Information** page on api.slack.com/apps (about 30 seconds).

## People

People are recognized by their Slack member ID (in Slack: profile → ⋯ → **Copy member ID**), stored in
`person_identities` with channel `slack`.

## Tools (Executor)

In Executor, create a **scoped connection** for each employee with only its accounts and tools, set to
the **automatic** approval mode (this app handles approvals per person and scope). Then set:

```bash
EXECUTOR_URL__SOURCER=https://mcp.executor.sh/mcp?connection=<id>
EXECUTOR_TOKEN__SOURCER=<access token for that connection>
```

The key is the agent's `executor_workspace`. Check that the tools load:

```bash
npm run executor:check -- sourcer
```

## Try it

- Invite the employee to a channel and write `@Nova find backend engineers in Berlin`.
- Ask for something that needs approval, such as sending an outreach email. Nova's manager gets a DM
  with **Approve** and **Deny** buttons, and Nova continues in the original thread once someone decides.

## Creating an app by hand instead

If you can't use a configuration token, create the app manually:

```bash
npm run slack:manifest -- sourcer https://ai.example.com
```

Paste the output at api.slack.com/apps → **Create New App → From a manifest**, install it, and set
`SLACK_BOT_TOKEN__SOURCER` and `SLACK_SIGNING_SECRET__SOURCER`. Then set the bot's member ID as the
agent's Slack address (`agent_channels`, channel `slack`).
