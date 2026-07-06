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
  messages,
  models,
  sessions,
  users,
} from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { executeTurnAndPersist } from "../runtime/executeTurn.js";

interface SlackEnvelope {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

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

async function slackApi(
  baseUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Slack redelivers events it thinks failed (slow responses trigger retries
 * after ~3s). Remember recent event ids so a redelivery never runs a second
 * agent turn or posts a duplicate reply.
 */
const seenSlackEvents = new Set<string>();
const SEEN_EVENTS_CAP = 5000;
function alreadyDelivered(eventId: string | undefined): boolean {
  if (!eventId) return false;
  if (seenSlackEvents.has(eventId)) return true;
  seenSlackEvents.add(eventId);
  if (seenSlackEvents.size > SEEN_EVENTS_CAP) {
    const oldest = seenSlackEvents.values().next().value;
    if (oldest) seenSlackEvents.delete(oldest);
  }
  return false;
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
      if (eventName !== "issue_comment") {
        return { ok: true, ignored: "unsupported event" };
      }
      if (alreadyDelivered(deliveryId ? `gh:${deliveryId}` : undefined)) {
        return { ok: true, ignored: "duplicate delivery" };
      }

      let payload: {
        action?: string;
        repository?: { full_name?: string };
        issue?: { number?: number; title?: string };
        comment?: { body?: string; user?: { login?: string; type?: string } };
      };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }

      const fullName = payload.repository?.full_name ?? "";
      const issueNumber = payload.issue?.number;
      const body = payload.comment?.body?.trim() ?? "";
      const login = payload.comment?.user?.login ?? "";
      if (
        payload.action !== "created" ||
        payload.comment?.user?.type === "Bot" ||
        !fullName ||
        !issueNumber ||
        !body ||
        !login
      ) {
        return { ok: true, ignored: "not a user comment" };
      }

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
      const postComment = (text: string) =>
        fetch(`${baseUrl}/repos/${fullName}/issues/${issueNumber}/comments`, {
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
          `@${login} I can only act for Rabble users — connect your GitHub ` +
            "account under Profile › Connected accounts and try again.",
        );
        return { ok: true, ignored: "no matching platform user" };
      }

      // One issue = one session.
      const surfaceKey = `github:${fullName.toLowerCase()}#${issueNumber}`;
      let [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.surfaceKey, surfaceKey))
        .limit(1);
      if (!session) {
        const title = payload.issue?.title?.trim() || `${fullName}#${issueNumber}`;
        [session] = await db
          .insert(sessions)
          .values({
            orgId: connection.orgId,
            userId: platformUser.user.id,
            agentId: matched.agent.id,
            title: title.length > 60 ? `${title.slice(0, 57)}…` : title,
            surface: `GitHub ${fullName}#${issueNumber}`,
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
          content: body,
          requireApproval: orgSettings.requireApprovalForUserTools,
          sessionApproved: false,
          interactive: false,
        });
        fullText = result.fullText;
      } catch (err) {
        req.log.error({ err }, "github surface turn failed");
        await postComment(
          "Something went wrong running the agent — check the session in Rabble.",
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

      let payload: {
        type?: string;
        user?: { id?: string };
        actions?: Array<{ action_id?: string; value?: string }>;
      };
      try {
        payload = JSON.parse(
          new URLSearchParams(rawBody).get("payload") ?? "{}",
        ) as typeof payload;
      } catch {
        return reply.code(400).send({ error: "Invalid payload" });
      }
      const action = payload.actions?.[0];
      if (payload.type !== "block_actions" || !action?.value || !payload.user?.id) {
        return { ok: true, ignored: "unsupported interaction" };
      }

      const baseUrl = connection.baseUrl ?? "https://slack.com";
      const token = connection.encryptedToken
        ? decryptSecret(connection.encryptedToken)
        : "";
      const info = await slackApi(baseUrl, token, "users.info", {
        user: payload.user.id,
      });
      const email = (info.user as { profile?: { email?: string } } | undefined)
        ?.profile?.email;
      const [decider] = email
        ? await db
            .select()
            .from(users)
            .where(and(eq(users.orgId, connection.orgId), eq(users.email, email)))
            .limit(1)
        : [];
      if (!decider) return { ok: true, ignored: "unknown user" };

      let ref: { approvalId?: string; sessionId?: string };
      try {
        ref = JSON.parse(action.value) as typeof ref;
      } catch {
        return reply.code(400).send({ error: "Invalid action value" });
      }
      const { decideApproval } = await import("../runtime/approvals.js");
      const ok =
        ref.approvalId && ref.sessionId
          ? decideApproval(
              ref.approvalId,
              ref.sessionId,
              decider.id,
              action.action_id === "rabble_approve" ? "approve" : "deny",
            )
          : false;
      return {
        ok: true,
        resolved: ok,
        text: ok
          ? action.action_id === "rabble_approve"
            ? "Approved — the agent is continuing."
            : "Denied — the agent was told no."
          : "This approval already resolved or isn't yours to decide.",
      };
    });

    scope.post("/api/inbound/slack", async (req, reply) => {
      const rawBody = req.body as string;
      const timestamp = String(req.headers["x-slack-request-timestamp"] ?? "");
      const signature = String(req.headers["x-slack-signature"] ?? "");

      // Replay window: Slack recommends rejecting anything older than 5 min.
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!timestamp || Number.isNaN(age) || age > 300) {
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
        return reply.code(401).send({ error: "Signature verification failed" });
      }

      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(rawBody) as SlackEnvelope;
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }

      // Slack's endpoint handshake.
      if (envelope.type === "url_verification") {
        return { challenge: envelope.challenge };
      }
      if (envelope.type !== "event_callback" || !envelope.event) {
        return { ok: true, ignored: "unsupported envelope" };
      }
      if (
        Number(req.headers["x-slack-retry-num"] ?? 0) > 0 ||
        alreadyDelivered(envelope.event_id)
      ) {
        return { ok: true, ignored: "duplicate delivery" };
      }

      const event = envelope.event;
      // Only plain user messages — no bot echoes, edits, or joins.
      if (
        event.type !== "message" ||
        event.bot_id ||
        event.subtype ||
        !event.channel ||
        !event.user ||
        !event.text?.trim() ||
        !event.ts
      ) {
        return { ok: true, ignored: "not a user message" };
      }

      const baseUrl = connection.baseUrl ?? "https://slack.com";
      const token = connection.encryptedToken
        ? decryptSecret(connection.encryptedToken)
        : "";

      // Which agent listens on this channel?
      const channelInfo = await slackApi(baseUrl, token, "conversations.info", {
        channel: event.channel,
      });
      const channelName =
        ((channelInfo.channel as { name?: string } | undefined)?.name ?? "")
          .replace(/^#/, "");
      const surfaceRows = await db
        .select({ surface: agentSurfaces, agent: agents })
        .from(agentSurfaces)
        .innerJoin(agents, eq(agentSurfaces.agentId, agents.id))
        .where(eq(agentSurfaces.connectionId, connection.id));
      const matched = surfaceRows.find((r) => {
        const label = r.surface.label.replace(/^#/, "");
        return label === channelName || label === event.channel;
      });
      if (!matched) return { ok: true, ignored: "no agent on this channel" };

      // Sessions belong to people: resolve the Slack user to a platform user.
      const userInfo = await slackApi(baseUrl, token, "users.info", {
        user: event.user,
      });
      const email = (
        userInfo.user as { profile?: { email?: string } } | undefined
      )?.profile?.email;
      const threadTs = event.thread_ts ?? event.ts;
      const [platformUser] = email
        ? await db
            .select()
            .from(users)
            .where(
              and(eq(users.orgId, connection.orgId), eq(users.email, email)),
            )
            .limit(1)
        : [];
      if (!platformUser) {
        await slackApi(baseUrl, token, "chat.postMessage", {
          channel: event.channel,
          thread_ts: threadTs,
          text: "Sorry — I can only act for Rabble users. Ask an org admin to invite you.",
        });
        return { ok: true, ignored: "no matching platform user" };
      }

      // One Slack thread = one session.
      const surfaceKey = `slack:${event.channel}:${threadTs}`;
      let [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.surfaceKey, surfaceKey))
        .limit(1);
      if (!session) {
        const title =
          event.text.length > 60 ? `${event.text.slice(0, 57)}…` : event.text;
        [session] = await db
          .insert(sessions)
          .values({
            orgId: connection.orgId,
            userId: platformUser.id,
            agentId: matched.agent.id,
            title,
            surface: `Slack #${channelName || event.channel}`,
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
      const priorMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, session!.id));
      const sessionApproved = priorMessages.some((m) =>
        ((m.toolCalls ?? []) as Array<{ approval?: { status?: string } | null }>).some(
          (tc) =>
            tc.approval?.status === "approved" ||
            tc.approval?.status === "auto-approved",
        ),
      );

      let fullText = "";
      try {
        const result = await executeTurnAndPersist({
          sessionId: session!.id,
          agent: matched.agent,
          model,
          user: platformUser,
          content: event.text,
          requireApproval: orgSettings.requireApprovalForUserTools,
          sessionApproved,
          interactive: false,
          // Deliver approval asks as DM buttons instead of auto-denying —
          // the broker still owns the decision and the timeout.
          approvalPrompt: async (ask) => {
            const lookup = await slackApi(baseUrl, token, "users.lookupByEmail", {
              email: platformUser.email,
            });
            const dmUser = (lookup.user as { id?: string } | undefined)?.id;
            if (!dmUser) return;
            const value = JSON.stringify({
              approvalId: ask.approvalId,
              sessionId: session!.id,
            });
            await slackApi(baseUrl, token, "chat.postMessage", {
              channel: dmUser,
              text:
                `${matched.agent.name} wants to run ${ask.toolName}` +
                `${ask.serverName ? ` via ${ask.serverName}` : ""} acting as you ` +
                `(from ${session!.surface}).`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text:
                      `*Approval needed — acting as you*\n` +
                      `${matched.agent.name} wants to run \`${ask.toolName}\`` +
                      `${ask.serverName ? ` via ${ask.serverName}` : ""} on ${session!.surface}.`,
                  },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      style: "primary",
                      action_id: "rabble_approve",
                      text: { type: "plain_text", text: "Approve as me" },
                      value,
                    },
                    {
                      type: "button",
                      style: "danger",
                      action_id: "rabble_deny",
                      text: { type: "plain_text", text: "Deny" },
                      value,
                    },
                  ],
                },
              ],
            });
          },
        });
        fullText = result.fullText;
      } catch (err) {
        req.log.error({ err }, "slack surface turn failed");
        await slackApi(baseUrl, token, "chat.postMessage", {
          channel: event.channel,
          thread_ts: threadTs,
          text: "Something went wrong running the agent — check the session in Rabble.",
        });
        return { ok: true, error: "turn failed" };
      }

      await slackApi(baseUrl, token, "chat.postMessage", {
        channel: event.channel,
        thread_ts: threadTs,
        text: fullText || "(no reply)",
      });

      return { ok: true, sessionId: session!.id };
    });
  });
}
