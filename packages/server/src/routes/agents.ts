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
import { agentInOrg, hasRight, rightsForAllAgents } from "../rights.js";

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
        needsAttention: sql<boolean>`(
          EXISTS (
            SELECT 1 FROM eval_results er
            JOIN eval_criteria ec ON ec.id = er.criterion_id
            WHERE ec.agent_id = agents.id AND er.review_status = 'open'
          ) OR EXISTS (
            SELECT 1 FROM scope_violations sv
            WHERE sv.agent_id = agents.id
              AND sv.created_at > now() - interval '30 days'
          )
        )`,
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
        needsAttention: r.needsAttention,
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

  // Duplicate: copy the configuration (identity, MCP wiring, sub-agents)
  // into a new draft. History, evals, and grants stay behind.
  app.post("/api/agents/:id/duplicate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "use")) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    // The org's creation policy applies to copies too.
    const { orgs, agentMcpServers, agentToolConfigs, agentLinks } = await import(
      "../db/schema.js"
    );
    const { orgSettingsSchema } = await import("@rabblehq/core");
    const [org] = await db
      .select({ settings: orgs.settings })
      .from(orgs)
      .where(eq(orgs.id, req.user!.orgId))
      .limit(1);
    const settings = orgSettingsSchema.parse({ ...(org?.settings as object) });
    if (settings.whoCanCreateAgents === "designated" && req.user!.role === "member") {
      return reply
        .code(403)
        .send({ error: "Agent creation is limited to org admins" });
    }
    const [source] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
      .limit(1);
    if (!source) return reply.code(404).send({ error: "Agent not found" });

    const name = `${source.name} (copy)`.slice(0, 120);
    const [copy] = await db
      .insert(agents)
      .values({
        orgId: req.user!.orgId,
        slug: await uniqueSlug(req.user!.orgId, name),
        name,
        description: source.description,
        instructions: source.instructions,
        tone: source.tone,
        icon: source.icon,
        color: source.color,
        modelId: source.modelId,
        domainId: source.domainId,
        capabilities: source.capabilities,
        status: "draft",
        createdBy: req.user!.id,
        updatedBy: req.user!.id,
      })
      .returning();

    const attachments = await db
      .select()
      .from(agentMcpServers)
      .where(eq(agentMcpServers.agentId, id));
    for (const a of attachments) {
      await db
        .insert(agentMcpServers)
        .values({ agentId: copy!.id, serverId: a.serverId });
    }
    const toolConfigs = await db
      .select()
      .from(agentToolConfigs)
      .where(eq(agentToolConfigs.agentId, id));
    for (const t of toolConfigs) {
      await db.insert(agentToolConfigs).values({
        agentId: copy!.id,
        serverId: t.serverId,
        toolName: t.toolName,
        enabled: t.enabled,
        authType: t.authType,
      });
    }
    const links = await db.select().from(agentLinks).where(eq(agentLinks.agentId, id));
    for (const l of links) {
      await db
        .insert(agentLinks)
        .values({ agentId: copy!.id, subAgentId: l.subAgentId, note: l.note });
    }

    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.duplicate",
      targetType: "agent",
      targetId: copy!.id,
      summary: `Duplicated "${source.name}" as "${name}"`,
    });
    return { agent: serializeAgent(copy!) };
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

    const [current] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
      .limit(1);
    if (!current) return reply.code(404).send({ error: "Agent not found" });

    // Gating: behavior-affecting changes must pass the agent's gating
    // suites *before* they are saved. The suites run against the candidate
    // configuration; a failing case blocks the change.
    const candidate = {
      name: (updates.name as string | undefined) ?? current.name,
      description: (updates.description as string | undefined) ?? current.description,
      instructions: (updates.instructions as string | undefined) ?? current.instructions,
      modelId:
        body.modelId !== undefined ? (body.modelId ?? null) : current.modelId,
      tone: (updates.tone as string | undefined) ?? current.tone,
    };
    const behaviorChanged =
      candidate.instructions !== current.instructions ||
      candidate.description !== current.description ||
      candidate.name !== current.name ||
      candidate.tone !== current.tone ||
      candidate.modelId !== current.modelId;

    if (behaviorChanged) {
      const { evalSuites, evalCases, models } = await import("../db/schema.js");
      const { executeSuiteCases, recordSuiteRun } = await import(
        "../evals/suiteRunner.js"
      );
      const gatingSuites = await db
        .select()
        .from(evalSuites)
        .where(and(eq(evalSuites.agentId, id), eq(evalSuites.gating, true)));
      const [model] = candidate.modelId
        ? await db
            .select()
            .from(models)
            .where(eq(models.id, candidate.modelId))
            .limit(1)
        : [];
      // Gating suites can't run without a model — refuse to save silently
      // ungated rather than let a regression slip through the hole.
      if (gatingSuites.length > 0 && !model) {
        const withCases = [];
        for (const suite of gatingSuites) {
          const cases = await db
            .select({ id: evalCases.id })
            .from(evalCases)
            .where(eq(evalCases.suiteId, suite.id));
          if (cases.length > 0) withCases.push(suite);
        }
        if (withCases.length > 0) {
          return reply.code(409).send({
            error:
              `This agent has gating suites (${withCases.map((g) => `"${g.name}"`).join(", ")}) ` +
              "but no model to run them against. Pick a model, or unmark the suites as gating.",
          });
        }
      }
      if (model) {
        for (const suite of gatingSuites) {
          const cases = await db
            .select({ id: evalCases.id })
            .from(evalCases)
            .where(eq(evalCases.suiteId, suite.id));
          if (cases.length === 0) continue;
          const outcomes = await executeSuiteCases(
            suite.id,
            {
              name: candidate.name,
              description: candidate.description,
              instructions: candidate.instructions,
            },
            model,
          );
          await recordSuiteRun(suite.id, outcomes);
          const failed = outcomes.filter((o) => !o.passed);
          if (failed.length > 0) {
            await recordAudit({
              orgId: req.user!.orgId,
              actorUserId: req.user!.id,
              action: "eval.gate.block",
              targetType: "agent",
              targetId: id,
              summary:
                `Gating suite "${suite.name}" blocked a change to ` +
                `"${current.name}" (${failed.length}/${outcomes.length} cases failed)`,
              metadata: {
                suiteId: suite.id,
                failures: failed.map((f) => ({ case: f.caseName, reasoning: f.reasoning })),
              },
            });
            return reply.code(409).send({
              error:
                `Blocked by gating suite "${suite.name}": ` +
                `${failed.length} of ${outcomes.length} cases failed ` +
                `(${failed.map((f) => f.caseName).join(", ")}). ` +
                "The change was not saved.",
              gate: {
                suiteId: suite.id,
                suiteName: suite.name,
                failures: failed.map((f) => ({
                  caseName: f.caseName,
                  reasoning: f.reasoning,
                })),
              },
            });
          }
          await recordAudit({
            orgId: req.user!.orgId,
            actorUserId: req.user!.id,
            action: "eval.gate.pass",
            targetType: "agent",
            targetId: id,
            summary: `Gating suite "${suite.name}" passed (${outcomes.length}/${outcomes.length}) for a change to "${current.name}"`,
          });
        }
      }
    }

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
    const [target] = await db
      .select({ builtin: agents.builtin })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, req.user!.orgId)))
      .limit(1);
    if (target?.builtin) {
      return reply
        .code(409)
        .send({ error: "Built-in agents ship with the platform and can't be deleted." });
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
  app.get("/api/agents/:id/sub-agents", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await agentInOrg(req.user!.orgId, id))) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    const { agentLinks } = await import("../db/schema.js");
    const links = await db
      .select({ subAgentId: agentLinks.subAgentId, note: agentLinks.note })
      .from(agentLinks)
      .where(eq(agentLinks.agentId, id));
    const notes = new Map(links.map((l) => [l.subAgentId, l.note]));
    const ids = links.map((l) => l.subAgentId);
    const rows = ids.length
      ? await db.select().from(agents).where(inArray(agents.id, ids))
      : [];
    return {
      subAgents: rows.map((r) => ({
        ...serializeAgent(r),
        note: notes.get(r.id) ?? "",
      })),
    };
  });

  // Annotate the edge: when/why the parent calls this sub-agent.
  app.patch("/api/agents/:id/sub-agents/:subId", async (req, reply) => {
    const { id, subId } = req.params as { id: string; subId: string };
    const { note } = req.body as { note?: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const { agentLinks } = await import("../db/schema.js");
    const updated = await db
      .update(agentLinks)
      .set({ note: (note ?? "").slice(0, 300) })
      .where(and(eq(agentLinks.agentId, id), eq(agentLinks.subAgentId, subId)))
      .returning();
    if (updated.length === 0) {
      return reply.code(404).send({ error: "These agents aren't linked" });
    }
    return { ok: true };
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
  app.get("/api/agents/:id/tools", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await agentInOrg(req.user!.orgId, id))) {
      return reply.code(404).send({ error: "Agent not found" });
    }
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

  app.get("/api/agents/:id/surfaces", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await agentInOrg(req.user!.orgId, id))) {
      return reply.code(404).send({ error: "Agent not found" });
    }
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
        responseMode: r.surface.responseMode,
        dmEnabled: r.surface.dmEnabled,
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

    // A connection is an agent's identity — one agent per connection (an
    // agent MAY hold several connections, e.g. one app per workspace). The
    // DB's exclusion constraint backstops this check.
    const { agents } = await import("../db/schema.js");
    const existing = await db
      .select()
      .from(agentSurfaces)
      .where(eq(agentSurfaces.connectionId, body.connectionId));
    const otherAgent = existing.find((r) => r.agentId !== id);
    if (otherAgent) {
      const [owner] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, otherAgent.agentId))
        .limit(1);
      return reply.code(409).send({
        error: `"${connection.name}" is already the identity of ${owner?.name ?? "another agent"} . A connection hosts one agent`,
      });
    }
    if (existing.some((r) => r.label.toLowerCase() === body.label.toLowerCase())) {
      return reply.code(409).send({ error: "That surface already exists" });
    }

    const [row] = await db
      .insert(agentSurfaces)
      .values({
        agentId: id,
        connectionId: body.connectionId,
        label: body.label,
        responseMode: body.responseMode,
        dmEnabled: body.dmEnabled,
      })
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

  app.patch("/api/agents/:id/surfaces/:surfaceId", async (req, reply) => {
    const { id, surfaceId } = req.params as { id: string; surfaceId: string };
    const { updateAgentSurfaceSchema } = await import("@rabblehq/core");
    const body = updateAgentSurfaceSchema.parse(req.body);
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(id) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const { agentSurfaces } = await import("../db/schema.js");
    const changes: Partial<{ responseMode: string; dmEnabled: boolean }> = {};
    if (body.responseMode !== undefined) changes.responseMode = body.responseMode;
    if (body.dmEnabled !== undefined) changes.dmEnabled = body.dmEnabled;
    if (Object.keys(changes).length === 0) {
      return reply.code(400).send({ error: "Nothing to update" });
    }
    const [row] = await db
      .update(agentSurfaces)
      .set(changes)
      .where(and(eq(agentSurfaces.id, surfaceId), eq(agentSurfaces.agentId, id)))
      .returning();
    if (!row) return reply.code(404).send({ error: "Surface not found" });
    const summary = [
      body.responseMode !== undefined ? `response mode ${body.responseMode}` : null,
      body.dmEnabled !== undefined ? `DMs ${body.dmEnabled ? "on" : "off"}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.surface.update",
      targetType: "agent",
      targetId: id,
      summary: `Set surface ${summary}`,
    });
    return { ok: true };
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
