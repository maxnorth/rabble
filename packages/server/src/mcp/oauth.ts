/**
 * The MCP OAuth slice Rabble needs: given a 401 from an MCP server, discover
 * its authorization server (RFC 9728 → RFC 8414), dynamically register a
 * client (RFC 7591), then run authorization-code + PKCE and refresh. Only the
 * pieces the runtime uses — no client-credentials, no implicit.
 */
import { createHash, randomBytes } from "node:crypto";

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires, if the server reports it. */
  expiresIn?: number;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Resolve the authorization server's endpoints from the resource-metadata URL
 * carried on the 401. Follows RFC 9728 (protected resource → auth servers)
 * then RFC 8414 (auth-server metadata).
 */
export async function discoverOAuth(
  resourceMetadataUrl: string,
): Promise<OAuthEndpoints> {
  const resource = await getJson(resourceMetadataUrl);
  const servers = resource.authorization_servers as string[] | undefined;
  const issuer = servers?.[0];
  if (!issuer) throw new Error("No authorization server advertised by the resource");

  // RFC 8414. Implementations disagree on where the well-known sits when the
  // issuer carries a path: some append it to the issuer path (the common MCP
  // form), some insert it at the origin root. Try both and take the first
  // that answers with the required endpoints.
  const trimmed = issuer.replace(/\/+$/, "");
  const candidates = [
    `${trimmed}/.well-known/oauth-authorization-server`,
    new URL("/.well-known/oauth-authorization-server", issuer).toString(),
  ];
  let meta: Record<string, unknown> | null = null;
  for (const url of candidates) {
    try {
      const m = await getJson(url);
      if (m.authorization_endpoint && m.token_endpoint) {
        meta = m;
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  if (!meta) {
    throw new Error("Authorization server metadata is missing or unreachable");
  }
  const authorizationEndpoint = meta.authorization_endpoint as string | undefined;
  const tokenEndpoint = meta.token_endpoint as string | undefined;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("Authorization server metadata is missing required endpoints");
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: meta.registration_endpoint as string | undefined,
    scopes: (resource.scopes_supported as string[] | undefined) ?? undefined,
  };
}

/** Dynamic Client Registration (RFC 7591). */
export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<OAuthClient> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Rabble",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`Client registration responded ${res.status}`);
  const body = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!body.client_id) throw new Error("Client registration returned no client_id");
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

const base64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE verifier/challenge pair (S256). */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Build the authorize URL the user is sent to. */
export function authorizeUrl(input: {
  endpoints: OAuthEndpoints;
  client: OAuthClient;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const u = new URL(input.endpoints.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.client.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (input.endpoints.scopes?.length) {
    u.searchParams.set("scope", input.endpoints.scopes.join(" "));
  }
  return u.toString();
}

async function tokenRequest(
  tokenEndpoint: string,
  client: OAuthClient,
  form: Record<string, string>,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token endpoint responded ${res.status}`);
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) throw new Error("Token endpoint returned no access_token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/** Exchange an authorization code for tokens (with the PKCE verifier). */
export function exchangeCode(input: {
  endpoints: OAuthEndpoints;
  client: OAuthClient;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<OAuthTokens> {
  return tokenRequest(input.endpoints.tokenEndpoint, input.client, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
}

/** Trade a refresh token for a fresh access token. */
export function refreshTokens(input: {
  endpoints: OAuthEndpoints;
  client: OAuthClient;
  refreshToken: string;
}): Promise<OAuthTokens> {
  return tokenRequest(input.endpoints.tokenEndpoint, input.client, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
}
