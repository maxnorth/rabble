import type { FastifyInstance } from "fastify";
import { createDomainSchema, slugify } from "@rabblehq/core";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, domains, grants } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";

function serializeDomain(row: typeof domains.$inferSelect, agentCount: number) {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    name: row.name,
    agentCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function domainRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/domains", async (req) => {
    const rows = await db
      .select({
        domain: domains,
        agentCount: sql<number>`(SELECT count(*)::int FROM agents a WHERE a.domain_id = domains.id)`,
      })
      .from(domains)
      .where(eq(domains.orgId, req.user!.orgId))
      .orderBy(domains.name);
    return { domains: rows.map((r) => serializeDomain(r.domain, r.agentCount)) };
  });

  app.post("/api/domains", async (req, reply) => {
    const body = createDomainSchema.parse(req.body);
    const slug = slugify(body.name) || "domain";
    const [existing] = await db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.orgId, req.user!.orgId), eq(domains.slug, slug)))
      .limit(1);
    if (existing) {
      return reply.code(409).send({ error: "A domain with that name already exists" });
    }
    const [row] = await db
      .insert(domains)
      .values({ orgId: req.user!.orgId, slug, name: body.name })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "domain.create",
      targetType: "domain",
      targetId: row!.id,
      summary: `Created domain "${body.name}"`,
    });
    return { domain: serializeDomain(row!, 0) };
  });

  app.delete("/api/domains/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [domain] = await db
      .select()
      .from(domains)
      .where(and(eq(domains.id, id), eq(domains.orgId, req.user!.orgId)))
      .limit(1);
    if (!domain) return reply.code(404).send({ error: "Domain not found" });

    await db
      .update(agents)
      .set({ domainId: null })
      .where(eq(agents.domainId, id));
    await db
      .delete(grants)
      .where(and(eq(grants.targetType, "domain"), eq(grants.targetId, id)));
    await db.delete(domains).where(eq(domains.id, id));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "domain.delete",
      targetType: "domain",
      targetId: id,
      summary: `Deleted domain "${domain.name}" (agents kept, now domainless)`,
    });
    return { ok: true };
  });
}
