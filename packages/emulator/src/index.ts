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
 */
import Fastify from "fastify";
import { mountAnthropic, mountOpenAi } from "./llm.js";
import { mountMcp } from "./mcp.js";
import { mountSlack } from "./slack.js";
import { reset, state, type McpToolDef, type ScriptedReply } from "./state.js";

export async function buildEmulator() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, emulator: true }));

  // --- fakes ---
  mountOpenAi(app);
  mountAnthropic(app);
  mountMcp(app);
  mountSlack(app);

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
