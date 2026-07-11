/**
 * OAuth-protected MCP server fake — the counterpart to the open MCP fake in
 * mcp.ts, used to exercise Rabble's MCP-OAuth connect flow end to end. It
 * bundles everything the flow touches under one host prefix (/mock/oauthmcp):
 * the JSON-RPC MCP endpoint that 401s until it sees a bearer, plus the OAuth
 * discovery + Dynamic Client Registration + authorize + token machinery
 * (RFC 9728 / RFC 8414 / RFC 7591 / PKCE S256) needed to obtain that bearer.
 *
 * Everything is in-memory and requires no /admin setup: discovery, DCR,
 * authorize, and token all work from a cold start. The authorize endpoint
 * auto-approves (no consent UI) so the browser hop is a plain redirect.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { logRequest, type McpToolDef } from "./state.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Authorization code issued by /authorize, redeemable once at /token. */
interface PendingCode {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
}

// All emulator-lifetime, in-memory (matches mcp.ts's mcpSessions Set).
const clients = new Map<string, { redirectUris: string[] }>();
const codes = new Map<string, PendingCode>();
const accessTokens = new Map<string, { expiresAt: number }>();
const refreshTokens = new Set<string>();
const mcpSessions = new Set<string>();

const ACCESS_TTL_SECONDS = 3600;

// The tools this server exposes once authenticated (an incident-management
// slice); inline here since the OAuth server isn't in state.mcpServers.
const TOOLS: McpToolDef[] = [
  {
    name: "list_incidents",
    description: "List open incidents",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" } },
    },
    result: JSON.stringify({
      incidents: [
        { id: "INC-1", title: "Checkout latency", status: "open" },
        { id: "INC-2", title: "Elevated 5xx", status: "acknowledged" },
      ],
    }),
  },
  {
    name: "create_incident",
    description: "Open a new incident",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, severity: { type: "string" } },
      required: ["title"],
    },
    result: JSON.stringify({ incident: { id: "INC-99", status: "open" } }),
  },
];

/** Origin the emulator is reachable at, from the request Host (see slack.ts). */
function baseUrl(host: string | undefined): string {
  return host ? `http://${host}` : "http://localhost:4100";
}

const PREFIX = "/mock/oauthmcp";

/** Issuer / authorization-server base (RFC 8414 well-known appends to this). */
function issuer(host: string | undefined): string {
  return `${baseUrl(host)}${PREFIX}`;
}

function resourceMetadataUrl(host: string | undefined): string {
  return `${issuer(host)}/.well-known/oauth-protected-resource`;
}

/** The 401 challenge every unauthenticated MCP hit answers with. */
function unauthorized(reply: import("fastify").FastifyReply, host: string | undefined) {
  return reply
    .code(401)
    .header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl(host)}"`,
    )
    .send({ error: "invalid_token" });
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function issueTokens(): {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
} {
  const access = `at_${randomUUID().replace(/-/g, "")}`;
  const refresh = `rt_${randomUUID().replace(/-/g, "")}`;
  accessTokens.set(access, { expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000 });
  refreshTokens.add(refresh);
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "bearer",
    expires_in: ACCESS_TTL_SECONDS,
  };
}

export function mountMcpOauth(app: FastifyInstance): void {
  // --- RFC 9728: protected-resource metadata ---
  app.get(`${PREFIX}/.well-known/oauth-protected-resource`, async (req) => {
    logRequest("oauthmcp", "GET", "/.well-known/oauth-protected-resource", null);
    return {
      resource: `${issuer(req.headers.host)}/mcp`,
      authorization_servers: [issuer(req.headers.host)],
      scopes_supported: ["tools"],
    };
  });

  // --- RFC 8414: authorization-server metadata ---
  app.get(`${PREFIX}/.well-known/oauth-authorization-server`, async (req) => {
    logRequest("oauthmcp", "GET", "/.well-known/oauth-authorization-server", null);
    const iss = issuer(req.headers.host);
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      registration_endpoint: `${iss}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
  });

  // --- RFC 7591: Dynamic Client Registration (public client, no secret) ---
  app.post(`${PREFIX}/register`, async (req, reply) => {
    const body = (req.body ?? {}) as {
      client_name?: string;
      redirect_uris?: string[];
    };
    logRequest("oauthmcp", "POST", "/register", body);
    const clientId = `client_${randomUUID().slice(0, 12)}`;
    clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
    return reply.code(201).send({
      client_id: clientId,
      client_name: body.client_name,
      redirect_uris: body.redirect_uris ?? [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // --- Authorize: auto-approve, mint a one-time code, redirect back ---
  app.get(`${PREFIX}/authorize`, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    logRequest("oauthmcp", "GET", "/authorize", q);
    const redirectUri = q.redirect_uri;
    if (!redirectUri || !q.code_challenge || q.code_challenge_method !== "S256") {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const code = `code_${randomUUID().replace(/-/g, "")}`;
    codes.set(code, {
      codeChallenge: q.code_challenge,
      redirectUri,
      clientId: q.client_id ?? "",
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (q.state !== undefined) target.searchParams.set("state", q.state);
    return reply.code(302).header("location", target.toString()).send();
  });

  // --- Token: authorization_code (PKCE) + refresh_token grants ---
  app.post(`${PREFIX}/token`, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    logRequest("oauthmcp", "POST", "/token", {
      ...body,
      // Never echo the raw verifier/refresh in a way that implies success.
      grant_type: body.grant_type,
    });

    if (body.grant_type === "authorization_code") {
      const code = body.code;
      const pending = code ? codes.get(code) : undefined;
      if (!code || !pending) {
        return reply.code(400).send({ error: "invalid_grant" });
      }
      if (
        body.redirect_uri !== pending.redirectUri ||
        !body.code_verifier ||
        pkceS256(body.code_verifier) !== pending.codeChallenge
      ) {
        return reply.code(400).send({ error: "invalid_grant" });
      }
      codes.delete(code); // one-time
      return reply.send(issueTokens());
    }

    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token || !refreshTokens.has(body.refresh_token)) {
        return reply.code(400).send({ error: "invalid_grant" });
      }
      refreshTokens.delete(body.refresh_token); // rotate
      return reply.send(issueTokens());
    }

    return reply.code(400).send({ error: "unsupported_grant_type" });
  });

  // --- The MCP endpoint itself: 401 without a live bearer, else serve ---
  app.post(`${PREFIX}/mcp`, async (req, reply) => {
    const rpc = req.body as JsonRpcRequest;
    const bearer =
      String(req.headers.authorization ?? "").replace(/^Bearer /, "") || null;
    logRequest("mcp/oauthmcp", "POST", rpc.method, {
      ...(rpc.params ?? {}),
      auth: bearer,
    });

    const token = bearer ? accessTokens.get(bearer) : undefined;
    if (!token || token.expiresAt <= Date.now()) {
      if (token) accessTokens.delete(bearer!);
      return unauthorized(reply, req.headers.host);
    }

    const respond = (result: unknown) =>
      reply.send({ jsonrpc: "2.0", id: rpc.id ?? null, result });

    if (rpc.method !== "initialize") {
      const sessionId = String(req.headers["mcp-session-id"] ?? "");
      if (!mcpSessions.has(sessionId)) {
        return reply.code(400).send("Invalid session ID");
      }
    }

    switch (rpc.method) {
      case "initialize": {
        const sessionId = `mcp-session-${Math.random().toString(36).slice(2, 10)}`;
        mcpSessions.add(sessionId);
        reply.header("mcp-session-id", sessionId);
        return respond({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "emulated-oauthmcp", version: "1.0.0" },
        });
      }
      case "notifications/initialized":
        return reply.code(202).send();
      case "tools/list":
        return respond({
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
        });
      case "tools/call": {
        const params = rpc.params as { name: string; arguments?: Record<string, unknown> };
        const tool = TOOLS.find((t) => t.name === params.name);
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
