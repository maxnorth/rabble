import type { FastifyInstance } from "fastify";
import { createAgentSchema, slugify, updateAgentSchema } from "@rabblehq/core";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agents,
  agentToolConfigs,
  domains,
  evalResults,
  evalCriteria,
  userFavorites,
} from "../db/schema.js";
import { requireUser } from "../auth.js";
import { serializeAgent } from "../serialize.js";
import { recordAudit } from "../audit.js";
import { hasRight, rightsForAllAgents } from "../rights.js";

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

/** Live eval score per agent: pass rate across all criterion results. */
async function evalScores(orgId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      agentId: evalCriteria.agentId,
      score: sql<number>`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END))::int`,
    })
    .from(evalResults)
    .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
    .innerJoin(agents, eq(evalCriteria.agentId, agents.id))
    .where(eq(agents.orgId, orgId))
    .groupBy(evalCriteria.agentId);
  return new Map(rows.map((r) => [r.agentId, r.score]));
}

export async function agentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/agents", async (req) => {
    const rights = await rightsForAllAgents(req.user!);
    const rows = await db
      .select({
        agent: agents,
        domainName: domains.name,
        toolCount: sql<number>`(SELECT count(*)::int FROM agent_tool_configs c WHERE c.agent_id = agents.id AND c.enabled)`,
        updatedByEmail: sql<string | null>`(SELECT u.email FROM users u WHERE u.id = agents.updated_by)`,
        lastUsedAt: sql<string | null>`(
          SELECT max(s.updated_at)::text FROM sessions s
          WHERE s.agent_id = agents.id AND s.user_id = ${req.user!.id}
        )`,
        scope: sql<string>`CASE
          WHEN EXISTS (
            SELECT 1 FROM grants g JOIN teams t ON t.id = g.subject_id
            WHERE g.subject_type = 'team' AND t.is_everyone
              AND ((g.target_type = 'agent' AND g.target_id = agents.id)
                OR (g.target_type = 'domain' AND g.target_id = agents.domain_id))
          ) THEN 'org-wide'
          WHEN EXISTS (
            SELECT 1 FROM grants g
            WHERE g.subject_type = 'team'
              AND ((g.target_type = 'agent' AND g.target_id = agents.id)
                OR (g.target_type = 'domain' AND g.target_id = agents.domain_id))
          ) THEN 'team'
          ELSE 'personal'
        END`,
      })
      .from(agents)
      .leftJoin(domains, eq(agents.domainId, domains.id))
      .where(eq(agents.orgId, req.user!.orgId))
      .orderBy(agents.name);

    const scores = await evalScores(req.user!.orgId);
    const starredRows = await db
      .select({ agentId: userFavorites.agentId })
      .from(userFavorites)
      .where(eq(userFavorites.userId, req.user!.id));
    const starred = new Set(starredRows.map((r) => r.agentId));

    // Drafts are visible only to whoever can edit them; active agents are a
    // trust surface for the whole org.
    const visible = rows.filter(
      (r) =>
        r.agent.status === "active" ||
        hasRight(rights.get(r.agent.id) ?? null, "edit"),
    );

    return {
      agents: visible.map((r) => ({
        ...serializeAgent(r.agent),
        domainName: r.domainName,
        evalScore: scores.get(r.agent.id) ?? null,
        toolCount: r.toolCount,
        starred: starred.has(r.agent.id),
        myRight: rights.get(r.agent.id) ?? null,
        scope: r.scope,
        lastUsedAt: r.lastUsedAt,
        updatedByEmail: r.updatedByEmail,
      })),
    };
  });

  app.get("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Agent not found" });
    const rights = await rightsForAllAgents(req.user!);
    const myRight = rights.get(id) ?? null;
    if (row.status === "draft" && !hasRight(myRight, "edit")) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    return { agent: serializeAgent(row), myRight };
  });

  app.post("/api/agents", async (req, reply) => {
    const body = createAgentSchema.parse(req.body);
    const { orgs } = await import("../db/schema.js");
    const { orgSettingsSchema } = await import("@rabblehq/core");
    const [org] = await db
      .select({ settings: orgs.settings })
      .from(orgs)
      .where(eq(orgs.id, req.user!.orgId))
      .limit(1);
    const settings = orgSettingsSchema.parse({ ...(org?.settings as object) });
    if (
      settings.whoCanCreateAgents === "designated" &&
      req.user!.role === "member"
    ) {
      return reply.code(403).send({
        error: "Agent creation is limited to designated members in this org.",
      });
    }
    const [row] = await db
      .insert(agents)
      .values({
        orgId: req.user!.orgId,
        slug: await uniqueSlug(req.user!.orgId, body.name),
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        modelId: body.modelId ?? null,
        createdBy: req.user!.id,
        status: body.status,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.create",
      targetType: "agent",
      targetId: row!.id,
      summary: `Created agent "${body.name}" (${body.status})`,
    });
    return { agent: serializeAgent(row!) };
  });

  app.patch("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateAgentSchema.parse(req.body);
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access to configure this agent" });
    }

    const updates: Partial<typeof agents.$inferInsert> = {
      updatedAt: new Date(),
      updatedBy: req.user!.id,
    };
    if (body.name !== undefined) {
      updates.name = body.name;
      updates.slug = await uniqueSlug(req.user!.orgId, body.name, id);
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.instructions !== undefined) updates.instructions = body.instructions;
    if (body.modelId !== undefined) updates.modelId = body.modelId;
    if (body.domainId !== undefined) updates.domainId = body.domainId;
    if (body.capabilities !== undefined) updates.capabilities = body.capabilities;
    if (body.icon !== undefined) updates.icon = body.icon;
    if (body.color !== undefined) updates.color = body.color;
    if (body.tone !== undefined) updates.tone = body.tone;
    if (body.status !== undefined) updates.status = body.status;

    const [row] = await db
      .update(agents)
      .set(updates)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
      .returning();
    if (!row) return reply.code(404).send({ error: "Agent not found" });
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.update",
      targetType: "agent",
      targetId: id,
      summary: `Updated agent "${row.name}"`,
      metadata: { fields: Object.keys(body) },
    });
    return { agent: serializeAgent(row) };
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "admin")) {
      return reply.code(403).send({ error: "You need admin access to delete this agent" });
    }
    try {
      const deleted = await db
        .delete(agents)
        .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
        .returning({ id: agents.id, name: agents.name });
      if (deleted.length === 0) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "agent.delete",
        targetType: "agent",
        targetId: id,
        summary: `Deleted agent "${deleted[0]!.name}"`,
      });
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

  app.put("/api/agents/:id/star", async (req) => {
    const { id } = req.params as { id: string };
    await db
      .insert(userFavorites)
      .values({ userId: req.user!.id, agentId: id })
      .onConflictDoNothing();
    return { ok: true };
  });

  app.delete("/api/agents/:id/star", async (req) => {
    const { id } = req.params as { id: string };
    await db
      .delete(userFavorites)
      .where(
        and(eq(userFavorites.userId, req.user!.id), eq(userFavorites.agentId, id)),
      );
    return { ok: true };
  });

  // Sub-agent links (the "agents" tab): which agents this one can call
  app.get("/api/agents/:id/sub-agents", async (req) => {
    const { id } = req.params as { id: string };
    const { agentLinks } = await import("../db/schema.js");
    const links = await db
      .select({ subAgentId: agentLinks.subAgentId })
      .from(agentLinks)
      .where(eq(agentLinks.agentId, id));
    const ids = links.map((l) => l.subAgentId);
    const rows = ids.length
      ? await db.select().from(agents).where(inArray(agents.id, ids))
      : [];
    return { subAgents: rows.map(serializeAgent) };
  });

  app.put("/api/agents/:id/sub-agents/:subId", async (req, reply) => {
    const { id, subId } = req.params as { id: string; subId: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    // Wiring an agent in requires use access on the target — the permission
    // gate that keeps inter-agent composition auditable.
    if (!hasRight(rights.get(subId) ?? null, "use")) {
      return reply
        .code(403)
        .send({ error: "You need use access on the agent you're attaching" });
    }
    if (id === subId) {
      return reply.code(400).send({ error: "An agent can't call itself" });
    }
    const { agentLinks } = await import("../db/schema.js");
    await db
      .insert(agentLinks)
      .values({ agentId: id, subAgentId: subId })
      .onConflictDoNothing();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.link",
      targetType: "agent",
      targetId: id,
      summary: "Wired an agent in as a callable tool",
      metadata: { subAgentId: subId },
    });
    return { ok: true };
  });

  app.delete("/api/agents/:id/sub-agents/:subId", async (req, reply) => {
    const { id, subId } = req.params as { id: string; subId: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const { agentLinks } = await import("../db/schema.js");
    await db
      .delete(agentLinks)
      .where(and(eq(agentLinks.agentId, id), eq(agentLinks.subAgentId, subId)));
    return { ok: true };
  });

  // Per-agent tool configuration lives in agent routes for cohesion
  app.get("/api/agents/:id/tools", async (req) => {
    const { id } = req.params as { id: string };
    const { agentMcpServers, mcpServers } = await import("../db/schema.js");
    const attached = await db
      .select({ server: mcpServers })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(agentMcpServers.serverId, mcpServers.id))
      .where(eq(agentMcpServers.agentId, id));
    const configs = await db
      .select()
      .from(agentToolConfigs)
      .where(eq(agentToolConfigs.agentId, id));
    const configFor = new Map(
      configs.map((c) => [`${c.serverId}:${c.toolName}`, c]),
    );

    const tools = attached.flatMap((a) => {
      const serverTools = (a.server.tools ?? []) as Array<{
        name: string;
        description: string;
      }>;
      return serverTools.map((t) => {
        const config = configFor.get(`${a.server.id}:${t.name}`);
        return {
          serverId: a.server.id,
          serverName: a.server.name,
          toolName: t.name,
          description: t.description,
          enabled: config?.enabled ?? true,
          authType: config?.authType ?? "service",
        };
      });
    });
    return { tools, servers: attached.map((a) => a.server.id) };
  });

  // --- Surfaces: where this agent is reachable ---

  app.get("/api/agents/:id/surfaces", async (req) => {
    const { id } = req.params as { id: string };
    const { agentSurfaces, connections } = await import("../db/schema.js");
    const rows = await db
      .select({ surface: agentSurfaces, connection: connections })
      .from(agentSurfaces)
      .innerJoin(connections, eq(agentSurfaces.connectionId, connections.id))
      .where(eq(agentSurfaces.agentId, id))
      .orderBy(connections.vendor);
    return {
      surfaces: rows.map((r) => ({
        id: r.surface.id,
        agentId: r.surface.agentId,
        connectionId: r.surface.connectionId,
        connectionName: r.connection.name,
        vendor: r.connection.vendor,
        label: r.surface.label,
        status: r.connection.status,
        createdAt: r.surface.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/agents/:id/surfaces", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { createAgentSurfaceSchema } = await import("@rabblehq/core");
    const body = createAgentSurfaceSchema.parse(req.body);
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const { agentSurfaces, connections } = await import("../db/schema.js");
    const [connection] = await db
      .select()
      .from(connections)
      .where(
        and(eq(connections.id, body.connectionId), eq(connections.orgId, req.user!.orgId)),
      )
      .limit(1);
    if (!connection) return reply.code(404).send({ error: "Connection not found" });
    const [row] = await db
      .insert(agentSurfaces)
      .values({ agentId: id, connectionId: body.connectionId, label: body.label })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.surface.add",
      targetType: "agent",
      targetId: id,
      summary: `Added surface ${connection.vendor}${body.label ? ` ${body.label}` : ""}`,
    });
    return { surface: { id: row!.id } };
  });

  app.delete("/api/agents/:id/surfaces/:surfaceId", async (req, reply) => {
    const { id, surfaceId } = req.params as { id: string; surfaceId: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const { agentSurfaces } = await import("../db/schema.js");
    await db
      .delete(agentSurfaces)
      .where(and(eq(agentSurfaces.id, surfaceId), eq(agentSurfaces.agentId, id)));
    return { ok: true };
  });
}
