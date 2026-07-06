/**
 * Slack API fake — the slice used by connection setup and health checks.
 */
import type { FastifyInstance } from "fastify";
import { logRequest } from "./state.js";

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
}
