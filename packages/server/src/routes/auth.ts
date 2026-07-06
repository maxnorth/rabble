import type { FastifyInstance } from "fastify";
import { loginRequestSchema, setupRequestSchema } from "@rabble/core";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { orgs, teamMembers, teams, users } from "../db/schema.js";
import { recordAudit } from "../audit.js";
import { hashPassword, verifyPassword } from "../crypto.js";
import {
  createAuthSession,
  destroyAuthSession,
  requireUser,
} from "../auth.js";
import { serializeUser } from "../serialize.js";

async function ownerExists(): Promise<boolean> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  return (row?.count ?? 0) > 0;
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/api/setup", async () => ({ needsSetup: !(await ownerExists()) }));

  // First-boot: create the org and its owner account, then sign in.
  app.post("/api/setup", async (req, reply) => {
    const body = setupRequestSchema.parse(req.body);
    if (await ownerExists()) {
      return reply.code(409).send({ error: "Setup has already been completed" });
    }
    const owner = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(orgs)
        .values({ name: body.orgName })
        .returning();
      const [user] = await tx
        .insert(users)
        .values({
          orgId: org!.id,
          email: body.email.toLowerCase(),
          name: body.name,
          role: "owner",
          passwordHash: hashPassword(body.password),
        })
        .returning();
      // The pinned org-wide team; every user is automatically a member.
      const [everyone] = await tx
        .insert(teams)
        .values({
          orgId: org!.id,
          slug: "everyone",
          name: "Everyone",
          isEveryone: true,
        })
        .returning();
      await tx
        .insert(teamMembers)
        .values({ teamId: everyone!.id, userId: user!.id });
      return user!;
    });
    await createAuthSession(reply, owner.id);
    await recordAudit({
      orgId: owner.orgId,
      actorUserId: owner.id,
      action: "org.setup",
      targetType: "org",
      targetId: owner.orgId,
      summary: `Organization "${body.orgName}" created with owner ${body.name}`,
    });
    return { user: serializeUser(owner) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = loginRequestSchema.parse(req.body);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, body.email.toLowerCase()))
      .limit(1);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    await createAuthSession(reply, user.id);
    return { user: serializeUser(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await destroyAuthSession(req, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireUser }, async (req) => ({
    user: serializeUser(req.user!),
  }));
}
