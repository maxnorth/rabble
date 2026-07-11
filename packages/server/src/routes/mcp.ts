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
import { requireUser, isOrgAdmin } from "../auth.js";
import { recordAudit } from "../audit.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { mcpListTools, McpOAuthRequiredError } from "../mcp/client.js";
import {
  discoverOAuth,
  registerOAuthClient,
  type OAuthEndpoints,
} from "../mcp/oauth.js";
import { publicBaseUrl } from "../publicUrl.js";
import { hasRight, rightsForAllAgents } from "../rights.js";

export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

function serializeServer(
  row: typeof mcpServers.$inferSelect,
  usedByCount: number,
  donatedByName: string | null = null,
) {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    name: row.name,
    url: row.url,
    category: row.category,
    credentialMode: row.credentialMode,
    requiresOAuth: row.oauthConfig !== null,
    hasToken: row.encryptedToken !== null,
    // For a shared OAuth server: whether an org grant has been donated, and by
    // whom (transparency — the org's access is really this person's account).
    donatedByName,
    tools: (row.tools ?? []) as McpToolInfo[],
    status: row.status,
    usedByCount,
    createdAt: row.createdAt.toISOString(),
  };
}


/** The credential to verify a server's URL with: the org token for shared
 * servers; for personal servers, the calling admin's own connected
 * credential when they have one (personal servers hold no org token). */
async function verificationToken(
  server: typeof mcpServers.$inferSelect,
  userId: string,
): Promise<string | null> {
  if (server.credentialMode !== "personal") {
    return server.encryptedToken ? decryptSecret(server.encryptedToken) : null;
  }
  const { userMcpCredentials } = await import("../db/schema.js");
  const [cred] = await db
    .select()
    .from(userMcpCredentials)
    .where(
      and(
        eq(userMcpCredentials.userId, userId),
        eq(userMcpCredentials.serverId, server.id),
      ),
    )
    .limit(1);
  return cred ? decryptSecret(cred.encryptedToken) : null;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  // Org-level MCP servers are shared and secret-bearing: registering,
  // re-testing, or deleting them is org-admin territory. Per-agent attach/
  // tool-config routes (/api/agents/...) stay gated on agent `edit` below.
  app.addHook("preHandler", async (req, reply) => {
    if (
      req.method !== "GET" &&
      (req.url.split("?")[0] ?? "").startsWith("/api/mcp-servers") &&
      !isOrgAdmin(req.user)
    ) {
      return reply.code(403).send({ error: "Org admin access required" });
    }
  });

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
        donatedByName: sql<string | null>`(
          SELECT u.name FROM users u WHERE u.id = mcp_servers.donated_by_user_id
        )`,
      })
      .from(mcpServers)
      .where(eq(mcpServers.orgId, req.user!.orgId))
      .orderBy(mcpServers.name);
    return {
      servers: rows.map((r) => ({
        ...serializeServer(r.server, r.usedByCount, r.donatedByName),
        usedBy: r.usedBy,
      })),
    };
  });

  // Register an MCP server: connects, discovers tools, stores the catalog.
  app.post("/api/mcp-servers", async (req, reply) => {
    const body = createMcpServerSchema.parse(req.body);
    let tools: McpToolInfo[] = [];
    // OAuth servers (personal mode) can't list tools until a user authorizes,
    // so a 401 here isn't a failure: discover the auth server, register a
    // client, and store that config. Tools are discovered on first connect.
    let oauth:
      | { endpoints: OAuthEndpoints; clientId: string; clientSecret?: string }
      | null = null;
    try {
      tools = await mcpListTools(body.url, body.token);
    } catch (err) {
      // OAuth applies to both modes: personal servers have each user connect,
      // shared servers have one admin donate their grant as the org credential.
      if (err instanceof McpOAuthRequiredError) {
        if (!err.resourceMetadataUrl) {
          return reply.code(422).send({
            error: "The server requires OAuth but advertised no metadata URL",
          });
        }
        try {
          const endpoints = await discoverOAuth(err.resourceMetadataUrl);
          const redirectUri = `${publicBaseUrl(req)}${MCP_OAUTH_CALLBACK_PATH}`;
          if (!endpoints.registrationEndpoint) {
            return reply.code(422).send({
              error: "The authorization server doesn't support dynamic client registration",
            });
          }
          const client = await registerOAuthClient(
            endpoints.registrationEndpoint,
            redirectUri,
          );
          oauth = { endpoints, clientId: client.clientId, clientSecret: client.clientSecret };
        } catch (e) {
          return reply.code(422).send({
            error: `OAuth setup failed: ${e instanceof Error ? e.message : "unknown error"}`,
          });
        }
      } else {
        return reply.code(422).send({
          error: `Couldn't reach the MCP server: ${err instanceof Error ? err.message : "unknown error"}`,
        });
      }
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
        credentialMode: body.credentialMode,
        // Personal-mode servers hold no org credential; each user connects
        // their own under Profile.
        encryptedToken:
          body.credentialMode === "shared" && body.token
            ? encryptSecret(body.token)
            : null,
        oauthConfig: oauth
          ? { ...oauth.endpoints, clientId: oauth.clientId }
          : null,
        encryptedOauthClientSecret: oauth?.clientSecret
          ? encryptSecret(oauth.clientSecret)
          : null,
        tools,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.register",
      targetType: "mcp-server",
      targetId: row!.id,
      summary: `Registered MCP server "${body.name}" (${body.credentialMode} credentials, ${tools.length} tools)`,
    });
    return { server: serializeServer(row!, 0) };
  });

  // Shared OAuth donation: an admin completes the authorize flow and the
  // resulting grant becomes the org credential. Admin-gated (POST on
  // /api/mcp-servers is), and the shared branch of the callback stores it
  // org-level. Returns the authorize URL for the client to open.
  app.post("/api/mcp-servers/:id/oauth/donate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [server] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.orgId, req.user!.orgId)))
      .limit(1);
    if (!server) return reply.code(404).send({ error: "Server not found" });
    if (server.credentialMode !== "shared") {
      return reply.code(400).send({ error: "Only shared servers take a donated org account" });
    }
    const { serverOAuth } = await import("../mcp/oauthFlow.js");
    const oauth = serverOAuth(server);
    if (!oauth) return reply.code(400).send({ error: "This server doesn't use OAuth" });

    const { makePkce, authorizeUrl } = await import("../mcp/oauth.js");
    const { randomUUID } = await import("node:crypto");
    const { mcpOauthPending } = await import("../db/schema.js");
    const { verifier, challenge } = makePkce();
    const state = randomUUID();
    await db.insert(mcpOauthPending).values({
      state,
      userId: req.user!.id,
      serverId: id,
      codeVerifier: verifier,
    });
    const url = authorizeUrl({
      endpoints: oauth.endpoints,
      client: oauth.client,
      redirectUri: `${publicBaseUrl(req)}${MCP_OAUTH_CALLBACK_PATH}`,
      state,
      challenge,
    });
    return { authorizeUrl: url };
  });

  // Edit in place — registered servers aren't one-way doors. Changing the
  // URL (or token) re-discovers the tool list against the new endpoint
  // before anything is saved, so a typo can't silently strand the agents
  // using it. Token is tri-state: omit = keep, string = replace, null =
  // clear. The slug stays stable (attachments key on ids).
  app.patch("/api/mcp-servers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      name?: string;
      url?: string;
      category?: string;
      token?: string | null;
    };
    const [server] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.orgId, req.user!.orgId)))
      .limit(1);
    if (!server) return reply.code(404).send({ error: "Server not found" });

    const updates: Partial<typeof mcpServers.$inferInsert> = {};
    if (body.name !== undefined) {
      const trimmed = body.name.trim();
      if (!trimmed) return reply.code(400).send({ error: "A name is required" });
      updates.name = trimmed;
    }
    if (body.category !== undefined) updates.category = body.category;
    if (body.token !== undefined) {
      if (server.credentialMode === "personal" && body.token !== null) {
        return reply.code(400).send({
          error:
            "This server uses personal credentials. Connect your own under Profile, Connected accounts.",
        });
      }
      updates.encryptedToken = body.token === null ? null : encryptSecret(body.token);
    }

    const url = body.url !== undefined ? body.url : server.url;
    const tokenForCheck =
      body.token !== undefined
        ? body.token
        : await verificationToken(server, req.user!.id);
    if (body.url !== undefined || body.token !== undefined) {
      try {
        updates.tools = await mcpListTools(url, tokenForCheck);
        updates.url = url;
        updates.status = "connected";
      } catch (err) {
        return reply.code(422).send({
          error: `Couldn't reach the MCP server at that URL: ${err instanceof Error ? err.message : "unknown error"}`,
        });
      }
    }
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "Nothing to update" });
    }

    const [row] = await db
      .update(mcpServers)
      .set(updates)
      .where(eq(mcpServers.id, id))
      .returning();
    const changed = Object.keys(updates).filter((k) => k !== "tools" && k !== "status");
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.update",
      targetType: "mcp-server",
      targetId: id,
      summary: `Updated ${changed.map((k) => (k === "encryptedToken" ? "token" : k)).join(", ")} on MCP server "${row!.name}"`,
    });
    const [usedBy] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentMcpServers)
      .where(eq(agentMcpServers.serverId, id));
    return { server: serializeServer(row!, usedBy?.n ?? 0) };
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
        await verificationToken(server, req.user!.id),
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
