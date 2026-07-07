/**
 * Slack API fake — the slice used by connection setup and health checks,
 * plus Socket Mode: apps.connections.open hands out a ws:// URL on this
 * emulator, and envelopes pushed via POST /admin/slack/socket-event stream
 * to whoever is connected, exactly like Slack's real socket.
 */
import type { FastifyInstance } from "fastify";
import { logRequest, state } from "./state.js";

/**
 * Push one Socket Mode envelope to connected clients. With `appToken`, only
 * the socket that opened with that app-level token receives it — mirroring
 * how real Slack delivers an event solely to the app it belongs to. Without
 * one, it broadcasts (back-compat for single-workspace tests). Returns how
 * many sockets received it (0 = nobody matched, the test should fail loudly).
 */
export function pushSlackSocketEnvelope(
  envelope: {
    envelope_id: string;
    type: string;
    payload: unknown;
  },
  appToken?: string,
): number {
  let delivered = 0;
  for (const socket of state.slackSockets) {
    if (appToken && state.slackSocketApp.get(socket) !== appToken) continue;
    try {
      socket.send(JSON.stringify(envelope));
      delivered += 1;
    } catch {
      state.slackSockets.delete(socket);
      state.slackSocketApp.delete(socket);
    }
  }
  if (delivered > 0) {
    state.slackSocketLog.push({
      ts: new Date().toISOString(),
      direction: "sent",
      envelopeId: envelope.envelope_id,
      type: envelope.type,
    });
  }
  return delivered;
}

export function mountSlack(app: FastifyInstance): void {
  app.post("/mock/slack.com/api/apps.connections.open", async (req) => {
    logRequest("slack.com", "POST", "/api/apps.connections.open", null);
    const auth = String(req.headers.authorization ?? "");
    // Slack only accepts app-level tokens (xapp-…) here — bot tokens fail.
    if (!auth.startsWith("Bearer xapp-")) {
      return { ok: false, error: "invalid_auth" };
    }
    // Carry the app token into the ws URL so the socket can be tagged to its
    // workspace (real Slack scopes the socket to the app implicitly).
    const appToken = auth.slice("Bearer ".length);
    const host = req.headers.host ?? "localhost:4100";
    return {
      ok: true,
      url: `ws://${host}/mock/slack.com/socket?app=${encodeURIComponent(appToken)}`,
    };
  });

  app.get("/mock/slack.com/socket", { websocket: true }, (socket, req) => {
    const appToken = new URL(req.url ?? "", "http://localhost").searchParams.get(
      "app",
    );
    state.slackSockets.add(socket);
    if (appToken) state.slackSocketApp.set(socket, appToken);
    socket.send(
      JSON.stringify({ type: "hello", num_connections: state.slackSockets.size }),
    );
    socket.on("message", (raw: Buffer) => {
      try {
        const ack = JSON.parse(raw.toString()) as { envelope_id?: string };
        if (ack.envelope_id) {
          state.slackSocketLog.push({
            ts: new Date().toISOString(),
            direction: "ack",
            envelopeId: ack.envelope_id,
          });
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
    socket.on("close", () => {
      state.slackSockets.delete(socket);
      state.slackSocketApp.delete(socket);
    });
  });

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

  // Interactivity response_url sink: logs message replacements
  app.post("/mock/slack.com/response/:ref", async (req) => {
    const { ref } = req.params as { ref: string };
    logRequest("slack.com", "POST", `/response/${ref}`, req.body ?? null);
    return { ok: true };
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
