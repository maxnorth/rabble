import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./db/client.js";
import { authSessions, users } from "./db/schema.js";
import { hashAuthToken, newAuthToken } from "./crypto.js";
import { env } from "./env.js";

export const SESSION_COOKIE = "rabble_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type AuthedUser = typeof users.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser | null;
    /** Set when the request authenticated with an API key. */
    apiKeyScope?: "read" | "write" | "admin";
  }
}

/** Paths only admin-scope keys (or cookie sessions) may touch. */
const ADMIN_ONLY_PREFIXES = [
  "/api/api-keys",
  "/api/audit",
  "/api/org",
  "/api/members",
];

/** Enforce API-key scope ceilings; cookie sessions pass through untouched. */
export function enforceApiKeyScope(
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const scope = req.apiKeyScope;
  if (!scope) return;
  if (scope === "read" && req.method !== "GET") {
    reply.code(403).send({ error: "This API key is read-only" });
    return;
  }
  if (
    scope !== "admin" &&
    ADMIN_ONLY_PREFIXES.some((p) => req.url.startsWith(p))
  ) {
    reply.code(403).send({ error: "This API key can't access admin surfaces" });
  }
}

export async function resolveUser(req: FastifyRequest): Promise<AuthedUser | null> {
  // Programmatic access: Authorization: Bearer rbl_<prefix>_<secret>
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer rbl_")) {
    const token = header.slice("Bearer ".length);
    const { apiKeys } = await import("./db/schema.js");
    const [row] = await db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.createdBy, users.id))
      .where(eq(apiKeys.keyHash, hashAuthToken(token)))
      .limit(1);
    if (!row || row.key.revokedAt || !row.user.active) return null;
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.key.id))
      .catch(() => {});
    req.apiKeyScope = row.key.scope;
    // The key acts as its creator, capped by scope (enforced globally).
    return row.user;
  }

  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const rows = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        eq(authSessions.tokenHash, hashAuthToken(token)),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const user = rows[0]?.user ?? null;
  return user?.active ? user : null;
}

export async function createAuthSession(
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  const { token, tokenHash } = newAuthToken();
  await db.insert(authSessions).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroyAuthSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    await db
      .delete(authSessions)
      .where(eq(authSessions.tokenHash, hashAuthToken(token)));
  }
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** preHandler for routes that require a signed-in user. */
export async function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.user) {
    reply.code(401).send({ error: "Not authenticated" });
  }
}
