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
- Install to the workspace and copy the **Bot User OAuth Token** (`xoxb-…`)
- **Basic Information → App Credentials**: copy the **Signing Secret**

## 2. Register the connection in Rabble

Admin → Connections → **+ Add connection**:

- Vendor: `slack`, role **Interface**
- Token: the bot token
- Signing secret: the app's signing secret (this is what authenticates
  inbound events — without it, deliveries are rejected)
- Leave the API base URL empty for real Slack

## 3. Point Slack at your Rabble instance

**Event Subscriptions** → enable, Request URL:

```
https://<your-rabble-host>/api/inbound/slack
```

Rabble answers the `url_verification` handshake automatically. Subscribe to
the bot event `message.channels`, save, and reinstall if prompted.

## 4. Map a channel to an agent

Invite the bot to the channel (`/invite @your-app`), then in Rabble open
the agent → **surfaces** tab → attach the Slack connection with the
channel's name as the label (e.g. `#eng-oncall`).

## What happens on delivery

- Every event is verified with Slack's v0 HMAC signature and a 5-minute
  replay window; redeliveries are deduped by event id.
- The Slack user is resolved to a Rabble user by profile email. People
  without an account get a polite refusal — sessions always belong to a
  governed identity.
- The turn runs through the same runtime as the web: grants enforced,
  tools governed, live judging, scope-violation tracking. Because nobody
  can answer an approval prompt in a channel, user-auth tools that would
  need one are refused with a pointer to the web app (the org approval
  floor is honored).
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
- GitHub: issue comments only (no PR review threads or discussions yet).
- Approvals can't be answered from an unattended surface — run those
  actions from the web app.
- One workspace/installation per connection; use multiple connections for
  more.
