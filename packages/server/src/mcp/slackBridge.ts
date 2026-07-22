/**
 * Rabble-hosted Slack MCP bridge. Slack's hosted MCP server
 * (mcp.slack.com) only accepts its own OAuth — a workspace bot token is
 * rejected — so a Connection's credential can never satisfy it. This
 * endpoint closes that gap: Rabble itself serves an MCP server at
 * /mcp/slack/:connectionId whose tools are implemented against the Slack
 * Web API using that connection's bot token. Registering it as a
 * connection-mode MCP server makes the whole generic machinery work —
 * tool discovery, attachment, governed calls — with the workspace bot as
 * the acting identity.
 *
 * Auth: the caller must present the connection's own bot token as the
 * bearer credential (which is exactly what the runtime borrows via
 * usableServiceCredential). No cookie session — this is an MCP endpoint,
 * not a browser API.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { slackClient } from "../surfaces/slackClient.js";

const TOOLS = [
  {
    name: "post_message",
    description: "Post a message to a Slack channel as the workspace bot",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID (or name for public channels)" },
        text: { type: "string", description: "Message text (mrkdwn)" },
        thread_ts: { type: "string", description: "Reply in this thread (optional)" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "list_channels",
    description: "List channels in the workspace",
    inputSchema: { type: "object", properties: {} },
  },
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  baseUrl: string | null,
  token: string,
): Promise<string> {
  const slack = slackClient(baseUrl, token);
  if (name === "post_message") {
    const res = await slack.chat.postMessage({
      channel: String(args.channel ?? ""),
      text: String(args.text ?? ""),
      ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}),
    });
    return JSON.stringify({ ok: true, channel: res.channel, ts: res.ts });
  }
  if (name === "list_channels") {
    const res = await slack.conversations.list({ limit: 100 });
    return JSON.stringify({
      channels: (res.channels ?? []).map((c) => ({ id: c.id, name: c.name })),
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function slackBridgeRoutes(app: FastifyInstance) {
  app.post("/mcp/slack/:connectionId", async (req, reply) => {
    const { connectionId } = req.params as { connectionId: string };
    const rpc = req.body as JsonRpcRequest;
    const rpcError = (code: number, message: string, httpStatus = 200) =>
      reply
        .code(httpStatus)
        .send({ jsonrpc: "2.0", id: rpc?.id ?? null, error: { code, message } });

    const [conn] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    if (!conn?.encryptedToken) {
      return rpcError(-32001, "This bridge's connection no longer holds a credential", 404);
    }
    const token = decryptSecret(conn.encryptedToken);
    const presented = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (presented !== token) {
      return rpcError(-32002, "Invalid credential for this bridge", 401);
    }

    const respond = (result: unknown) =>
      reply.send({ jsonrpc: "2.0", id: rpc.id ?? null, result });

    switch (rpc.method) {
      case "initialize":
        return respond({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: `rabble-slack-bridge (${conn.name})`, version: "1.0.0" },
        });
      case "notifications/initialized":
        return reply.code(202).send();
      case "tools/list":
        return respond({ tools: TOOLS });
      case "tools/call": {
        const params = rpc.params as {
          name: string;
          arguments?: Record<string, unknown>;
        };
        try {
          const text = await runTool(
            params.name,
            params.arguments ?? {},
            conn.baseUrl,
            token,
          );
          return respond({ content: [{ type: "text", text }], isError: false });
        } catch (err) {
          return respond({
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : "Slack call failed",
              },
            ],
            isError: true,
          });
        }
      }
      default:
        return rpcError(-32601, `Method not found: ${rpc.method}`);
    }
  });
}
