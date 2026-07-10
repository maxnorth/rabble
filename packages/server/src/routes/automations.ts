import type { FastifyInstance } from "fastify";
import { createAutomationSchema, updateAutomationSchema } from "@rabblehq/core";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { automations } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";
import { hasRight, rightsForAllAgents } from "../rights.js";
import { isSchedulerActive } from "../scheduling/hatchet.js";

function serialize(row: typeof automations.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    schedule: row.schedule,
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastSessionId: row.lastSessionId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Automation definitions plus on-demand execution ("Run now"): a run is a
 * real governed session under the triggering user, on the Automation
 * surface. The recurring scheduler is Hatchet (docs/DECISIONS.md) and will
 * invoke the same executor when it lands; no interim cron is introduced.
 */
export async function automationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  // Whether the platform scheduler is live. When it isn't, an enabled
  // automation only fires via "Run now" — the UI says so plainly.
  app.get("/api/scheduler", async () => ({ active: isSchedulerActive() }));

  app.get("/api/agents/:agentId/automations", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    // Scope the read: automations carry a prompt, so only someone with `use`
    // on this agent (which is org-scoped) may list them — never a bare agent
    // id from another org.
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(agentId) ?? null, "use")) {
      return reply.code(403).send({ error: "You need access to this agent" });
    }
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
      .values({ agentId, ...body, createdBy: req.user!.id })
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
    const patch = updateAutomationSchema.parse(req.body);
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
      .set(patch)
      .where(eq(automations.id, id))
      .returning();
    // A schedule/prompt/name change is a config edit worth auditing; a bare
    // enable/disable toggle is routine and stays quiet.
    const changedConfig = Object.keys(patch).some((k) => k !== "enabled");
    if (changedConfig) {
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "automation.update",
        targetType: "agent",
        targetId: automation.agentId,
        summary: `Edited automation "${row!.name}" (${row!.schedule})`,
      });
    }
    return { automation: serialize(row!) };
  });

  // Run now: execute the automation's prompt as a real governed session.
  app.post("/api/automations/:id/run", async (req, reply) => {
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
    if (!automation.prompt.trim()) {
      return reply.code(409).send({ error: "This automation has no prompt to run" });
    }

    const { agents, models, sessions, orgs } = await import("../db/schema.js");
    const { orgSettingsSchema } = await import("@rabblehq/core");
    const { executeTurnAndPersist } = await import("../runtime/executeTurn.js");

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, automation.agentId))
      .limit(1);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    const [model] = agent.modelId
      ? await db.select().from(models).where(eq(models.id, agent.modelId)).limit(1)
      : [];
    if (!model) {
      return reply.code(409).send({ error: "The agent has no model configured" });
    }
    const [org] = await db
      .select({ settings: orgs.settings })
      .from(orgs)
      .where(eq(orgs.id, req.user!.orgId))
      .limit(1);
    const orgSettings = orgSettingsSchema.parse({ ...(org?.settings as object) });

    const [session] = await db
      .insert(sessions)
      .values({
        orgId: req.user!.orgId,
        userId: req.user!.id,
        agentId: agent.id,
        title: automation.name,
        surface: `Automation · ${automation.name}`,
      })
      .returning();

    const result = await executeTurnAndPersist({
      sessionId: session!.id,
      agent,
      model,
      user: req.user!,
      content: automation.prompt,
      requireApproval: orgSettings.requireApprovalForUserTools,
      sessionApproved: false,
      // No one is watching a scheduled run — approvals can't prompt.
      interactive: false,
    });

    await db
      .update(automations)
      .set({ lastRunAt: new Date(), lastSessionId: session!.id })
      .where(eq(automations.id, id));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "automation.run",
      targetType: "agent",
      targetId: agent.id,
      summary: `Ran automation "${automation.name}"`,
    });
    return {
      sessionId: session!.id,
      reply: result.fullText,
      toolCalls: result.toolCalls.length,
    };
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
