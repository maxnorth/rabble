/**
 * Profile: personal connected accounts (credentials used when an agent acts
 * "as you") and agent preferences (approval posture, response style).
 */
import type { FastifyInstance } from "fastify";
import { userPreferencesSchema } from "@rabblehq/core";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userConnectedAccounts, users,
  userMcpCredentials,
  mcpServers,
} from "../db/schema.js";
import { requireUser } from "../auth.js";
import { encryptSecret } from "../crypto.js";
import { recordAudit } from "../audit.js";

export async function profileRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/profile/accounts", async (req) => {
    const rows = await db
      .select()
      .from(userConnectedAccounts)
      .where(eq(userConnectedAccounts.userId, req.user!.id))
      .orderBy(userConnectedAccounts.vendor);
    return {
      accounts: rows.map((a) => ({
        id: a.id,
        vendor: a.vendor,
        label: a.label,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });

  app.put("/api/profile/accounts", async (req, reply) => {
    const { vendor, label, token } = req.body as {
      vendor: string;
      label?: string;
      token: string;
    };
    if (!vendor?.trim() || !token?.trim()) {
      return reply.code(400).send({ error: "Vendor and token are required" });
    }
    await db
      .insert(userConnectedAccounts)
      .values({
        userId: req.user!.id,
        vendor: vendor.trim().toLowerCase(),
        label: label?.trim() ?? "",
        encryptedToken: encryptSecret(token),
      })
      .onConflictDoUpdate({
        target: [userConnectedAccounts.userId, userConnectedAccounts.vendor],
        set: {
          label: label?.trim() ?? "",
          encryptedToken: encryptSecret(token),
        },
      });
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "profile.account.connect",
      targetType: "user",
      targetId: req.user!.id,
      summary: `Connected personal ${vendor.trim()} account`,
    });
    return { ok: true };
  });

  app.delete("/api/profile/accounts/:vendor", async (req) => {
    const { vendor } = req.params as { vendor: string };
    const removed = await db
      .delete(userConnectedAccounts)
      .where(
        and(
          eq(userConnectedAccounts.userId, req.user!.id),
          eq(userConnectedAccounts.vendor, vendor),
        ),
      )
      .returning({ id: userConnectedAccounts.id });
    // Symmetric with connect: removing a credential that let an agent act as
    // this user is a governance event, so it belongs in the record too.
    if (removed.length > 0) {
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "profile.account.disconnect",
        targetType: "user",
        targetId: req.user!.id,
        summary: `Disconnected personal ${vendor} account`,
      });
    }
    return { ok: true };
  });

  app.get("/api/profile/preferences", async (req) => {
    return {
      preferences: userPreferencesSchema.parse({
        ...(req.user!.preferences as Record<string, unknown>),
      }),
    };
  });

  app.put("/api/profile/preferences", async (req) => {
    const preferences = userPreferencesSchema.parse(req.body);
    const prior = userPreferencesSchema.parse({
      ...(req.user!.preferences as Record<string, unknown>),
    });
    await db
      .update(users)
      .set({ preferences })
      .where(eq(users.id, req.user!.id));
    // Approval posture is a governance control (it decides when user-auth
    // tools auto-approve), so a change to it is audited — response-style tweaks
    // are not, to keep the log signal-dense.
    if (preferences.approvalPosture !== prior.approvalPosture) {
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "profile.posture",
        targetType: "user",
        targetId: req.user!.id,
        summary: `Set approval posture to "${preferences.approvalPosture}"`,
        metadata: { from: prior.approvalPosture, to: preferences.approvalPosture },
      });
    }
    return { preferences };
  });

  // --- Personal MCP credentials (personal-credential servers) ---

  app.get("/api/profile/mcp-credentials", async (req) => {
    const { eq: eq2 } = await import("drizzle-orm");
    const rows = await db
      .select({ cred: userMcpCredentials, server: mcpServers })
      .from(userMcpCredentials)
      .innerJoin(mcpServers, eq2(userMcpCredentials.serverId, mcpServers.id))
      .where(eq2(userMcpCredentials.userId, req.user!.id));
    return {
      credentials: rows
        .filter((r) => r.server.orgId === req.user!.orgId)
        .map((r) => ({
          serverId: r.server.id,
          serverName: r.server.name,
          connectedAt: r.cred.createdAt.toISOString(),
        })),
    };
  });

  // Begin the OAuth authorize flow for a personal OAuth server: mint PKCE +
  // state, stash them, and hand back the authorize URL for the client to open.
  app.post("/api/profile/mcp-credentials/:serverId/oauth/start", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const [server] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.orgId, req.user!.orgId)))
      .limit(1);
    if (!server) return reply.code(404).send({ error: "Server not found" });
    // Personal connect only. A shared server's org grant is donated through
    // the admin-gated /api/mcp-servers/:id/oauth/donate route — otherwise this
    // public route would let any member store an org-wide credential.
    if (server.credentialMode !== "personal") {
      return reply.code(400).send({ error: "This server uses a shared org credential" });
    }
    const { serverOAuth } = await import("../mcp/oauthFlow.js");
    const oauth = serverOAuth(server);
    if (!oauth) return reply.code(400).send({ error: "This server doesn't use OAuth" });

    const { makePkce, authorizeUrl } = await import("../mcp/oauth.js");
    const { randomUUID } = await import("node:crypto");
    const { mcpOauthPending } = await import("../db/schema.js");
    const { publicBaseUrl } = await import("../publicUrl.js");
    const { MCP_OAUTH_CALLBACK_PATH } = await import("./mcp.js");
    const { verifier, challenge } = makePkce();
    const state = randomUUID();
    await db.insert(mcpOauthPending).values({
      state,
      userId: req.user!.id,
      serverId,
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

  // The OAuth callback lives in the PUBLIC route scope (inbound.ts), not here:
  // the redirect back from an external authorization server is a cross-site
  // navigation that can't be relied on to carry the session cookie, so it is
  // authenticated by the single-use `state` nonce instead of requireUser.

  app.put("/api/profile/mcp-credentials/:serverId", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const { token } = (req.body ?? {}) as { token?: string };
    if (!token?.trim()) return reply.code(400).send({ error: "A token is required" });
    const { and: and2, eq: eq2 } = await import("drizzle-orm");
    const [server] = await db
      .select()
      .from(mcpServers)
      .where(and2(eq2(mcpServers.id, serverId), eq2(mcpServers.orgId, req.user!.orgId)))
      .limit(1);
    if (!server) return reply.code(404).send({ error: "Server not found" });
    if (server.credentialMode !== "personal") {
      return reply.code(400).send({ error: "This server uses a shared org credential" });
    }
    // Verify the credential actually works before storing it.
    const { mcpListTools } = await import("../mcp/client.js");
    try {
      await mcpListTools(server.url, token.trim());
    } catch (err) {
      return reply.code(422).send({
        error: `The token didn't work against ${server.name}: ${err instanceof Error ? err.message : "unknown error"}`,
      });
    }
    const { encryptSecret } = await import("../crypto.js");
    await db
      .insert(userMcpCredentials)
      .values({
        userId: req.user!.id,
        serverId,
        encryptedToken: encryptSecret(token.trim()),
      })
      .onConflictDoUpdate({
        target: [userMcpCredentials.userId, userMcpCredentials.serverId],
        set: { encryptedToken: encryptSecret(token.trim()) },
      });
    // Release any agent turn paused on a connect card for this server.
    const { resolveConnects } = await import("../runtime/approvals.js");
    resolveConnects(req.user!.id, serverId);
    const { recordAudit } = await import("../audit.js");
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.credential.connect",
      targetType: "mcp-server",
      targetId: serverId,
      summary: `Connected a personal credential for "${server.name}"`,
    });
    return { ok: true };
  });

  app.delete("/api/profile/mcp-credentials/:serverId", async (req) => {
    const { serverId } = req.params as { serverId: string };
    const { and: and2, eq: eq2 } = await import("drizzle-orm");
    await db
      .delete(userMcpCredentials)
      .where(
        and2(
          eq2(userMcpCredentials.userId, req.user!.id),
          eq2(userMcpCredentials.serverId, serverId),
        ),
      );
    const { recordAudit } = await import("../audit.js");
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "mcp.credential.disconnect",
      targetType: "mcp-server",
      targetId: serverId,
      summary: "Disconnected a personal MCP credential",
    });
    return { ok: true };
  });
}
