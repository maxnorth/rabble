/**
 * Inbound surface delivery. Slack Events API webhooks become governed
 * sessions: a message in a channel mapped to an agent surface starts (or
 * continues) a session for the matching platform user, runs a real agent
 * turn, and threads the reply back via chat.postMessage.
 *
 * Authentication follows Slack's signing convention: the connection stores
 * the app's signing secret and every request is verified with
 * v0=HMAC_SHA256(secret, "v0:{timestamp}:{rawBody}").
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentSurfaces,
  agents,
  connections,
  mcpOauthPending,
  mcpServers,
  models,
  sessions,
  users,
} from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { env } from "../env.js";
import { executeTurnAndPersist } from "../runtime/executeTurn.js";
import {
  alreadyDelivered,
  processSlackEvent,
  processSlackInteraction,
  slackDiag,
  type SlackEventEnvelope,
  type SlackInteractionPayload,
} from "../surfaces/slack.js";

export function verifySlackSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function inboundRoutes(app: FastifyInstance) {
  // Signature verification needs the raw body — parse JSON ourselves.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );

    /**
     * GitHub surface delivery: an issue comment in a repo mapped to an
     * agent surface becomes a governed session (issue = session), and the
     * agent's reply is posted back as a comment. The commenter is resolved
     * to a platform user through their connected GitHub account.
     */
    scope.post("/api/inbound/github", async (req, reply) => {
      const rawBody = req.body as string;
      const signature = String(req.headers["x-hub-signature-256"] ?? "");
      const deliveryId = String(req.headers["x-github-delivery"] ?? "");
      const eventName = String(req.headers["x-github-event"] ?? "");

      const candidates = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.vendor, "github"),
            isNotNull(connections.encryptedSigningSecret),
          ),
        );
      const connection = candidates.find((c) => {
        try {
          const secret = decryptSecret(c.encryptedSigningSecret!);
          return verifyGithubSignature(secret, rawBody, signature);
        } catch {
          return false;
        }
      });
      if (!connection) {
        return reply.code(401).send({ error: "Signature verification failed" });
      }

      if (eventName === "ping") return { ok: true };
      // Issue comments and PR conversation comments both arrive as
      // issue_comment; inline code-review comments arrive as
      // pull_request_review_comment (a distinct payload + threaded reply).
      const isReviewComment = eventName === "pull_request_review_comment";
      if (eventName !== "issue_comment" && !isReviewComment) {
        return { ok: true, ignored: "unsupported event" };
      }
      if (await alreadyDelivered(deliveryId ? `gh:${deliveryId}` : undefined)) {
        return { ok: true, ignored: "duplicate delivery" };
      }

      let payload: {
        action?: string;
        repository?: { full_name?: string };
        issue?: { number?: number; title?: string };
        pull_request?: { number?: number; title?: string };
        comment?: {
          id?: number;
          in_reply_to_id?: number;
          body?: string;
          path?: string;
          line?: number;
          user?: { login?: string; type?: string };
        };
      };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }

      const fullName = payload.repository?.full_name ?? "";
      const number = isReviewComment
        ? payload.pull_request?.number
        : payload.issue?.number;
      const title = (
        isReviewComment ? payload.pull_request?.title : payload.issue?.title
      )?.trim();
      const body = payload.comment?.body?.trim() ?? "";
      const login = payload.comment?.user?.login ?? "";
      if (
        payload.action !== "created" ||
        payload.comment?.user?.type === "Bot" ||
        !fullName ||
        // The number flows into the reply URL path — require a real positive
        // integer, never a coincidentally-truthy string, even from a signed
        // payload (defense in depth for a governed surface).
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number <= 0 ||
        !body ||
        !login
      ) {
        return { ok: true, ignored: "not a user comment" };
      }
      // A review comment is anchored to a file/line — hand that context to
      // the agent so it can answer about the actual code, not just the text.
      const agentContent =
        isReviewComment && payload.comment?.path
          ? `On \`${payload.comment.path}\`` +
            (payload.comment.line ? ` line ${payload.comment.line}` : "") +
            `:\n\n${body}`
          : body;
      // A review thread is one conversation: key it on the thread's root
      // comment so every reply continues the same session. Coerce to a safe
      // non-negative integer since it also lands in the reply URL path.
      const rawRoot = payload.comment?.in_reply_to_id ?? payload.comment?.id ?? 0;
      const threadRootId =
        typeof rawRoot === "number" && Number.isInteger(rawRoot) && rawRoot > 0
          ? rawRoot
          : 0;

      // Which agent listens on this repo?
      const surfaceRows = await db
        .select({ surface: agentSurfaces, agent: agents })
        .from(agentSurfaces)
        .innerJoin(agents, eq(agentSurfaces.agentId, agents.id))
        .where(eq(agentSurfaces.connectionId, connection.id));
      const matched = surfaceRows.find(
        (r) => r.surface.label.toLowerCase() === fullName.toLowerCase(),
      );
      if (!matched) return { ok: true, ignored: "no agent on this repo" };

      const baseUrl = connection.baseUrl ?? "https://api.github.com";
      const token = connection.encryptedToken
        ? decryptSecret(connection.encryptedToken)
        : "";
      // Review comments reply into their thread; issue/PR conversation
      // comments post to the issue comment list.
      const replyPath = isReviewComment
        ? `/repos/${fullName}/pulls/${number}/comments/${threadRootId}/replies`
        : `/repos/${fullName}/issues/${number}/comments`;
      const postComment = (text: string) =>
        fetch(`${baseUrl}${replyPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ body: text }),
        });

      // Sessions belong to people: the commenter's connected GitHub
      // account (Profile › Connected accounts) is the identity bridge.
      const { userConnectedAccounts } = await import("../db/schema.js");
      const [platformUser] = await db
        .select({ user: users })
        .from(userConnectedAccounts)
        .innerJoin(users, eq(userConnectedAccounts.userId, users.id))
        .where(
          and(
            eq(userConnectedAccounts.vendor, "github"),
            sql`lower(${userConnectedAccounts.label}) = ${login.toLowerCase()}`,
            eq(users.orgId, connection.orgId),
          ),
        )
        .limit(1);
      if (!platformUser) {
        await postComment(
          `@${login} I can only act for Rabble users. Connect your GitHub ` +
            "account under Profile › Connected accounts and try again.",
        );
        return { ok: true, ignored: "no matching platform user" };
      }

      // One thread = one session. A review thread is a distinct surface from
      // the PR's conversation, so it gets its own key.
      const surfaceKey = isReviewComment
        ? `github-review:${fullName.toLowerCase()}#${number}#${threadRootId}`
        : `github:${fullName.toLowerCase()}#${number}`;
      const surfaceLabel = isReviewComment
        ? `GitHub ${fullName}#${number} (review)`
        : `GitHub ${fullName}#${number}`;
      // Scope to the connection's org: surface_key isn't globally unique, so a
      // repo mapped in two orgs must not attach this turn to the other org's
      // session.
      let [session] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.surfaceKey, surfaceKey),
            eq(sessions.orgId, connection.orgId),
          ),
        )
        .limit(1);
      if (!session) {
        const sessionTitle = title || `${fullName}#${number}`;
        [session] = await db
          .insert(sessions)
          .values({
            orgId: connection.orgId,
            userId: platformUser.user.id,
            agentId: matched.agent.id,
            title:
              sessionTitle.length > 60
                ? `${sessionTitle.slice(0, 57)}…`
                : sessionTitle,
            surface: surfaceLabel,
            surfaceKey,
          })
          .returning();
      }

      const [model] = matched.agent.modelId
        ? await db
            .select()
            .from(models)
            .where(eq(models.id, matched.agent.modelId))
            .limit(1)
        : [];
      const { orgs } = await import("../db/schema.js");
      const { orgSettingsSchema } = await import("@rabblehq/core");
      const [org] = await db
        .select({ settings: orgs.settings })
        .from(orgs)
        .where(eq(orgs.id, connection.orgId))
        .limit(1);
      const orgSettings = orgSettingsSchema.parse({ ...(org?.settings as object) });

      let fullText = "";
      try {
        const result = await executeTurnAndPersist({
          sessionId: session!.id,
          agent: matched.agent,
          model,
          user: platformUser.user,
          content: agentContent,
          requireApproval: orgSettings.requireApprovalForUserTools,
          sessionApproved: false,
          interactive: false,
          // Asks pend (web card) and go out as Slack DM buttons when the
          // org has a Slack connection — same broker either way.
          approvalPrompt: async (ask) => {
            const { sendSlackApprovalPrompt } = await import("../runtime/notify.js");
            await sendSlackApprovalPrompt({
              user: platformUser.user,
              sessionId: session!.id,
              surface: session!.surface,
              agentName: matched.agent.name,
              ask,
            });
          },
        });
        fullText = result.fullText;
      } catch (err) {
        req.log.error({ err }, "github surface turn failed");
        await postComment(
          "Something went wrong running the agent. Check the session in Rabble.",
        );
        return { ok: true, error: "turn failed" };
      }

      await postComment(fullText || "(no reply)");

      // The commenter probably isn't watching Rabble — offer the DM ping.
      const { notifyBackgroundReply } = await import("../runtime/notify.js");
      void notifyBackgroundReply({
        user: platformUser.user,
        sessionId: session!.id,
        surface: session!.surface,
        agentName: matched.agent.name,
        replyPreview: fullText,
      });

      return { ok: true, sessionId: session!.id };
    });

    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );

    /**
     * Slack interactivity: Approve/Deny button clicks from the approval DM.
     * Signed like events; the broker only accepts the decision from the
     * platform user the approval belongs to.
     */
    scope.post("/api/inbound/slack-interactive", async (req, reply) => {
      const rawBody = req.body as string;
      const timestamp = String(req.headers["x-slack-request-timestamp"] ?? "");
      const signature = String(req.headers["x-slack-signature"] ?? "");
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!timestamp || Number.isNaN(age) || age > 300) {
        return reply.code(401).send({ error: "Stale or missing timestamp" });
      }
      const candidates = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.vendor, "slack"),
            isNotNull(connections.encryptedSigningSecret),
          ),
        );
      const connection = candidates.find((c) => {
        try {
          return verifySlackSignature(
            decryptSecret(c.encryptedSigningSecret!),
            timestamp,
            rawBody,
            signature,
          );
        } catch {
          return false;
        }
      });
      if (!connection) {
        return reply.code(401).send({ error: "Signature verification failed" });
      }

      let payload: SlackInteractionPayload;
      try {
        payload = JSON.parse(
          new URLSearchParams(rawBody).get("payload") ?? "{}",
        ) as SlackInteractionPayload;
      } catch {
        return reply.code(400).send({ error: "Invalid payload" });
      }
      const result = await processSlackInteraction(connection, payload);
      if (result.ok === false) {
        return reply.code(400).send({ error: result.error });
      }
      return result;
    });

    scope.post("/api/inbound/slack", async (req, reply) => {
      const rawBody = req.body as string;
      const timestamp = String(req.headers["x-slack-request-timestamp"] ?? "");
      const signature = String(req.headers["x-slack-signature"] ?? "");

      slackDiag(req.log, "inbound webhook received", {
        ip: req.ip,
        timestamp,
        hasSignature: Boolean(signature),
        bodyPreview: typeof rawBody === "string" ? rawBody.slice(0, 200) : typeof rawBody,
      });

      // Replay window: Slack recommends rejecting anything older than 5 min.
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!timestamp || Number.isNaN(age) || age > 300) {
        slackDiag(req.log, "inbound rejected: stale/missing timestamp", { timestamp, age });
        return reply.code(401).send({ error: "Stale or missing timestamp" });
      }

      // Identify the connection whose signing secret validates the request.
      const candidates = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.vendor, "slack"),
            isNotNull(connections.encryptedSigningSecret),
          ),
        );
      const connection = candidates.find((c) => {
        try {
          const secret = decryptSecret(c.encryptedSigningSecret!);
          return verifySlackSignature(secret, timestamp, rawBody, signature);
        } catch {
          return false;
        }
      });
      if (!connection) {
        slackDiag(req.log, "inbound rejected: signature verification failed", {
          candidates: candidates.length,
        });
        return reply.code(401).send({ error: "Signature verification failed" });
      }

      let envelope: SlackEventEnvelope;
      try {
        envelope = JSON.parse(rawBody) as SlackEventEnvelope;
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }

      // Slack's endpoint handshake.
      if (envelope.type === "url_verification") {
        slackDiag(req.log, "url_verification challenge answered", {
          connectionId: connection.id,
        });
        return { challenge: envelope.challenge };
      }
      // Webhook-only retry signal; the shared processor also dedupes by
      // event_id, which covers Socket Mode redeliveries.
      if (Number(req.headers["x-slack-retry-num"] ?? 0) > 0) {
        return { ok: true, ignored: "duplicate delivery" };
      }

      return processSlackEvent(connection, envelope, req.log);
    });

    /**
     * Managed-setup OAuth callback: Slack redirects the admin here after they
     * click "Allow". We exchange the code for the bot token (matched to the
     * connection by the state nonce) and bounce back to the web app. Public —
     * Slack's redirect carries no Rabble session; the state is the guard.
     */
    scope.get("/api/connections/slack/oauth/callback", async (req, reply) => {
      const { code, state, error } = req.query as {
        code?: string;
        state?: string;
        error?: string;
      };
      const publicUrl = env.publicUrl ?? `http://${req.headers.host ?? ""}`;
      const back = (status: string) =>
        `${publicUrl}/?slack=${encodeURIComponent(status)}`;
      if (error || !code || !state) {
        return reply.redirect(back(error || "missing_code"));
      }
      try {
        const { completeSlackOAuth } = await import("../surfaces/slackOnboard.js");
        await completeSlackOAuth({ code, state, publicUrl });
        return reply.redirect(back("connected"));
      } catch (err) {
        req.log.error({ err }, "slack oauth callback failed");
        return reply.redirect(back("error"));
      }
    });

    // MCP OAuth callback. Public and authenticated by the single-use `state`
    // nonce (which maps to the connecting user + server) rather than the
    // session cookie: the redirect back from an external authorization server
    // lands on PUBLIC_URL, which may not be the origin the user is logged in
    // on, so requiring a session here would fail intermittently.
    scope.get("/api/mcp/oauth/callback", async (req, reply) => {
      const { code, state, error } = req.query as {
        code?: string;
        state?: string;
        error?: string;
      };
      const publicUrl = env.publicUrl ?? `http://${req.headers.host ?? ""}`;
      const back = (status: string) =>
        reply.redirect(`${publicUrl}/?mcp=${encodeURIComponent(status)}`);
      if (error || !code || !state) return back(error || "failed");

      const [pending] = await db
        .select()
        .from(mcpOauthPending)
        .where(eq(mcpOauthPending.state, state))
        .limit(1);
      if (!pending) return back("failed");
      await db.delete(mcpOauthPending).where(eq(mcpOauthPending.state, state));

      const [server] = await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, pending.serverId))
        .limit(1);
      if (!server) return back("failed");

      const { serverOAuth, storeUserTokens, storeOrgTokens } = await import(
        "../mcp/oauthFlow.js"
      );
      const oauth = serverOAuth(server);
      if (!oauth) return back("failed");
      const { exchangeCode } = await import("../mcp/oauth.js");
      const { MCP_OAUTH_CALLBACK_PATH } = await import("./mcp.js");
      try {
        const tokens = await exchangeCode({
          endpoints: oauth.endpoints,
          client: oauth.client,
          code,
          redirectUri: `${publicUrl}${MCP_OAUTH_CALLBACK_PATH}`,
          verifier: pending.codeVerifier,
        });
        const now = Date.now();
        // Shared servers store the grant as the org credential (donation);
        // personal servers store it for the connecting user.
        if (server.credentialMode === "shared") {
          await storeOrgTokens(server.id, tokens, now, pending.userId);
        } else {
          await storeUserTokens(pending.userId, server.id, tokens, now);
        }
        // First connect: discover the tool catalog with the fresh token.
        if (((server.tools ?? []) as unknown[]).length === 0) {
          const { mcpListTools } = await import("../mcp/client.js");
          const tools = await mcpListTools(server.url, tokens.accessToken).catch(
            () => null,
          );
          if (tools) {
            await db.update(mcpServers).set({ tools }).where(eq(mcpServers.id, server.id));
          }
        }
        // Personal: release any session turn paused on this user's connect card.
        if (server.credentialMode === "personal") {
          const { resolveConnects } = await import("../runtime/approvals.js");
          resolveConnects(pending.userId, server.id);
        }
        const { recordAudit } = await import("../audit.js");
        await recordAudit({
          orgId: server.orgId,
          actorUserId: pending.userId,
          action:
            server.credentialMode === "shared"
              ? "mcp.credential.donate"
              : "mcp.credential.connect",
          targetType: "mcp-server",
          targetId: server.id,
          summary:
            server.credentialMode === "shared"
              ? `Donated an org account for ${server.name} via OAuth`
              : `Connected ${server.name} via OAuth`,
        });
        return back("connected");
      } catch (err) {
        req.log.error({ err }, "mcp oauth callback failed");
        return back("failed");
      }
    });
  });
}
