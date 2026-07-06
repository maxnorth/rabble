import type { FastifyInstance } from "fastify";
import { createAutomationSchema } from "@rabblehq/core";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { automations } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";
import { hasRight, rightsForAllAgents } from "../rights.js";

function serialize(row: typeof automations.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    schedule: row.schedule,
    prompt: row.prompt,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Automation definitions. Execution is deliberately not wired yet — the
 * scheduling engine is Hatchet (docs/DECISIONS.md) and lands as its own
 * phase; these routes own the configuration surface.
 */
export async function automationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/agents/:agentId/automations", async (req) => {
    const { agentId } = req.params as { agentId: string };
    const rows = await db
      .select()
      .from(automations)
      .where(eq(automations.agentId, agentId))
      .orderBy(automations.createdAt);
    return { automations: rows.map(serialize) };
  });

  app.post("/api/agents/:agentId/automations", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(agentId) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const body = createAutomationSchema.parse(req.body);
    const [row] = await db
      .insert(automations)
      .values({ agentId, ...body })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "automation.create",
      targetType: "agent",
      targetId: agentId,
      summary: `Created automation "${body.name}" (${body.schedule})`,
    });
    return { automation: serialize(row!) };
  });

  app.patch("/api/automations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = req.body as { enabled: boolean };
    const [automation] = await db
      .select()
      .from(automations)
      .where(eq(automations.id, id))
      .limit(1);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(automation.agentId) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const [row] = await db
      .update(automations)
      .set({ enabled })
      .where(eq(automations.id, id))
      .returning();
    return { automation: serialize(row!) };
  });

  app.delete("/api/automations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [automation] = await db
      .select()
      .from(automations)
      .where(eq(automations.id, id))
      .limit(1);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(automation.agentId) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    await db.delete(automations).where(eq(automations.id, id));
    return { ok: true };
  });
}
