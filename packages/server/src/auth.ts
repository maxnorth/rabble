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
  }
}

export async function resolveUser(req: FastifyRequest): Promise<AuthedUser | null> {
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
  return rows[0]?.user ?? null;
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
    secure: env.nodeEnv === "production",
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
