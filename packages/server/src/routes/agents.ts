import type { FastifyInstance } from "fastify";
import { createAgentSchema, slugify, updateAgentSchema } from "@rabble/core";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { serializeAgent } from "../serialize.js";

async function uniqueSlug(orgId: string, name: string, excludeId?: string) {
  const base = slugify(name) || "agent";
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.slug, candidate),
          ...(excludeId ? [ne(agents.id, excludeId)] : []),
        ),
      )
      .limit(1);
    if (clash.length === 0) return candidate;
  }
}

export async function agentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/agents", async (req) => {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.orgId, req.user!.orgId))
      .orderBy(agents.name);
    return { agents: rows.map(serializeAgent) };
  });

  app.get("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Agent not found" });
    return { agent: serializeAgent(row) };
  });

  app.post("/api/agents", async (req) => {
    const body = createAgentSchema.parse(req.body);
    const [row] = await db
      .insert(agents)
      .values({
        orgId: req.user!.orgId,
        slug: await uniqueSlug(req.user!.orgId, body.name),
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        modelId: body.modelId ?? null,
        status: body.status,
      })
      .returning();
    return { agent: serializeAgent(row!) };
  });

  app.patch("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateAgentSchema.parse(req.body);
    const updates: Partial<typeof agents.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.name !== undefined) {
      updates.name = body.name;
      updates.slug = await uniqueSlug(req.user!.orgId, body.name, id);
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.instructions !== undefined) updates.instructions = body.instructions;
    if (body.modelId !== undefined) updates.modelId = body.modelId;
    if (body.status !== undefined) updates.status = body.status;

    const [row] = await db
      .update(agents)
      .set(updates)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
      .returning();
    if (!row) return reply.code(404).send({ error: "Agent not found" });
    return { agent: serializeAgent(row) };
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const deleted = await db
        .delete(agents)
        .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
        .returning({ id: agents.id });
      if (deleted.length === 0) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      return { ok: true };
    } catch (err) {
      // 23503 = foreign_key_violation: the agent has sessions referencing it
      if ((err as { code?: string }).code === "23503") {
        return reply.code(409).send({
          error: "This agent has sessions and can't be deleted yet.",
        });
      }
      throw err;
    }
  });
}
