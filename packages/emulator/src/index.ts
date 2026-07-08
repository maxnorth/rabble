/**
 * The Rabble emulator: one process hosting fakes of every external service
 * the platform talks to, each mounted under the host it stands in for
 * (https://api.anthropic.com/... -> /mock/api.anthropic.com/...). The real
 * application code runs unchanged — only configured base URLs differ.
 *
 * Admin endpoints let tests (or agents) script behavior and inspect what
 * happened:
 *   POST /admin/reset                  wipe state, re-seed defaults
 *   GET  /admin/requests?host=...      outbound calls the fakes received
 *   POST /admin/llm/enqueue            queue the next LLM reply
 *                                      {type:"text",text} |
 *                                      {type:"tool_call",toolName,toolArgs}
 *   PUT  /admin/mcp/:serverKey         set an MCP server's tools
 *                                      {tools:[{name,description,inputSchema?,result?}]}
 *   POST /admin/slack/socket-event     push a Socket Mode event envelope
 *                                      {event:{type:"message",...}} to
 *                                      connected sockets
 *   POST /admin/slack/socket-interaction  push an interactivity envelope
 *   GET  /admin/slack/socket           connected socket count + sent/ack log
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { mountAnthropic, mountOpenAi } from "./llm.js";
import { mountMcp } from "./mcp.js";
import { mountSlack, pushSlackSocketEnvelope } from "./slack.js";
import { mountGithub } from "./github.js";
import { logRequest, reset, state, type McpToolDef, type ScriptedReply } from "./state.js";

export async function buildEmulator() {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  // Slack clients POST form-encoded (often empty) bodies; accept them like
  // the real API instead of 415ing.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.get("/health", async () => ({ ok: true, emulator: true }));

  // --- fakes ---
  mountOpenAi(app);
  mountAnthropic(app);
  mountMcp(app);
  mountSlack(app);
  mountGithub(app);

  // A generic fetchable web page, standing in for the open internet, so the
  // governed `fetch_url` tool can be exercised against a real host. The
  // response echoes the path; `/redirect?to=...` 302s so redirect-following
  // (and its per-hop allowlist re-check) can be tested too.
  app.get("/mock/web/redirect", async (req, reply) => {
    const { to } = req.query as { to?: string };
    logRequest("web", "GET", "/redirect", { to: to ?? null });
    reply.header("location", to ?? "/mock/web/hello").code(302);
    return "";
  });
  app.get("/mock/web/*", async (req) => {
    const path = (req.params as Record<string, string>)["*"] ?? "";
    logRequest("web", "GET", `/${path}`, null);
    return `Hello from the emulated web (path: ${path}).`;
  });

  // --- admin ---
  app.post("/admin/reset", async () => {
    reset();
    return { ok: true };
  });

  app.get("/admin/requests", async (req) => {
    const { host } = req.query as { host?: string };
    const requests = host
      ? state.requests.filter((r) => r.host.includes(host))
      : state.requests;
    return { requests };
  });

  app.post("/admin/llm/enqueue", async (req) => {
    const replies = (
      Array.isArray(req.body) ? req.body : [req.body]
    ) as ScriptedReply[];
    state.llmQueue.push(...replies);
    return { ok: true, queued: state.llmQueue.length };
  });

  app.put("/admin/slack", async (req) => {
    const { users, channels } = (req.body ?? {}) as {
      users?: Record<string, string>;
      channels?: Record<string, string>;
    };
    for (const [id, email] of Object.entries(users ?? {})) {
      state.slackUsers.set(id, email);
    }
    for (const [id, name] of Object.entries(channels ?? {})) {
      state.slackChannels.set(id, name);
    }
    return { ok: true };
  });

  app.put("/admin/mcp/:serverKey", async (req) => {
    const { serverKey } = req.params as { serverKey: string };
    const { tools } = req.body as { tools: McpToolDef[] };
    state.mcpServers.set(serverKey, tools);
    return { ok: true };
  });

  // --- Slack Socket Mode scripting ---
  // Wraps a bare Slack event in the envelopes the real socket would carry:
  // an event_callback payload inside an events_api Socket Mode envelope.
  app.post("/admin/slack/socket-event", async (req) => {
    const { event, eventId, envelopeId, appToken } = (req.body ?? {}) as {
      event?: Record<string, unknown>;
      eventId?: string;
      envelopeId?: string;
      appToken?: string;
    };
    if (!event) return { ok: false, error: "event required" };
    const envelope = {
      envelope_id: envelopeId ?? randomUUID(),
      type: "events_api",
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
      payload: {
        type: "event_callback",
        event_id: eventId ?? `EvSock${randomUUID().slice(0, 8)}`,
        team_id: "T0EMU",
        event,
      },
    };
    const delivered = pushSlackSocketEnvelope(envelope, appToken);
    return { ok: true, delivered, envelopeId: envelope.envelope_id };
  });

  app.post("/admin/slack/socket-interaction", async (req) => {
    const { payload, envelopeId, appToken } = (req.body ?? {}) as {
      payload?: Record<string, unknown>;
      envelopeId?: string;
      appToken?: string;
    };
    if (!payload) return { ok: false, error: "payload required" };
    const envelope = {
      envelope_id: envelopeId ?? randomUUID(),
      type: "interactive",
      accepts_response_payload: false,
      payload,
    };
    const delivered = pushSlackSocketEnvelope(envelope, appToken);
    return { ok: true, delivered, envelopeId: envelope.envelope_id };
  });

  app.get("/admin/slack/socket", async () => ({
    connections: state.slackSockets.size,
    apps: [...new Set(state.slackSocketApp.values())],
    log: state.slackSocketLog,
  }));

  return app;
}

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.EMULATOR_PORT ?? 4100);
  const app = await buildEmulator();
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(`rabble emulator on :${port}`);
  });
}
