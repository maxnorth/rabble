/**
 * Admin surfaces: connections, API keys, audit log, org settings & members.
 * All mutations require org admin/owner and are audit-recorded.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createApiKeySchema,
  createConnectionSchema,
  type ConnectionRole,
} from "@rabble/core";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db/client.js";
import {
  apiKeys,
  auditEvents,
  connections,
  orgs,
  teamMembers,
  teams,
  users,
} from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";
import { encryptSecret, hashAuthToken, hashPassword } from "../crypto.js";

async function requireOrgAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "Not authenticated" });
  if (req.user.role !== "owner" && req.user.role !== "admin") {
    return reply.code(403).send({ error: "Org admin access required" });
  }
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  // --- Connections ---

  app.get("/api/connections", async (req) => {
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.orgId, req.user!.orgId))
      .orderBy(connections.name);
    return {
      connections: rows.map((c) => ({
        id: c.id,
        orgId: c.orgId,
        vendor: c.vendor,
        name: c.name,
        roles: (c.roles ?? []) as ConnectionRole[],
        baseUrl: c.baseUrl,
        hasToken: c.encryptedToken !== null,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });

  app.post(
    "/api/connections",
    { preHandler: requireOrgAdmin },
    async (req, reply) => {
      const body = createConnectionSchema.parse(req.body);

      // Verify reachability the way the vendor's API expects (Slack today;
      // other vendors are stored but not yet actively verified).
      let status: "connected" | "needs-auth" = "connected";
      if (body.vendor === "slack" && body.baseUrl) {
        try {
          const res = await fetch(`${body.baseUrl.replace(/\/$/, "")}/api/auth.test`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${body.token ?? ""}`,
              "content-type": "application/json",
            },
            body: "{}",
          });
          const data = (await res.json()) as { ok?: boolean };
          if (!data.ok) status = "needs-auth";
        } catch {
          return reply
            .code(422)
            .send({ error: "Couldn't reach the Slack API to verify the connection" });
        }
      } else if (!body.token) {
        status = "needs-auth";
      }

      const [row] = await db
        .insert(connections)
        .values({
          orgId: req.user!.orgId,
          vendor: body.vendor,
          name: body.name,
          roles: body.roles,
          baseUrl: body.baseUrl ?? null,
          encryptedToken: body.token ? encryptSecret(body.token) : null,
          status,
        })
        .returning();
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "connection.add",
        targetType: "connection",
        targetId: row!.id,
        summary: `Added ${body.vendor} connection "${body.name}"`,
      });
      return { connection: { ...row, hasToken: row!.encryptedToken !== null } };
    },
  );

  app.delete(
    "/api/connections/:id",
    { preHandler: requireOrgAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const deleted = await db
        .delete(connections)
        .where(and(eq(connections.id, id), eq(connections.orgId, req.user!.orgId)))
        .returning({ name: connections.name });
      if (deleted.length === 0) {
        return reply.code(404).send({ error: "Connection not found" });
      }
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "connection.remove",
        targetType: "connection",
        targetId: id,
        summary: `Removed connection "${deleted[0]!.name}"`,
      });
      return { ok: true };
    },
  );

  // --- API keys ---

  app.get("/api/api-keys", { preHandler: requireOrgAdmin }, async (req) => {
    const rows = await db
      .select({ key: apiKeys, creatorName: users.name })
      .from(apiKeys)
      .leftJoin(users, eq(apiKeys.createdBy, users.id))
      .where(eq(apiKeys.orgId, req.user!.orgId))
      .orderBy(desc(apiKeys.createdAt));
    return {
      keys: rows.map((r) => ({
        id: r.key.id,
        name: r.key.name,
        scope: r.key.scope,
        prefix: r.key.prefix,
        createdByName: r.creatorName,
        lastUsedAt: r.key.lastUsedAt?.toISOString() ?? null,
        revokedAt: r.key.revokedAt?.toISOString() ?? null,
        createdAt: r.key.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/api-keys", { preHandler: requireOrgAdmin }, async (req) => {
    const body = createApiKeySchema.parse(req.body);
    const secret = randomBytes(24).toString("base64url");
    const prefix = `rbl_${randomBytes(4).toString("hex")}`;
    const token = `${prefix}_${secret}`;
    const [row] = await db
      .insert(apiKeys)
      .values({
        orgId: req.user!.orgId,
        name: body.name,
        scope: body.scope,
        prefix,
        keyHash: hashAuthToken(token),
        createdBy: req.user!.id,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "api-key.create",
      targetType: "api-key",
      targetId: row!.id,
      summary: `Created API key "${body.name}" (${body.scope})`,
    });
    // The full token is shown exactly once.
    return { key: { id: row!.id, name: body.name, scope: body.scope, prefix }, token };
  });

  app.post(
    "/api/api-keys/:id/revoke",
    { preHandler: requireOrgAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, id),
            eq(apiKeys.orgId, req.user!.orgId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ name: apiKeys.name });
      if (!row) return reply.code(404).send({ error: "Key not found or already revoked" });
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "api-key.revoke",
        targetType: "api-key",
        targetId: id,
        summary: `Revoked API key "${row.name}"`,
      });
      return { ok: true };
    },
  );

  // --- Audit log ---

  app.get("/api/audit", { preHandler: requireOrgAdmin }, async (req) => {
    const { action, limit } = req.query as { action?: string; limit?: string };
    const conditions = [eq(auditEvents.orgId, req.user!.orgId)];
    if (action) conditions.push(sql`${auditEvents.action} LIKE ${action + "%"}`);
    const rows = await db
      .select({ event: auditEvents, actorName: users.name })
      .from(auditEvents)
      .leftJoin(users, eq(auditEvents.actorUserId, users.id))
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt))
      .limit(Math.min(Number(limit ?? 200), 500));
    return {
      events: rows.map((r) => ({
        id: r.event.id,
        actorName: r.actorName,
        action: r.event.action,
        targetType: r.event.targetType,
        targetId: r.event.targetId,
        summary: r.event.summary,
        metadata: r.event.metadata as Record<string, unknown>,
        createdAt: r.event.createdAt.toISOString(),
      })),
    };
  });

  // --- Settings: org + members ---

  app.get("/api/org", async (req) => {
    const [org] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, req.user!.orgId))
      .limit(1);
    return {
      org: {
        id: org!.id,
        name: org!.name,
        createdAt: org!.createdAt.toISOString(),
      },
    };
  });

  app.patch("/api/org", { preHandler: requireOrgAdmin }, async (req) => {
    const { name } = req.body as { name: string };
    await db
      .update(orgs)
      .set({ name: name.trim() })
      .where(eq(orgs.id, req.user!.orgId));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "org.rename",
      targetType: "org",
      targetId: req.user!.orgId,
      summary: `Renamed organization to "${name.trim()}"`,
    });
    return { ok: true };
  });

  // Invite = create a member with a temporary password (no email in OSS yet)
  app.post("/api/members", { preHandler: requireOrgAdmin }, async (req, reply) => {
    const { name, email, role } = req.body as {
      name: string;
      email: string;
      role?: "admin" | "member";
    };
    if (!name?.trim() || !email?.trim()) {
      return reply.code(400).send({ error: "Name and email are required" });
    }
    const tempPassword = randomBytes(9).toString("base64url");
    let user;
    try {
      [user] = await db
        .insert(users)
        .values({
          orgId: req.user!.orgId,
          email: email.trim().toLowerCase(),
          name: name.trim(),
          role: role ?? "member",
          passwordHash: hashPassword(tempPassword),
        })
        .returning();
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "A user with that email already exists" });
      }
      throw err;
    }
    const [everyone] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, req.user!.orgId), eq(teams.isEveryone, true)))
      .limit(1);
    if (everyone) {
      await db
        .insert(teamMembers)
        .values({ teamId: everyone.id, userId: user!.id })
        .onConflictDoNothing();
    }
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "member.invite",
      targetType: "user",
      targetId: user!.id,
      summary: `Invited ${name.trim()} (${role ?? "member"})`,
    });
    // Shown once; in SaaS this becomes an email invite.
    return { user: { id: user!.id, name: user!.name, email: user!.email }, tempPassword };
  });
}
