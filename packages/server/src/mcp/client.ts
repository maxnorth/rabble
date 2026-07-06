/**
 * Minimal MCP client: JSON-RPC 2.0 over HTTP POST (the non-streaming shape
 * of MCP's streamable HTTP transport). Covers the slice Rabble uses —
 * initialize, tools/list, tools/call.
 */
import type { McpToolInfo } from "@rabblehq/core";

let rpcId = 0;

async function rpc<T>(
  url: string,
  method: string,
  params: Record<string, unknown>,
  token?: string | null,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) {
    throw new Error(`MCP server responded ${res.status}`);
  }
  const body = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error) throw new Error(`MCP error: ${body.error.message}`);
  return body.result as T;
}

export async function mcpListTools(
  url: string,
  token?: string | null,
): Promise<McpToolInfo[]> {
  await rpc(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "rabble", version: "0.1.0" },
  }, token);
  const result = await rpc<{ tools: McpToolInfo[] }>(url, "tools/list", {}, token);
  return result.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }));
}

export async function mcpCallTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
  token?: string | null,
): Promise<string> {
  const result = await rpc<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>(url, "tools/call", { name, arguments: args }, token);
  const text = (result.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
  if (result.isError) throw new Error(text || "Tool call failed");
  return text;
}
