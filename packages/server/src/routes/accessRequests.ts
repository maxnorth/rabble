/**
 * Access requests — the admin side of the Builder's request → notify →
 * approve loop (PRODUCT_CONTEXT §6, J1 critical path). A request is a user
 * asking for a grant; approving one materializes the real grant (upgrading
 * an existing lower right rather than duplicating), and every decision is
 * audit-recorded.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { RIGHT_ORDER, type AccessRequest } from "@rabblehq/core";
import { db } from "../db/client.js";
import {
  accessRequests,
  agents,
  domains,
  grants,
  models,
  users,
} from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";

async function requireOrgAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "Not authenticated" });
  if (req.user.role !== "owner" && req.user.role !== "admin") {
    return reply.code(403).send({ error: "Org admin access required" });
  }
}

async function targetNameFor(
  targetType: "agent" | "domain" | "model",
  targetId: string,
): Promise<string> {
  if (targetType === "agent") {
    const [row] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, targetId))
      .limit(1);
    return row?.name ?? "(deleted)";
  }
  if (targetType === "domain") {
    const [row] = await db
      .select({ name: domains.name })
      .from(domains)
      .where(eq(domains.id, targetId))
      .limit(1);
    return row?.name ?? "(deleted)";
  }
  const [row] = await db
    .select({ name: models.displayName })
    .from(models)
    .where(eq(models.id, targetId))
    .limit(1);
  return row?.name ?? "(deleted)";
}

export async function accessRequestRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get(
    "/api/access-requests",
    { preHandler: requireOrgAdmin },
    async (req) => {
      const requester = alias(users, "requester");
      const decider = alias(users, "decider");
      const rows = await db
        .select({
          request: accessRequests,
          requesterName: requester.name,
          deciderName: decider.name,
        })
        .from(accessRequests)
        .innerJoin(requester, eq(accessRequests.requesterUserId, requester.id))
        .leftJoin(decider, eq(accessRequests.decidedBy, decider.id))
        .where(eq(accessRequests.orgId, req.user!.orgId))
        .orderBy(desc(accessRequests.createdAt))
        .limit(200);

      const requests: AccessRequest[] = [];
      for (const { request: r, requesterName, deciderName } of rows) {
        requests.push({
          id: r.id,
          requesterUserId: r.requesterUserId,
          requesterName,
          targetType: r.targetType,
          targetId: r.targetId,
          targetName: await targetNameFor(r.targetType, r.targetId),
          accessRight: r.accessRight,
          reason: r.reason,
          via: r.via,
          status: r.status,
          decidedByName: deciderName ?? null,
          decidedAt: r.decidedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        });
      }
      return { requests };
    },
  );

  /** Open-request count for the Admin nav badge — visible to admins only. */
  app.get(
    "/api/access-requests/count",
    { preHandler: requireOrgAdmin },
    async (req) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.orgId, req.user!.orgId),
            eq(accessRequests.status, "open"),
          ),
        );
      return { open: row?.count ?? 0 };
    },
  );

  app.post(
    "/api/access-requests/:id/approve",
    { preHandler: requireOrgAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [request] = await db
        .select()
        .from(accessRequests)
        .where(
          and(eq(accessRequests.id, id), eq(accessRequests.orgId, req.user!.orgId)),
        )
        .limit(1);
      if (!request) return reply.code(404).send({ error: "Request not found" });
      if (request.status !== "open") {
        return reply.code(409).send({ error: "Request already decided" });
      }

      // Materialize the grant: create it, or upgrade an existing lower right.
      const [existing] = await db
        .select()
        .from(grants)
        .where(
          and(
            eq(grants.orgId, request.orgId),
            eq(grants.subjectType, "user"),
            eq(grants.subjectId, request.requesterUserId),
            eq(grants.targetType, request.targetType),
            eq(grants.targetId, request.targetId),
          ),
        )
        .limit(1);
      if (!existing) {
        await db.insert(grants).values({
          orgId: request.orgId,
          subjectType: "user",
          subjectId: request.requesterUserId,
          accessRight: request.accessRight,
          targetType: request.targetType,
          targetId: request.targetId,
          createdBy: req.user!.id,
        });
      } else if (
        RIGHT_ORDER[request.accessRight] > RIGHT_ORDER[existing.accessRight]
      ) {
        await db
          .update(grants)
          .set({ accessRight: request.accessRight })
          .where(eq(grants.id, existing.id));
      }

      await db
        .update(accessRequests)
        .set({ status: "approved", decidedBy: req.user!.id, decidedAt: new Date() })
        .where(eq(accessRequests.id, id));

      const targetName = await targetNameFor(request.targetType, request.targetId);
      const [requester] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, request.requesterUserId))
        .limit(1);
      await recordAudit({
        orgId: request.orgId,
        actorUserId: req.user!.id,
        action: "grant.add",
        targetType: request.targetType,
        targetId: request.targetId,
        summary:
          `Granted ${requester?.name ?? "user"} ${request.accessRight} on ` +
          `${request.targetType} "${targetName}" (approved access request)`,
      });
      return { ok: true };
    },
  );

  app.post(
    "/api/access-requests/:id/deny",
    { preHandler: requireOrgAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [request] = await db
        .select()
        .from(accessRequests)
        .where(
          and(eq(accessRequests.id, id), eq(accessRequests.orgId, req.user!.orgId)),
        )
        .limit(1);
      if (!request) return reply.code(404).send({ error: "Request not found" });
      if (request.status !== "open") {
        return reply.code(409).send({ error: "Request already decided" });
      }
      await db
        .update(accessRequests)
        .set({ status: "denied", decidedBy: req.user!.id, decidedAt: new Date() })
        .where(eq(accessRequests.id, id));
      const targetName = await targetNameFor(request.targetType, request.targetId);
      await recordAudit({
        orgId: request.orgId,
        actorUserId: req.user!.id,
        action: "access.deny",
        targetType: request.targetType,
        targetId: request.targetId,
        summary: `Denied access request for ${request.accessRight} on ${request.targetType} "${targetName}"`,
      });
      return { ok: true };
    },
  );
}
