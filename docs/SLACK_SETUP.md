# Setting up an AI employee in Slack

Each AI employee is its own Slack app, so it appears in Slack as a separate colleague with its
own name, avatar and DMs. Repeat these steps for each employee.

## 1. Run the server somewhere Slack can reach

Slack needs a public HTTPS URL, for example `https://ai.example.com`. For local testing, use a
tunnel such as `cloudflared tunnel --url http://localhost:3000`.

## 2. Create the Slack app from a manifest

```bash
npm run slack:manifest -- sourcer https://ai.example.com
```

Copy the JSON, go to <https://api.slack.com/apps>, choose **Create New App → From a manifest**,
pick your workspace and paste it. The manifest sets:

- **Bot scopes:** `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `files:read`
- **Events:** `app_mention` (an @mention in a channel) and `message.im` (a DM), sent to `/slack/<slug>/events`
- **Interactivity** (Approve/Deny buttons), sent to `/slack/<slug>/interactions`

Upload the employee's avatar under **Basic Information → Display Information**.

## 3. Install it and add the secrets

Install the app to the workspace, then set two environment variables. The slug is upper-cased, with `-` replaced by `_`:

```bash
SLACK_BOT_TOKEN__SOURCER=xoxb-…         # OAuth & Permissions → Bot User OAuth Token
SLACK_SIGNING_SECRET__SOURCER=…         # Basic Information → Signing Secret
```

## 4. Tell the database the bot's user id

Every message is routed to the right employee by the bot's Slack user id. To find it, open
the app's profile in Slack and choose **Copy member ID**. Then set it as the agent's Slack address
(`agent_channels.address`, channel `slack`). The seed data uses placeholders (`B_NOVA`, `B_ATLAS`).

People are recognized by their Slack member ID in `person_identities` (channel `slack`).

## 5. Connect its tools (Executor)

In Executor, create a **scoped connection** for this employee with only its accounts and tools,
and set it to the **automatic** approval mode. This app handles approvals itself, per person and
scope. Then set:

```bash
EXECUTOR_URL__SOURCER=https://mcp.executor.sh/mcp?connection=<id>
EXECUTOR_TOKEN__SOURCER=<access token for that connection>
```

The key is the agent's `executor_workspace`. Check that the tools load:

```bash
npm run executor:check -- sourcer
```

## 6. Try it

- Invite the bot to a channel and write `@Nova find backend engineers in Berlin`.
- Ask for something that needs approval, such as sending an outreach email. Nova's manager gets a DM
  with **Approve** and **Deny** buttons, and Nova continues in the original thread once someone decides.
