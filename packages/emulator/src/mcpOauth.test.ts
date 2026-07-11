import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildEmulator } from "./index.js";

// Drive the whole MCP-OAuth handshake the Rabble server performs, against the
// mounted emulator via app.inject: discovery → DCR → authorize → PKCE token
// exchange → authenticated MCP → refresh.

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildEmulator();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const MCP = "/mock/oauthmcp/mcp";

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("mcpOauth", () => {
  it("runs discovery → DCR → authorize → token → authenticated MCP → refresh", async () => {
    // 1. Unauthenticated initialize → 401 + WWW-Authenticate pointing at the
    //    protected-resource metadata.
    const noAuth = await app.inject({
      method: "POST",
      url: MCP,
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(noAuth.statusCode).toBe(401);
    const wwwAuth = noAuth.headers["www-authenticate"] as string;
    expect(wwwAuth).toMatch(/^Bearer resource_metadata="/);
    const resourceMetaUrl = wwwAuth.match(/resource_metadata="([^"]+)"/)![1];
    const resourceMetaPath = new URL(resourceMetaUrl).pathname;

    // 2. Protected-resource metadata (RFC 9728).
    const prm = await app.inject({ method: "GET", url: resourceMetaPath });
    expect(prm.statusCode).toBe(200);
    const prmBody = prm.json();
    expect(prmBody.scopes_supported).toEqual(["tools"]);
    const issuerOrigin = prmBody.authorization_servers[0] as string;

    // 3. Authorization-server metadata (RFC 8414) at issuer + well-known.
    const asMeta = await app.inject({
      method: "GET",
      url: new URL(`${issuerOrigin}/.well-known/oauth-authorization-server`)
        .pathname,
    });
    expect(asMeta.statusCode).toBe(200);
    const as = asMeta.json();
    expect(as.authorization_endpoint).toBeTruthy();
    expect(as.token_endpoint).toBeTruthy();
    expect(as.registration_endpoint).toBeTruthy();
    const authorizePath = new URL(as.authorization_endpoint).pathname;
    const tokenPath = new URL(as.token_endpoint).pathname;
    const registerPath = new URL(as.registration_endpoint).pathname;

    // 4. Dynamic Client Registration (RFC 7591) → client_id.
    const redirectUri = "https://rabble.test/oauth/callback";
    const reg = await app.inject({
      method: "POST",
      url: registerPath,
      payload: {
        client_name: "Rabble",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    const clientId = reg.json().client_id as string;
    expect(clientId).toBeTruthy();

    // 5. Authorize (auto-approve) → 302 with code + state.
    const { verifier, challenge } = pkcePair();
    const state = "xyz-state";
    const authorize = await app.inject({
      method: "GET",
      url: authorizePath,
      query: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "tools",
      },
    });
    expect(authorize.statusCode).toBe(302);
    const location = new URL(authorize.headers.location as string);
    expect(location.searchParams.get("state")).toBe(state);
    const code = location.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 6. Token exchange with the matching PKCE verifier → tokens.
    const tokenRes = await app.inject({
      method: "POST",
      url: tokenPath,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: clientId,
      }).toString(),
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokens = tokenRes.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.expires_in).toBeGreaterThan(0);

    // 7. Authenticated MCP initialize → 200 + session id.
    const init = await app.inject({
      method: "POST",
      url: MCP,
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(init.statusCode).toBe(200);
    const sessionId = init.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();
    expect(init.json().result.protocolVersion).toBe("2025-03-26");

    // 8. tools/list → the seeded incident tools.
    const list = await app.inject({
      method: "POST",
      url: MCP,
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "mcp-session-id": sessionId,
      },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(list.statusCode).toBe(200);
    const toolNames = list.json().result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(["list_incidents", "create_incident"]);

    // 9. Refresh → a new access token.
    const refresh = await app.inject({
      method: "POST",
      url: tokenPath,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refresh.statusCode).toBe(200);
    const refreshed = refresh.json();
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    // The rotated-out refresh token is no longer valid.
    const stale = await app.inject({
      method: "POST",
      url: tokenPath,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(stale.statusCode).toBe(400);
  });

  it("rejects a token exchange whose PKCE verifier doesn't match", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/mock/oauthmcp/register",
      payload: { client_name: "Rabble", redirect_uris: ["https://rabble.test/cb"] },
    });
    const clientId = reg.json().client_id as string;
    const { challenge } = pkcePair();
    const authorize = await app.inject({
      method: "GET",
      url: "/mock/oauthmcp/authorize",
      query: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://rabble.test/cb",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
    });
    const code = new URL(authorize.headers.location as string).searchParams.get(
      "code",
    )!;
    const bad = await app.inject({
      method: "POST",
      url: "/mock/oauthmcp/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://rabble.test/cb",
        code_verifier: "wrong-verifier-does-not-hash-to-challenge",
        client_id: clientId,
      }).toString(),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("401s an MCP call with an unknown bearer", async () => {
    const res = await app.inject({
      method: "POST",
      url: MCP,
      headers: { authorization: "Bearer totally-made-up" },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/Bearer resource_metadata=/);
  });
});
