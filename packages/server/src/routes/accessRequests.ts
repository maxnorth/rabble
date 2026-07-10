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
import { agentInOrg } from "../rights.js";

async function requireOrgAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "Not authenticated" });
  if (req.user.role !== "owner" && req.user.role !== "admin") {
    return reply.code(403).send({ error: "Org admin access required" });
  }
}

/**
 * Track record for the approval decision — the thesis in one payload:
 * evidence (pass rate, graded volume, recent scope violations) is what
 * lets an approver sign a defensible yes. Agent targets only.
 */
async function evidenceFor(
  orgId: string,
  targetType: "agent" | "domain" | "model",
  targetId: string,
): Promise<
  { passRate30d: number | null; graded30d: number; scopeViolations30d: number } | undefined
> {
  // Evidence is track-record data (pass rate, graded volume, scope
  // violations) — only ever computed for an agent that belongs to this org,
  // so it can't leak a foreign agent's record into an admin's queue.
  if (targetType !== "agent") return undefined;
  if (!(await agentInOrg(orgId, targetId))) return undefined;
  const [row] = await db
    .select({
      graded: sql<number>`count(*)::int`,
      passed: sql<number>`count(*) FILTER (WHERE er.passed)::int`,
    })
    .from(sql`eval_results er`)
    .innerJoin(sql`eval_criteria ec`, sql`ec.id = er.criterion_id`)
    .where(
      sql`ec.agent_id = ${targetId} AND er.created_at > now() - interval '30 days'`,
    );
  const [violations] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sql`scope_violations sv`)
    .where(
      sql`sv.agent_id = ${targetId} AND sv.created_at > now() - interval '30 days'`,
    );
  const graded = row?.graded ?? 0;
  return {
    passRate30d: graded > 0 ? Math.round(((row?.passed ?? 0) / graded) * 100) : null,
    graded30d: graded,
    scopeViolations30d: violations?.count ?? 0,
  };
}

// Org-scoped: a request may only target a resource in the caller's own org.
// An out-of-org (or missing) target reads back as "(deleted)", so a cross-org
// UUID can't be smuggled into a request or leak its name into an admin's view.
async function targetNameFor(
  orgId: string,
  targetType: "agent" | "domain" | "model",
  targetId: string,
): Promise<string> {
  if (targetType === "agent") {
    const [row] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, targetId), eq(agents.orgId, orgId)))
      .limit(1);
    return row?.name ?? "(deleted)";
  }
  if (targetType === "domain") {
    const [row] = await db
      .select({ name: domains.name })
      .from(domains)
      .where(and(eq(domains.id, targetId), eq(domains.orgId, orgId)))
      .limit(1);
    return row?.name ?? "(deleted)";
  }
  const [row] = await db
    .select({ name: models.displayName })
    .from(models)
    .where(and(eq(models.id, targetId), eq(models.orgId, orgId)))
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
          targetName: await targetNameFor(req.user!.orgId, r.targetType, r.targetId),
          accessRight: r.accessRight,
          reason: r.reason,
          via: r.via,
          status: r.status,
          decidedByName: deciderName ?? null,
          decidedAt: r.decidedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          evidence:
            r.status === "open"
              ? await evidenceFor(req.user!.orgId, r.targetType, r.targetId)
              : undefined,
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

  /** Any member can ask; the Builder uses its own tool for the same row. */
  app.post("/api/access-requests", async (req, reply) => {
    const { createAccessRequestSchema } = await import("@rabblehq/core");
    const body = createAccessRequestSchema.parse(req.body);

    // The target must exist in the caller's org.
    const targetName = await targetNameFor(
      req.user!.orgId,
      body.targetType,
      body.targetId,
    );
    if (targetName === "(deleted)") {
      return reply.code(404).send({ error: "Target not found" });
    }

    const [duplicate] = await db
      .select({ id: accessRequests.id })
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.orgId, req.user!.orgId),
          eq(accessRequests.requesterUserId, req.user!.id),
          eq(accessRequests.targetType, body.targetType),
          eq(accessRequests.targetId, body.targetId),
          eq(accessRequests.status, "open"),
        ),
      )
      .limit(1);
    if (duplicate) {
      return reply
        .code(409)
        .send({ error: "You already have an open request for this. An admin will review it." });
    }

    const [row] = await db
      .insert(accessRequests)
      .values({
        orgId: req.user!.orgId,
        requesterUserId: req.user!.id,
        targetType: body.targetType,
        targetId: body.targetId,
        accessRight: body.accessRight,
        reason: body.reason ?? "",
        via: "web",
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "access.request",
      targetType: body.targetType,
      targetId: body.targetId,
      summary: `Requested ${body.accessRight} on ${body.targetType} "${targetName}"`,
    });
    const { notifyAdminsOfAccessRequest } = await import(
      "../notifications/accessRequests.js"
    );
    void notifyAdminsOfAccessRequest({
      orgId: req.user!.orgId,
      requesterName: req.user!.name,
      accessRight: body.accessRight,
      targetLabel: `${body.targetType} "${targetName}"`,
      reason: body.reason ?? "",
    });
    return { request: { id: row!.id, status: row!.status } };
  });

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

      const targetName = await targetNameFor(request.orgId, request.targetType, request.targetId);
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
      const targetName = await targetNameFor(request.orgId, request.targetType, request.targetId);
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
