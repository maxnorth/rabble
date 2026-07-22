import type { FastifyInstance } from "fastify";
import {
  createMcpServerSchema,
  slugify,
  updateToolConfigSchema,
  type McpToolInfo,
} from "@rabblehq/core";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentMcpServers,
  agentToolConfigs,
  connections,
  grants,
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
import { hasRight, rightsForAllAgents, grantSubjectsFor, canUseMcpServer } from "../rights.js";
import { MCP_LIBRARY } from "../mcp/library.js";

export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

function serializeServer(
  row: typeof mcpServers.$inferSelect,
  usedByCount: number,
  donatedByName: string | null = null,
  access: { canUse: boolean; grantCount: number } = { canUse: true, grantCount: 0 },
  connectionName: string | null = null,
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
    // Connection mode: whose credential calls ride.
    connectionId: row.connectionId,
    connectionName,
    tools: (row.tools ?? []) as McpToolInfo[],
    disabledTools: (row.disabledTools ?? []) as string[],
    libraryKey: row.libraryKey,
    canUse: access.canUse,
    grantCount: access.grantCount,
    status: row.status,
    usedByCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Slugs stay unique per org, but names may repeat — an org can run several
 * copies of the same server (different tool sets, different audiences). */
async function uniqueServerSlug(orgId: string, name: string): Promise<string> {
  const base = slugify(name) || "server";
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [clash] = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.orgId, orgId), eq(mcpServers.slug, candidate)))
      .limit(1);
    if (!clash) return candidate;
  }
}

/** MCP-server access mirrors model access: with no grants anyone in the org
 * may attach the server; with grants, only grantees (and org admins). */
async function usableServerIds(user: {
  id: string;
  orgId: string;
}): Promise<{ grantCounts: Map<string, number>; reachable: Set<string> }> {
  const counted = await db
    .select({ targetId: grants.targetId, n: sql<number>`count(*)::int` })
    .from(grants)
    .where(and(eq(grants.orgId, user.orgId), eq(grants.targetType, "mcp-server")))
    .groupBy(grants.targetId);
  const grantCounts = new Map(counted.map((c) => [c.targetId, c.n]));
  let reachable = new Set<string>();
  if (grantCounts.size > 0) {
    const { userIds, teamIds } = await grantSubjectsFor(user.id, user.orgId);
    const subjectFilter = [];
    if (userIds.length) {
      subjectFilter.push(
        and(eq(grants.subjectType, "user"), inArray(grants.subjectId, userIds)),
      );
    }
    if (teamIds.length) {
      subjectFilter.push(
        and(eq(grants.subjectType, "team"), inArray(grants.subjectId, teamIds)),
      );
    }
    if (subjectFilter.length) {
      const found = await db
        .select({ targetId: grants.targetId })
        .from(grants)
        .where(
          and(
            eq(grants.orgId, user.orgId),
            eq(grants.targetType, "mcp-server"),
            or(...subjectFilter),
          ),
        );
      reachable = new Set(found.map((f) => f.targetId));
    }
  }
  return { grantCounts, reachable };
}


/** The name of the Connection a server borrows its credential from. */
async function connectionNameFor(
  row: typeof mcpServers.$inferSelect,
): Promise<string | null> {
  if (!row.connectionId) return null;
  const [conn] = await db
    .select({ name: connections.name })
    .from(connections)
    .where(eq(connections.id, row.connectionId))
    .limit(1);
  return conn?.name ?? null;
}

/** The credential to verify a server's URL with: the service credential
 * (org token, or the linked Connection's) for non-personal servers; for
 * personal servers, the calling admin's own connected credential when
 * they have one (personal servers hold no org token). */
async function verificationToken(
  server: typeof mcpServers.$inferSelect,
  userId: string,
): Promise<string | null> {
  if (server.credentialMode !== "personal") {
    const { usableServiceCredential } = await import("../mcp/oauthFlow.js");
    return usableServiceCredential(server, Date.now());
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

  // The curated library — presentation data only; adding an entry runs
  // through the normal register flow with the form prefilled.
  app.get("/api/mcp-servers/library", async () => ({ library: MCP_LIBRARY }));

  app.get("/api/mcp-servers", async (req) => {
    const isAdmin = isOrgAdmin(req.user);
    const { grantCounts, reachable } = await usableServerIds(req.user!);
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
        connectionName: sql<string | null>`(
          SELECT c.name FROM connections c WHERE c.id = mcp_servers.connection_id
        )`,
      })
      .from(mcpServers)
      .where(eq(mcpServers.orgId, req.user!.orgId))
      .orderBy(mcpServers.name);
    return {
      servers: rows.map((r) => {
        const grantCount = grantCounts.get(r.server.id) ?? 0;
        return {
          ...serializeServer(
            r.server,
            r.usedByCount,
            r.donatedByName,
            {
              canUse: isAdmin || grantCount === 0 || reachable.has(r.server.id),
              grantCount,
            },
            r.connectionName,
          ),
          usedBy: r.usedBy,
        };
      }),
    };
  });

  // Register an MCP server: connects, discovers tools, stores the catalog.
  app.post("/api/mcp-servers", async (req, reply) => {
    const body = createMcpServerSchema.parse(req.body);

    // Connection mode: the credential is borrowed from an existing
    // Connection (e.g. the Slack workspace bot) — resolve it up front and
    // use it for tool discovery.
    let connection: typeof connections.$inferSelect | null = null;
    if (body.credentialMode === "connection") {
      if (!body.connectionId) {
        return reply
          .code(400)
          .send({ error: "Pick a connection to lend its credential" });
      }
      const [row] = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, body.connectionId),
            eq(connections.orgId, req.user!.orgId),
          ),
        )
        .limit(1);
      if (!row) return reply.code(404).send({ error: "Connection not found" });
      if (!row.encryptedToken) {
        return reply.code(422).send({
          error: `The connection "${row.name}" holds no usable credential yet — finish connecting it first`,
        });
      }
      connection = row;
    }
    const discoveryToken = connection
      ? decryptSecret(connection.encryptedToken!)
      : body.token;

    let tools: McpToolInfo[] = [];
    // OAuth servers (personal mode) can't list tools until a user authorizes,
    // so a 401 here isn't a failure: discover the auth server, register a
    // client, and store that config. Tools are discovered on first connect.
    let oauth:
      | { endpoints: OAuthEndpoints; clientId: string; clientSecret?: string }
      | null = null;
    try {
      tools = await mcpListTools(body.url, discoveryToken);
    } catch (err) {
      // OAuth applies to both modes: personal servers have each user connect,
      // shared servers have one admin donate their grant as the org credential.
      if (err instanceof McpOAuthRequiredError) {
        // A connection-backed server already has its credential; a 401 means
        // the server rejected it, not that an OAuth flow should start.
        if (connection) {
          return reply.code(422).send({
            error:
              `The MCP server rejected the credential from "${connection.name}" — it requires its own sign-in.` +
              (connection.vendor === "slack"
                ? ' For Slack, pick "Slack (your workspace)" from the library instead: Rabble hosts that endpoint and it accepts your connection.'
                : ""),
          });
        }
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
    // Multiple copies of the same server are a feature (different tool
    // sets, different audiences), so the slug dedupes instead of 409ing.
    const slug = await uniqueServerSlug(req.user!.orgId, body.name);
    const [row] = await db
      .insert(mcpServers)
      .values({
        orgId: req.user!.orgId,
        slug,
        name: body.name,
        libraryKey: body.libraryKey ?? null,
        url: body.url,
        category: body.category,
        credentialMode: body.credentialMode,
        // Only shared servers hold an org credential of their own; personal
        // servers use each caller's, connection servers borrow the linked
        // Connection's.
        encryptedToken:
          body.credentialMode === "shared" && body.token
            ? encryptSecret(body.token)
            : null,
        connectionId: connection?.id ?? null,
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
      summary: `Registered MCP server "${body.name}" (${
        connection
          ? `credential from connection "${connection.name}"`
          : `${body.credentialMode} credentials`
      }, ${tools.length} tools)`,
    });
    return {
      server: serializeServer(row!, 0, null, undefined, connection?.name ?? null),
    };
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
      disabledTools?: string[];
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
    if (body.disabledTools !== undefined) {
      if (
        !Array.isArray(body.disabledTools) ||
        body.disabledTools.some((t) => typeof t !== "string")
      ) {
        return reply.code(400).send({ error: "disabledTools must be a list of tool names" });
      }
      // Only names the server actually has — a stale or mistyped name would
      // sit invisibly forever.
      const known = new Set(
        ((server.tools ?? []) as McpToolInfo[]).map((t) => t.name),
      );
      updates.disabledTools = [...new Set(body.disabledTools)].filter((t) =>
        known.has(t),
      );
    }
    if (body.token !== undefined) {
      if (server.credentialMode === "personal" && body.token !== null) {
        return reply.code(400).send({
          error:
            "This server uses personal credentials. Connect your own under Profile, Connected accounts.",
        });
      }
      if (server.credentialMode === "connection") {
        return reply.code(400).send({
          error:
            "This server borrows its credential from a connection — manage it under Admin, Connections.",
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
    const summaryParts = changed.map((k) =>
      k === "encryptedToken"
        ? "token"
        : k === "disabledTools"
          ? `disabled tools (${(updates.disabledTools as string[]).length} off)`
          : k,
    );
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.update",
      targetType: "mcp-server",
      targetId: id,
      summary: `Updated ${summaryParts.join(", ")} on MCP server "${row!.name}"`,
    });
    const [usedBy] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentMcpServers)
      .where(eq(agentMcpServers.serverId, id));
    return {
      server: serializeServer(
        row!,
        usedBy?.n ?? 0,
        null,
        undefined,
        await connectionNameFor(row!),
      ),
    };
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
      return {
        server: serializeServer(row!, 0, null, undefined, await connectionNameFor(row!)),
      };
    } catch {
      await db.update(mcpServers).set({ status: "error" }).where(eq(mcpServers.id, id));
      return reply.code(422).send({ error: "Couldn't reach the MCP server" });
    }
  });

  // Duplicate: a copy with the same endpoint/config but its own identity —
  // give one team a narrow tool set and another the full one. App-level
  // OAuth client config carries over (it's app config, not a credential);
  // org tokens and donated grants do NOT.
  app.post("/api/mcp-servers/:id/duplicate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [source] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.orgId, req.user!.orgId)))
      .limit(1);
    if (!source) return reply.code(404).send({ error: "Server not found" });
    const name = `${source.name} (copy)`;
    const [row] = await db
      .insert(mcpServers)
      .values({
        orgId: source.orgId,
        slug: await uniqueServerSlug(source.orgId, name),
        name,
        url: source.url,
        category: source.category,
        credentialMode: source.credentialMode,
        // A connection reference is config (a pointer), not a copied secret.
        connectionId: source.connectionId,
        oauthConfig: source.oauthConfig,
        encryptedOauthClientSecret: source.encryptedOauthClientSecret,
        tools: source.tools,
        disabledTools: source.disabledTools,
        libraryKey: source.libraryKey,
        status: source.status,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.register",
      targetType: "mcp-server",
      targetId: row!.id,
      summary: `Duplicated MCP server "${source.name}" as "${name}"`,
    });
    return {
      server: serializeServer(row!, 0, null, undefined, await connectionNameFor(row!)),
    };
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
    // Access scope: a granted server may only be attached by its grantees
    // (org admins always can). Same semantics as model access — and the
    // same shared check the Builder's attach tool runs.
    if (!(await canUseMcpServer(req.user!, serverId))) {
      return reply.code(403).send({
        error:
          "This MCP server is restricted. Ask an org admin for access, or request it from the server's page.",
      });
    }
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
