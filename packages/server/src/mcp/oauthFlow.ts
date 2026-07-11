/**
 * Server-side glue between stored OAuth config and the per-user token flow:
 * reconstruct a server's endpoints+client, persist tokens with expiry, and
 * refresh an expired access token. Shared by the connect routes and runtime.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { mcpServers, userMcpCredentials } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import {
  refreshTokens,
  type OAuthClient,
  type OAuthEndpoints,
  type OAuthTokens,
} from "./oauth.js";

type ServerRow = typeof mcpServers.$inferSelect;

/** Endpoints + client for a server that was registered with OAuth. */
export function serverOAuth(
  server: ServerRow,
): { endpoints: OAuthEndpoints; client: OAuthClient } | null {
  if (!server.oauthConfig) return null;
  const cfg = server.oauthConfig as OAuthEndpoints & { clientId: string };
  return {
    endpoints: {
      authorizationEndpoint: cfg.authorizationEndpoint,
      tokenEndpoint: cfg.tokenEndpoint,
      registrationEndpoint: cfg.registrationEndpoint,
      scopes: cfg.scopes,
    },
    client: {
      clientId: cfg.clientId,
      clientSecret: server.encryptedOauthClientSecret
        ? decryptSecret(server.encryptedOauthClientSecret)
        : undefined,
    },
  };
}

/** Upsert a user's tokens for a server, translating expires_in to an absolute
 * instant (60s of slack so we refresh before the server rejects). */
export async function storeUserTokens(
  userId: string,
  serverId: string,
  tokens: OAuthTokens,
  now: number,
): Promise<void> {
  const expiresAt = tokens.expiresIn
    ? new Date(now + (tokens.expiresIn - 60) * 1000)
    : null;
  const values = {
    userId,
    serverId,
    encryptedToken: encryptSecret(tokens.accessToken),
    encryptedRefreshToken: tokens.refreshToken
      ? encryptSecret(tokens.refreshToken)
      : null,
    expiresAt,
  };
  await db
    .insert(userMcpCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: [userMcpCredentials.userId, userMcpCredentials.serverId],
      set: {
        encryptedToken: values.encryptedToken,
        encryptedRefreshToken: values.encryptedRefreshToken,
        expiresAt: values.expiresAt,
      },
    });
}

/** Store an OAuth grant as the shared org credential. A donorUserId stamps
 * who provided it (the donation); a refresh omits it, preserving the donor. */
export async function storeOrgTokens(
  serverId: string,
  tokens: OAuthTokens,
  now: number,
  donorUserId?: string,
): Promise<void> {
  const expiresAt = tokens.expiresIn
    ? new Date(now + (tokens.expiresIn - 60) * 1000)
    : null;
  await db
    .update(mcpServers)
    .set({
      encryptedToken: encryptSecret(tokens.accessToken),
      encryptedOrgRefreshToken: tokens.refreshToken
        ? encryptSecret(tokens.refreshToken)
        : null,
      orgTokenExpiresAt: expiresAt,
      ...(donorUserId ? { donatedByUserId: donorUserId } : {}),
    })
    .where(eq(mcpServers.id, serverId));
}

/**
 * The shared org credential for a server, refreshing an expired OAuth-donated
 * token in place. Returns null when the server has no org credential at all.
 * A pasted org token (no oauth config) is used as-is.
 */
export async function usableOrgAccessToken(
  server: ServerRow,
  now: number,
): Promise<string | null> {
  if (!server.encryptedToken) return null;
  const expired =
    server.orgTokenExpiresAt != null && server.orgTokenExpiresAt.getTime() <= now;
  if (expired && server.encryptedOrgRefreshToken) {
    const oauth = serverOAuth(server);
    if (oauth) {
      const tokens = await refreshTokens({
        endpoints: oauth.endpoints,
        client: oauth.client,
        refreshToken: decryptSecret(server.encryptedOrgRefreshToken),
      });
      await storeOrgTokens(server.id, tokens, now);
      return tokens.accessToken;
    }
  }
  return decryptSecret(server.encryptedToken);
}

/**
 * A usable access token for (user, server): the stored one, refreshed first
 * if it has expired and a refresh token is on file. Returns null when the
 * user has no credential at all. Non-OAuth (pasted-token) creds never expire.
 */
export async function usableAccessToken(
  server: ServerRow,
  userId: string,
  now: number,
): Promise<string | null> {
  const [cred] = await db
    .select()
    .from(userMcpCredentials)
    .where(
      and(
        eq(userMcpCredentials.userId, userId),
        eq(userMcpCredentials.serverId, server.id),
      ),
    )
    .limit(1);
  if (!cred) return null;

  const expired = cred.expiresAt != null && cred.expiresAt.getTime() <= now;
  if (expired && cred.encryptedRefreshToken) {
    const oauth = serverOAuth(server);
    if (oauth) {
      const tokens = await refreshTokens({
        endpoints: oauth.endpoints,
        client: oauth.client,
        refreshToken: decryptSecret(cred.encryptedRefreshToken),
      });
      await storeUserTokens(userId, server.id, tokens, now);
      return tokens.accessToken;
    }
  }
  return decryptSecret(cred.encryptedToken);
}
