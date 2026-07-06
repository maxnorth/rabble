/**
 * MCP server fake: JSON-RPC 2.0 over HTTP POST (the non-streaming variant of
 * MCP's streamable HTTP transport). Supports any number of named servers at
 * /mock/mcp/:serverKey — tools are configured via the admin API or seeded
 * defaults, and every tools/call is logged for assertions.
 */
import type { FastifyInstance } from "fastify";
import { logRequest, state } from "./state.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export function mountMcp(app: FastifyInstance): void {
  app.post("/mock/mcp/:serverKey", async (req, reply) => {
    const { serverKey } = req.params as { serverKey: string };
    const rpc = req.body as JsonRpcRequest;
    logRequest(`mcp/${serverKey}`, "POST", rpc.method, rpc.params ?? null);

    const tools = state.mcpServers.get(serverKey);
    if (!tools) {
      return reply.code(404).send({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32001, message: `Unknown MCP server "${serverKey}"` },
      });
    }

    const respond = (result: unknown) =>
      reply.send({ jsonrpc: "2.0", id: rpc.id ?? null, result });

    switch (rpc.method) {
      case "initialize":
        return respond({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: `emulated-${serverKey}`, version: "1.0.0" },
        });
      case "notifications/initialized":
        return reply.code(202).send();
      case "tools/list":
        return respond({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
        });
      case "tools/call": {
        const params = rpc.params as { name: string; arguments?: Record<string, unknown> };
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) {
          return respond({
            content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
            isError: true,
          });
        }
        const text = tool.result ?? JSON.stringify({ echo: params.arguments ?? {} });
        return respond({ content: [{ type: "text", text }], isError: false });
      }
      default:
        return reply.send({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        });
    }
  });
}
