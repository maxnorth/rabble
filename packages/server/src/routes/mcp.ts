import type { FastifyInstance } from "fastify";
import {
  createMcpServerSchema,
  slugify,
  updateToolConfigSchema,
  type McpToolInfo,
} from "@rabblehq/core";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentMcpServers,
  agentToolConfigs,
  mcpServers,
} from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { mcpListTools } from "../mcp/client.js";
import { hasRight, rightsForAllAgents } from "../rights.js";

function serializeServer(
  row: typeof mcpServers.$inferSelect,
  usedByCount: number,
) {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    name: row.name,
    url: row.url,
    category: row.category,
    hasToken: row.encryptedToken !== null,
    tools: (row.tools ?? []) as McpToolInfo[],
    status: row.status,
    usedByCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function mcpRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/mcp-servers", async (req) => {
    const rows = await db
      .select({
        server: mcpServers,
        usedByCount: sql<number>`(SELECT count(*)::int FROM agent_mcp_servers a WHERE a.server_id = mcp_servers.id)`,
        usedBy: sql<Array<{ id: string; name: string }>>`coalesce(
          (SELECT jsonb_agg(jsonb_build_object('id', ag.id, 'name', ag.name) ORDER BY ag.name)
           FROM agent_mcp_servers ams JOIN agents ag ON ag.id = ams.agent_id
           WHERE ams.server_id = mcp_servers.id),
          '[]'::jsonb
        )`,
      })
      .from(mcpServers)
      .where(eq(mcpServers.orgId, req.user!.orgId))
      .orderBy(mcpServers.name);
    return {
      servers: rows.map((r) => ({
        ...serializeServer(r.server, r.usedByCount),
        usedBy: r.usedBy,
      })),
    };
  });

  // Register an MCP server: connects, discovers tools, stores the catalog.
  app.post("/api/mcp-servers", async (req, reply) => {
    const body = createMcpServerSchema.parse(req.body);
    let tools: McpToolInfo[];
    try {
      tools = await mcpListTools(body.url, body.token);
    } catch (err) {
      return reply.code(422).send({
        error: `Couldn't reach the MCP server: ${err instanceof Error ? err.message : "unknown error"}`,
      });
    }
    const slug = slugify(body.name) || "server";
    const [existing] = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.orgId, req.user!.orgId), eq(mcpServers.slug, slug)))
      .limit(1);
    if (existing) {
      return reply.code(409).send({ error: "A server with that name already exists" });
    }
    const [row] = await db
      .insert(mcpServers)
      .values({
        orgId: req.user!.orgId,
        slug,
        name: body.name,
        url: body.url,
        category: body.category,
        encryptedToken: body.token ? encryptSecret(body.token) : null,
        tools,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.register",
      targetType: "mcp-server",
      targetId: row!.id,
      summary: `Registered MCP server "${body.name}" (${tools.length} tools)`,
    });
    return { server: serializeServer(row!, 0) };
  });

  // Re-discover the tool list
  app.post("/api/mcp-servers/:id/refresh", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [server] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.orgId, req.user!.orgId)))
      .limit(1);
    if (!server) return reply.code(404).send({ error: "Server not found" });
    try {
      const tools = await mcpListTools(
        server.url,
        server.encryptedToken ? decryptSecret(server.encryptedToken) : null,
      );
      const [row] = await db
        .update(mcpServers)
        .set({ tools, status: "connected" })
        .where(eq(mcpServers.id, id))
        .returning();
      return { server: serializeServer(row!, 0) };
    } catch {
      await db.update(mcpServers).set({ status: "error" }).where(eq(mcpServers.id, id));
      return reply.code(422).send({ error: "Couldn't reach the MCP server" });
    }
  });

  app.delete("/api/mcp-servers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db
      .delete(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.orgId, req.user!.orgId)))
      .returning({ name: mcpServers.name });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: "Server not found" });
    }
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.remove",
      targetType: "mcp-server",
      targetId: id,
      summary: `Removed MCP server "${deleted[0]!.name}"`,
    });
    return { ok: true };
  });

  // --- per-agent attachment & tool config ---

  app.put("/api/agents/:agentId/mcp-servers/:serverId", async (req, reply) => {
    const { agentId, serverId } = req.params as { agentId: string; serverId: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(agentId) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const [server] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.orgId, req.user!.orgId)))
      .limit(1);
    if (!server) return reply.code(404).send({ error: "Server not found" });
    await db
      .insert(agentMcpServers)
      .values({ agentId, serverId })
      .onConflictDoNothing();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.mcp.attach",
      targetType: "agent",
      targetId: agentId,
      summary: `Attached MCP server "${server.name}"`,
    });
    return { ok: true };
  });

  app.delete("/api/agents/:agentId/mcp-servers/:serverId", async (req, reply) => {
    const { agentId, serverId } = req.params as { agentId: string; serverId: string };
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(agentId) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    await db
      .delete(agentMcpServers)
      .where(
        and(
          eq(agentMcpServers.agentId, agentId),
          eq(agentMcpServers.serverId, serverId),
        ),
      );
    await db
      .delete(agentToolConfigs)
      .where(
        and(
          eq(agentToolConfigs.agentId, agentId),
          eq(agentToolConfigs.serverId, serverId),
        ),
      );
    return { ok: true };
  });

  app.patch("/api/agents/:agentId/tools", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const body = updateToolConfigSchema.parse(req.body);
    const rights = await rightsForAllAgents(req.user!);
    if (!hasRight(rights.get(agentId) ?? null, "edit")) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const values = {
      agentId,
      serverId: body.serverId,
      toolName: body.toolName,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.authType !== undefined ? { authType: body.authType } : {}),
    };
    await db
      .insert(agentToolConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [
          agentToolConfigs.agentId,
          agentToolConfigs.serverId,
          agentToolConfigs.toolName,
        ],
        set: {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.authType !== undefined ? { authType: body.authType } : {}),
        },
      });
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "agent.tool.configure",
      targetType: "agent",
      targetId: agentId,
      summary: `Configured tool "${body.toolName}"`,
      metadata: { ...body },
    });
    return { ok: true };
  });
}
