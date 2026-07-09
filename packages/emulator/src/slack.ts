/**
 * Slack API fake — the slice used by connection setup and health checks,
 * plus Socket Mode: apps.connections.open hands out a ws:// URL on this
 * emulator, and envelopes pushed via POST /admin/slack/socket-event stream
 * to whoever is connected, exactly like Slack's real socket.
 */
import type { FastifyInstance } from "fastify";
import { logRequest, state } from "./state.js";

/**
 * Push one Socket Mode envelope to every connected client. Returns how many
 * sockets received it (0 = nobody is connected, the test should fail loudly).
 */
export function pushSlackSocketEnvelope(envelope: {
  envelope_id: string;
  type: string;
  payload: unknown;
}): number {
  let delivered = 0;
  for (const socket of state.slackSockets) {
    try {
      socket.send(JSON.stringify(envelope));
      delivered += 1;
    } catch {
      state.slackSockets.delete(socket);
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
    const host = req.headers.host ?? "localhost:4100";
    return { ok: true, url: `ws://${host}/mock/slack.com/socket` };
  });

  app.get("/mock/slack.com/socket", { websocket: true }, (socket) => {
    state.slackSockets.add(socket);
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
    // Form-encoded requests (what the @slack/web-api SDK sends) carry blocks /
    // attachments as JSON strings; parse them back so logged assertions can
    // inspect their structure, matching real Slack's semantics.
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    for (const key of ["blocks", "attachments"]) {
      if (typeof body[key] === "string") {
        try {
          body[key] = JSON.parse(body[key] as string);
        } catch {
          // leave as-is if not JSON
        }
      }
    }
    logRequest("slack.com", "POST", "/api/chat.postMessage", body);
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

  // --- App configuration / manifest APIs (managed setup) ---
  // Matches real Slack behavior (verified empirically 2026-07): manifest
  // update does NOT synchronously challenge the events request_url (url
  // verification happens lazily, after install), but it DOES validate that
  // every subscribed event has its required OAuth scope, failing with
  // invalid_manifest + a detailed errors array.
  const EVENT_SCOPE_REQUIREMENTS: Record<string, string> = {
    app_mention: "app_mentions:read",
    "message.channels": "channels:history",
    "message.groups": "groups:history",
    "message.im": "im:history",
    "message.mpim": "mpim:history",
  };
  type Manifest = {
    oauth_config?: { scopes?: { bot?: string[] } };
    settings?: { event_subscriptions?: { bot_events?: string[] } };
  };
  function parseManifest(raw: unknown): Manifest | null {
    if (typeof raw !== "string") return (raw ?? {}) as Manifest;
    try {
      return JSON.parse(raw) as Manifest;
    } catch {
      return null;
    }
  }
  function manifestScopeErrors(manifest: Manifest): Record<string, unknown>[] {
    const scopes = manifest.oauth_config?.scopes?.bot ?? [];
    const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
    return events.flatMap((event) => {
      const needed = EVENT_SCOPE_REQUIREMENTS[event];
      if (!needed || scopes.includes(needed)) return [];
      return [
        {
          code: `${event}_event_missing_scope`,
          message: `${event} event is missing scope(s): ${needed}`,
          pointer: "/settings/event_subscriptions",
          related_component: "oauth",
        },
      ];
    });
  }
  app.post("/mock/slack.com/api/apps.manifest.create", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    logRequest("slack.com", "POST", "/api/apps.manifest.create", body);
    const manifest = parseManifest(body.manifest);
    if (!manifest) return { ok: false, error: "invalid_manifest" };
    const errors = manifestScopeErrors(manifest);
    if (errors.length > 0) return { ok: false, error: "invalid_manifest", errors };
    const appId = `AEMU${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    return {
      ok: true,
      app_id: appId,
      credentials: {
        client_id: "80230.emulated",
        client_secret: "emu-client-secret",
        verification_token: "emu-verify",
        signing_secret: "emu-signing-secret",
      },
      oauth_authorize_url: `${req.headers.host ? `http://${req.headers.host}` : "https://slack.com"}/mock/slack.com/oauth/v2/authorize?client_id=80230.emulated&scope=chat:write`,
    };
  });
  app.post("/mock/slack.com/api/apps.manifest.update", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    logRequest("slack.com", "POST", "/api/apps.manifest.update", body);
    const manifest = parseManifest(body.manifest);
    if (!manifest) return { ok: false, error: "invalid_manifest" };
    const errors = manifestScopeErrors(manifest);
    if (errors.length > 0) return { ok: false, error: "invalid_manifest", errors };
    return { ok: true };
  });
  app.post("/mock/slack.com/api/apps.manifest.validate", async (req) => {
    logRequest("slack.com", "POST", "/api/apps.manifest.validate", req.body ?? null);
    return { ok: true };
  });
  app.post("/mock/slack.com/api/apps.manifest.export", async (req) => {
    logRequest("slack.com", "POST", "/api/apps.manifest.export", req.body ?? null);
    return {
      ok: true,
      manifest: {
        display_information: { name: "Emu App" },
        oauth_config: { scopes: { bot: [] } },
        settings: { event_subscriptions: { bot_events: [] } },
      },
    };
  });
  app.post("/mock/slack.com/api/tooling.tokens.rotate", async (req) => {
    logRequest("slack.com", "POST", "/api/tooling.tokens.rotate", req.body ?? null);
    return { ok: true, token: "xoxe.xoxp-rotated", refresh_token: "xoxe-rotated" };
  });
  app.post("/mock/slack.com/api/bots.info", async (req) => {
    logRequest("slack.com", "POST", "/api/bots.info", req.body ?? null);
    return { ok: true, bot: { id: "B0EMU", app_id: "A0EMU", name: "rabble-bot" } };
  });
  app.post("/mock/slack.com/api/assistant.threads.setStatus", async (req) => {
    logRequest("slack.com", "POST", "/api/assistant.threads.setStatus", req.body ?? null);
    return { ok: true };
  });
  app.post("/mock/slack.com/api/oauth.v2.access", async (req) => {
    logRequest("slack.com", "POST", "/api/oauth.v2.access", req.body ?? null);
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code) return { ok: false, error: "invalid_code" };
    return {
      ok: true,
      access_token: "xoxb-emulated-bot",
      token_type: "bot",
      bot_user_id: "U0EMU",
      team: { id: "T0EMU", name: "Acme Corp" },
    };
  });
}
