import type { FastifyInstance } from "fastify";
import { createGrantSchema } from "@rabblehq/core";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, domains, grants, teams, users } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";
import { hasRight, rightForAgent } from "../rights.js";

async function subjectNames(
  rows: Array<typeof grants.$inferSelect>,
): Promise<Map<string, string>> {
  const userIds = rows.filter((g) => g.subjectType === "user").map((g) => g.subjectId);
  const teamIds = rows.filter((g) => g.subjectType === "team").map((g) => g.subjectId);
  const names = new Map<string, string>();
  if (userIds.length) {
    for (const u of await db.select().from(users).where(inArray(users.id, userIds))) {
      names.set(u.id, u.name);
    }
  }
  if (teamIds.length) {
    for (const t of await db.select().from(teams).where(inArray(teams.id, teamIds))) {
      names.set(t.id, t.name);
    }
  }
  return names;
}

async function canManageTarget(
  req: { user: { id: string; orgId: string; role: string } | null },
  targetType: "agent" | "domain" | "model",
  targetId: string,
): Promise<boolean> {
  const user = req.user!;
  if (user.role === "owner" || user.role === "admin") return true;
  // Domain and model grants are org-admin territory
  if (targetType !== "agent") return false;
  const right = await rightForAgent(user as never, targetId);
  return hasRight(right, "admin");
}

function serializeGrant(
  g: typeof grants.$inferSelect,
  subjectName: string,
  targetName: string,
  viaDomain: string | null = null,
) {
  return {
    id: g.id,
    subjectType: g.subjectType,
    subjectId: g.subjectId,
    subjectName,
    accessRight: g.accessRight,
    targetType: g.targetType,
    targetId: g.targetId,
    targetName,
    viaDomain,
    createdAt: g.createdAt.toISOString(),
  };
}

export async function grantRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  /**
   * Grants reaching a target. For agents this includes grants on the agent's
   * domain (marked viaDomain) — the full access picture in one list.
   */
  app.get("/api/grants", async (req, reply) => {
    const { targetType, targetId } = req.query as {
      targetType?: "agent" | "domain" | "model";
      targetId?: string;
    };
    if (!targetType || !targetId) {
      return reply.code(400).send({ error: "targetType and targetId are required" });
    }

    const direct = await db
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.orgId, req.user!.orgId),
          eq(grants.targetType, targetType),
          eq(grants.targetId, targetId),
        ),
      );

    let targetName = "";
    let domainGrants: Array<typeof grants.$inferSelect> = [];
    let domainDisplay: string | null = null;
    if (targetType === "agent") {
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, targetId), eq(agents.orgId, req.user!.orgId)))
        .limit(1);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      targetName = agent.name;
      if (agent.domainId) {
        const [domain] = await db
          .select()
          .from(domains)
          .where(eq(domains.id, agent.domainId))
          .limit(1);
        if (domain) {
          domainDisplay = domain.name;
          domainGrants = await db
            .select()
            .from(grants)
            .where(
              and(
                eq(grants.orgId, req.user!.orgId),
                eq(grants.targetType, "domain"),
                eq(grants.targetId, domain.id),
              ),
            );
        }
      }
    } else if (targetType === "domain") {
      const [domain] = await db
        .select()
        .from(domains)
        .where(and(eq(domains.id, targetId), eq(domains.orgId, req.user!.orgId)))
        .limit(1);
      if (!domain) return reply.code(404).send({ error: "Domain not found" });
      targetName = domain.name;
    } else {
      const { models } = await import("../db/schema.js");
      const [model] = await db
        .select()
        .from(models)
        .where(and(eq(models.id, targetId), eq(models.orgId, req.user!.orgId)))
        .limit(1);
      if (!model) return reply.code(404).send({ error: "Model not found" });
      targetName = model.displayName;
    }

    const names = await subjectNames([...direct, ...domainGrants]);
    return {
      grants: [
        ...direct.map((g) =>
          serializeGrant(g, names.get(g.subjectId) ?? "(deleted)", targetName),
        ),
        ...domainGrants.map((g) =>
          serializeGrant(
            g,
            names.get(g.subjectId) ?? "(deleted)",
            targetName,
            domainDisplay,
          ),
        ),
      ],
    };
  });

  app.post("/api/grants", async (req, reply) => {
    const body = createGrantSchema.parse(req.body);
    if (!(await canManageTarget(req, body.targetType, body.targetId))) {
      return reply
        .code(403)
        .send({ error: "You need admin access to manage grants here" });
    }

    // The target must belong to this org — symmetry with the subject check
    // below. Without it an admin could mint a grant referencing another org's
    // domain or model id (agent targets are already covered by the admin-right
    // check, which fails closed for a foreign agent).
    const targetInOrg = await (async () => {
      if (body.targetType === "agent") {
        const [a] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, body.targetId), eq(agents.orgId, req.user!.orgId)))
          .limit(1);
        return Boolean(a);
      }
      if (body.targetType === "domain") {
        const [d] = await db
          .select({ id: domains.id })
          .from(domains)
          .where(and(eq(domains.id, body.targetId), eq(domains.orgId, req.user!.orgId)))
          .limit(1);
        return Boolean(d);
      }
      const { models } = await import("../db/schema.js");
      const [m] = await db
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.id, body.targetId), eq(models.orgId, req.user!.orgId)))
        .limit(1);
      return Boolean(m);
    })();
    if (!targetInOrg) {
      return reply.code(404).send({ error: "Target not found" });
    }

    // Validate subject and target belong to this org
    if (body.subjectType === "user") {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, body.subjectId), eq(users.orgId, req.user!.orgId)))
        .limit(1);
      if (!u) return reply.code(404).send({ error: "User not found" });
    } else {
      const [t] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, body.subjectId), eq(teams.orgId, req.user!.orgId)))
        .limit(1);
      if (!t) return reply.code(404).send({ error: "Team not found" });
    }

    const [row] = await db
      .insert(grants)
      .values({
        orgId: req.user!.orgId,
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        accessRight: body.accessRight,
        targetType: body.targetType,
        targetId: body.targetId,
        createdBy: req.user!.id,
      })
      .onConflictDoUpdate({
        target: [
          grants.orgId,
          grants.subjectType,
          grants.subjectId,
          grants.targetType,
          grants.targetId,
        ],
        set: { accessRight: body.accessRight, createdBy: req.user!.id },
      })
      .returning();

    const names = await subjectNames([row!]);
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "grant.set",
      targetType: body.targetType,
      targetId: body.targetId,
      summary: `Granted ${names.get(row!.subjectId) ?? "someone"} ${body.accessRight} on ${body.targetType}`,
      metadata: { grantId: row!.id, accessRight: body.accessRight },
    });
    return {
      grant: serializeGrant(row!, names.get(row!.subjectId) ?? "", ""),
    };
  });

  app.delete("/api/grants/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [grant] = await db
      .select()
      .from(grants)
      .where(and(eq(grants.id, id), eq(grants.orgId, req.user!.orgId)))
      .limit(1);
    if (!grant) return reply.code(404).send({ error: "Grant not found" });
    if (!(await canManageTarget(req, grant.targetType, grant.targetId))) {
      return reply
        .code(403)
        .send({ error: "You need admin access to manage grants here" });
    }
    await db.delete(grants).where(eq(grants.id, id));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "grant.revoke",
      targetType: grant.targetType,
      targetId: grant.targetId,
      summary: `Revoked a ${grant.accessRight} grant on ${grant.targetType}`,
      metadata: { grantId: id },
    });
    return { ok: true };
  });
}
