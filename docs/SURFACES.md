# Surfaces: Slack workspaces and GitHub repos

A surface is a delivery point — the platform owns the session either way.
This guide wires a real Slack workspace so channel messages become governed
Rabble sessions (thread = session, replies threaded back).

The e2e suite proves this flow against an emulated Slack; these steps are
the production equivalent.

## 1. Create the Slack app

At https://api.slack.com/apps → **Create New App** → from scratch.

- **OAuth & Permissions → Bot Token Scopes**: `chat:write`,
  `channels:history`, `channels:read`, `users:read`, `users:read.email`
  (add `im:history` for 1:1 DM sessions)
- Install to the workspace and copy the **Bot User OAuth Token** (`xoxb-…`)
- **Basic Information → App Credentials**: copy the **Signing Secret**

## 2. Register the connection in Rabble

Admin → Connections → **+ Add connection**:

- Vendor: `slack`, role **Interface**
- Token: the bot token
- Signing secret: the app's signing secret (this is what authenticates
  inbound events — without it, deliveries are rejected)
- Leave the API base URL empty for real Slack

## 3. Choose a delivery transport

Rabble supports both of Slack's delivery mechanisms; pick one per app.

> **A bot token alone is not enough.** The token lets Rabble *send*
> (post replies, DMs), but Slack never *delivers* channel messages to
> Rabble unless one transport below is configured. A Slack connection with
> neither shows a **"no event delivery"** chip in Admin › Connections —
> tagging the bot will do nothing.

### Option A — Socket Mode (recommended; no public URL)

Rabble dials out to Slack over a WebSocket, so it works from behind a
firewall, on localhost, or anywhere without a public HTTPS endpoint.

- Slack app → **Basic Information → App-Level Tokens** → generate a token
  with the `connections:write` scope (`xapp-…`)
- Slack app → **Socket Mode** → enable
- Slack app → **Event Subscriptions** → enable and subscribe to the bot
  event `message.channels` (no Request URL is needed in Socket Mode, but
  the subscription itself still is — without it Slack sends nothing)
- Paste the token into the connection's **App-level token (Socket Mode)**
  field when registering it in Rabble

Events and the Approve/Deny interactivity payloads stream over the
socket. Rabble acks each envelope immediately, reconnects with backoff,
and honors Slack's periodic `disconnect` refreshes. No Request URLs needed.

### Option B — Events API webhooks (needs a public URL)

**Event Subscriptions** → enable, Request URL:

```
https://<your-rabble-host>/api/inbound/slack
```

Rabble answers the `url_verification` handshake automatically. Subscribe to
the bot event `message.channels`, save, and reinstall if prompted.

Also enable **Interactivity & Shortcuts** with the Request URL

```
https://<your-rabble-host>/api/inbound/slack-interactive
```

— that's what makes the Approve/Deny buttons in approval DMs work.

Both transports feed the same processing pipeline and share event-id
dedupe, so enabling both never double-runs a turn.

## 4. Map a channel to an agent

Invite the bot to the channel (`/invite @your-app`), then in Rabble open
the agent → **surfaces** tab → attach the Slack connection with the
channel's name as the label (e.g. `#eng-oncall`).

## Direct messages: a personal Auto session

DM the bot 1:1 and no channel mapping is involved: the message routes by
intent across the agents *you* can use (like an "Auto" web session,
built-ins excluded), the session lands with surface "Slack DM", and the
reply threads back. People without a Rabble account get the polite
refusal; people with no shared agents are told to ask an admin. Requires
the `im:history` scope and the `message.im` bot event subscription.

## Troubleshooting: "nothing happens when I message the channel"

Work down this list — each item silently drops delivery when missed:

1. **A transport is configured** — the connection needs an app-level token
   (Socket Mode) *or* a signing secret + public Request URL (webhooks). A
   bot token alone can't receive anything (look for the "no event
   delivery" chip on the connection).
2. **Event subscription exists** — the Slack app subscribes to the bot
   event `message.channels` (required for both transports).
3. **The bot is in the channel** — `/invite @your-app`. Slack only
   delivers channel messages to members.
4. **The surface label matches the channel** — `#eng-oncall` on the
   agent's Surfaces tab must match the channel's name (or channel id).
5. **Your Slack email matches your Rabble email** — the sender is resolved
   via `users.info` profile email; a mismatch gets the polite
   "I can only act for Rabble users" refusal (which also requires the
   `users:read.email` scope).
6. Server logs: every dropped delivery returns an `ignored: <reason>`
   response — `curl` the webhook or watch the socket manager's log lines.

Note: you don't need to @-mention the bot — any message in a mapped
channel is delivered (mentions are just messages that include
`<@BOTID>`).

## What happens on delivery

- Every event is verified with Slack's v0 HMAC signature and a 5-minute
  replay window; redeliveries are deduped by event id.
- The Slack user is resolved to a Rabble user by profile email. People
  without an account get a polite refusal — sessions always belong to a
  governed identity.
- The turn runs through the same runtime as the web: grants enforced,
  tools governed, live judging, scope-violation tracking. When a user-auth
  tool needs an approval, Rabble DMs the acting user Approve/Deny buttons
  — the same broker (and timeout) that powers the in-thread approval card
  arbitrates the decision, and only that user's click counts. The org
  approval floor is honored.
- The session appears in the web app with a `Slack #channel` chip; the
  reply lands back in the Slack thread.

---

# GitHub repos as surfaces

Issue comments in a mapped repo become governed sessions (issue =
session); the agent replies as an issue comment.

## 1. Create the webhook

Repo (or org) → Settings → Webhooks → Add:

- Payload URL: `https://<your-rabble-host>/api/inbound/github`
- Content type: `application/json`
- Secret: generate one — you'll give it to Rabble next
- Events: "Issue comments"

## 2. Register the connection in Rabble

Admin → Connections → **+ Add connection**: vendor `github`, a token able
to comment on the repo (fine-grained PAT or app installation token), and
the **webhook secret** from step 1. Leave the base URL empty for
github.com.

## 3. Map the repo and bridge identities

- Agent → **surfaces** tab → attach the GitHub connection with the repo
  path as the label (e.g. `acme/api`).
- Each teammate connects their GitHub account under
  **Profile → Connected accounts**, entering their GitHub username —
  that's how a commenter becomes a governed platform identity. Unknown
  commenters get a comment pointing them there, never a session.

Deliveries are verified with `X-Hub-Signature-256` and deduped by
delivery id; `ping` is answered automatically.

## Limits (v1)

- Slack: public channels only (`message.channels`); DMs and private
  channels need additional scopes/events and aren't wired yet.
- GitHub: issue and PR *conversation* comments (both arrive as
  `issue_comment`); PR review threads and discussions aren't wired yet.
- Approvals can't be answered from an unattended surface — run those
  actions from the web app.
- One workspace/installation per connection; use multiple connections for
  more.
