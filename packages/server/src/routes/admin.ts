/**
 * Admin surfaces: connections, API keys, audit log, org settings & members.
 * All mutations require org admin/owner and are audit-recorded.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createApiKeySchema,
  createConnectionSchema,
  type ConnectionRole,
} from "@rabblehq/core";
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
      .select({
        connection: connections,
        agentCount: sql<number>`(
          SELECT count(DISTINCT s.agent_id)::int FROM agent_surfaces s
          WHERE s.connection_id = connections.id
        )`,
      })
      .from(connections)
      .where(eq(connections.orgId, req.user!.orgId))
      .orderBy(connections.name);
    return {
      connections: rows.map(({ connection: c, agentCount }) => ({
        agentCount,
        id: c.id,
        orgId: c.orgId,
        vendor: c.vendor,
        name: c.name,
        roles: (c.roles ?? []) as ConnectionRole[],
        baseUrl: c.baseUrl,
        hasToken: c.encryptedToken !== null,
        status: c.status,
        tunnel: c.tunnel,
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

      const { tunnel, signingSecret } = req.body as {
        tunnel?: boolean;
        signingSecret?: string;
      };
      const [row] = await db
        .insert(connections)
        .values({
          orgId: req.user!.orgId,
          vendor: body.vendor,
          name: body.name,
          roles: body.roles,
          baseUrl: body.baseUrl ?? null,
          encryptedToken: body.token ? encryptSecret(body.token) : null,
          encryptedSigningSecret: signingSecret
            ? encryptSecret(signingSecret)
            : null,
          status,
          tunnel: tunnel ?? false,
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
      return {
        connection: {
          id: row!.id,
          orgId: row!.orgId,
          vendor: row!.vendor,
          name: row!.name,
          roles: (row!.roles ?? []) as ConnectionRole[],
          baseUrl: row!.baseUrl,
          hasToken: row!.encryptedToken !== null,
          status: row!.status,
          tunnel: row!.tunnel,
          createdAt: row!.createdAt.toISOString(),
        },
      };
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

  app.get("/api/audit", { preHandler: requireOrgAdmin }, async (req, reply) => {
    const { action, limit, format } = req.query as {
      action?: string;
      limit?: string;
      format?: string;
    };
    const conditions = [eq(auditEvents.orgId, req.user!.orgId)];
    if (action) conditions.push(sql`${auditEvents.action} LIKE ${action + "%"}`);
    const rows = await db
      .select({ event: auditEvents, actorName: users.name })
      .from(auditEvents)
      .leftJoin(users, eq(auditEvents.actorUserId, users.id))
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt))
      .limit(Math.min(Number(limit ?? 200), 500));

    if (format === "csv") {
      const escape = (v: string) => `"${v.replaceAll('"', '""')}"`;
      const csv = [
        "timestamp,actor,action,target_type,target_id,summary",
        ...rows.map((r) =>
          [
            r.event.createdAt.toISOString(),
            escape(r.actorName ?? "system"),
            r.event.action,
            r.event.targetType,
            r.event.targetId ?? "",
            escape(r.event.summary),
          ].join(","),
        ),
      ].join("\n");
      return reply
        .header("content-type", "text/csv")
        .header("content-disposition", "attachment; filename=rabble-audit.csv")
        .send(csv);
    }
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
    const { orgSettingsSchema } = await import("@rabblehq/core");
    const [org] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, req.user!.orgId))
      .limit(1);
    return {
      org: {
        id: org!.id,
        name: org!.name,
        settings: orgSettingsSchema.parse({ ...(org!.settings as object) }),
        createdAt: org!.createdAt.toISOString(),
      },
    };
  });

  app.patch("/api/org", { preHandler: requireOrgAdmin }, async (req) => {
    const { orgSettingsSchema } = await import("@rabblehq/core");
    const { name, settings } = req.body as {
      name?: string;
      settings?: Record<string, unknown>;
    };
    const updates: Record<string, unknown> = {};
    if (name?.trim()) updates.name = name.trim();
    if (settings) updates.settings = orgSettingsSchema.parse(settings);
    if (Object.keys(updates).length === 0) return { ok: true };
    await db.update(orgs).set(updates).where(eq(orgs.id, req.user!.orgId));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "org.settings",
      targetType: "org",
      targetId: req.user!.orgId,
      summary: name?.trim()
        ? `Renamed organization to "${name.trim()}"`
        : "Changed org settings",
      metadata: settings ? { settings } : {},
    });
    return { ok: true };
  });

  // Invite = create a member with a temporary password (no email in OSS yet)
  // Role changes and deactivation. The owner is untouchable; nobody edits
  // themselves (no self-demotion / self-lockout).
  app.patch("/api/members/:id", { preHandler: requireOrgAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role, active } = req.body as {
      role?: "admin" | "member";
      active?: boolean;
    };
    if (id === req.user!.id) {
      return reply.code(400).send({ error: "You can't change your own account here" });
    }
    const [target] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.orgId, req.user!.orgId)))
      .limit(1);
    if (!target) return reply.code(404).send({ error: "Member not found" });
    if (target.role === "owner") {
      return reply.code(403).send({ error: "The owner account can't be modified" });
    }
    const updates: Partial<typeof users.$inferInsert> = {};
    if (role === "admin" || role === "member") updates.role = role;
    if (typeof active === "boolean") updates.active = active;
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "Nothing to update" });
    }
    await db.update(users).set(updates).where(eq(users.id, id));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "member.update",
      targetType: "user",
      targetId: id,
      summary:
        typeof active === "boolean" && !active
          ? `Deactivated ${target.name}`
          : typeof active === "boolean"
            ? `Reactivated ${target.name}`
            : `Set ${target.name}'s role to ${role}`,
    });
    return { ok: true };
  });

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
