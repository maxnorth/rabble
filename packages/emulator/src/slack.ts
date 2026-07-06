/**
 * Slack API fake — the slice used by connection setup and health checks.
 */
import type { FastifyInstance } from "fastify";
import { logRequest, state } from "./state.js";

export function mountSlack(app: FastifyInstance): void {
  app.post("/mock/slack.com/api/auth.test", async (req) => {
    logRequest("slack.com", "POST", "/api/auth.test", req.body ?? null);
    return {
      ok: true,
      url: "https://acme.slack.com/",
      team: "Acme Corp",
      user: "rabble-bot",
      team_id: "T0EMU",
      user_id: "U0EMU",
      bot_id: "B0EMU",
    };
  });

  app.post("/mock/slack.com/api/chat.postMessage", async (req) => {
    logRequest("slack.com", "POST", "/api/chat.postMessage", req.body ?? null);
    return { ok: true, channel: "C0EMU", ts: `${Math.floor(Date.now() / 1000)}.000100` };
  });

  app.post("/mock/slack.com/api/users.info", async (req) => {
    logRequest("slack.com", "POST", "/api/users.info", req.body ?? null);
    const { user } = (req.body ?? {}) as { user?: string };
    const email = user ? state.slackUsers.get(user) : undefined;
    if (!email) return { ok: false, error: "user_not_found" };
    return { ok: true, user: { id: user, profile: { email } } };
  });

  app.post("/mock/slack.com/api/users.lookupByEmail", async (req) => {
    logRequest("slack.com", "POST", "/api/users.lookupByEmail", req.body ?? null);
    const { email } = (req.body ?? {}) as { email?: string };
    const entry = [...state.slackUsers.entries()].find(([, e]) => e === email);
    if (!entry) return { ok: false, error: "users_not_found" };
    return { ok: true, user: { id: entry[0], profile: { email } } };
  });

  app.post("/mock/slack.com/api/conversations.info", async (req) => {
    logRequest("slack.com", "POST", "/api/conversations.info", req.body ?? null);
    const { channel } = (req.body ?? {}) as { channel?: string };
    const name = channel ? state.slackChannels.get(channel) : undefined;
    if (!name) return { ok: false, error: "channel_not_found" };
    return { ok: true, channel: { id: channel, name } };
  });
}
