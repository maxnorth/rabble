import type { FastifyInstance, FastifyReply } from "fastify";
import {
  approvalDecisionSchema,
  createSessionSchema,
  postMessageSchema,
  type StreamEvent,
  type ToolCall,
} from "@rabblehq/core";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, messages, sessions, users } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { serializeMessage, serializeSession } from "../serialize.js";
import { runAgentTurn } from "../runtime/agentTurn.js";
import { routeByIntent } from "../runtime/router.js";
import { decideApproval, pendingApprovalsFor } from "../runtime/approvals.js";
import { hasRight, rightsForAllAgents } from "../rights.js";
import { judgeSession } from "../evals/judge.js";

function sendEvent(reply: FastifyReply, event: StreamEvent) {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Session visibility: the person who started it, plus anyone who authored
 * a message in it (shared surface threads are group spaces). Rename and
 * delete stay with the session's user.
 */
function participantPredicate(userId: string) {
  return sql`(${sessions.userId} = ${userId} OR EXISTS (
    SELECT 1 FROM messages pm
    WHERE pm.session_id = ${sessions.id} AND pm.author_user_id = ${userId}
  ))`;
}

export async function sessionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/sessions", async (req) => {
    const rows = await db
      .select({
        session: sessions,
        agentName: agents.name,
        agentSlug: agents.slug,
        agentIcon: agents.icon,
        agentColor: agents.color,
      })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(
        and(
          eq(sessions.orgId, req.user!.orgId),
          participantPredicate(req.user!.id),
        ),
      )
      .orderBy(desc(sessions.updatedAt))
      .limit(100);
    return {
      sessions: rows.map((r) => ({
        ...serializeSession(r.session),
        agentName: r.agentName,
        agentSlug: r.agentSlug,
        agentIcon: r.agentIcon ?? "",
        agentColor: r.agentColor ?? "",
      })),
    };
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = createSessionSchema.parse(req.body ?? {});
    const rights = await rightsForAllAgents(req.user!);
    let agentId = body.agentId ?? null;

    if (agentId) {
      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, req.user!.orgId)))
        .limit(1);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!hasRight(rights.get(agentId) ?? null, "use")) {
        return reply
          .code(403)
          .send({ error: "You don't have use access to this agent" });
      }
    } else {
      // "Auto": route by intent across the agents the user can actually use.
      // Built-ins (the Builder) are picked deliberately, never auto-routed.
      const candidates = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.orgId, req.user!.orgId),
            eq(agents.status, "active"),
            isNull(agents.builtin),
          ),
        )
        .orderBy(agents.name);
      const usable = candidates.filter((c) =>
        hasRight(rights.get(c.id) ?? null, "use"),
      );
      if (usable.length === 0) {
        return reply
          .code(409)
          .send({ error: "No agents available to you. Ask for access or create one." });
      }
      agentId = await routeByIntent(req.user!.orgId, body.intent, usable);
    }

    const [row] = await db
      .insert(sessions)
      .values({ orgId: req.user!.orgId, userId: req.user!.id, agentId })
      .returning();
    return { session: serializeSession(row!) };
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db
      .select({
        session: sessions,
        agentName: agents.name,
        agentSlug: agents.slug,
        agentIcon: agents.icon,
        agentColor: agents.color,
      })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.orgId, req.user!.orgId),
          participantPredicate(req.user!.id),
        ),
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Session not found" });

    const history = await db
      .select({ message: messages, authorName: users.name })
      .from(messages)
      .leftJoin(users, eq(messages.authorUserId, users.id))
      .where(eq(messages.sessionId, id))
      .orderBy(messages.createdAt);

    const { evalResults, evalCriteria } = await import("../db/schema.js");
    const evals = await db
      .select({
        id: evalResults.id,
        criterionId: evalResults.criterionId,
        criterionName: evalCriteria.name,
        passed: evalResults.passed,
        reasoning: evalResults.reasoning,
        reviewStatus: evalResults.reviewStatus,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .where(eq(evalResults.sessionId, id))
      .orderBy(evalCriteria.name);

    return {
      session: {
        ...serializeSession(row.session),
        agentName: row.agentName,
        agentSlug: row.agentSlug,
        agentIcon: row.agentIcon ?? "",
        agentColor: row.agentColor ?? "",
      },
      messages: history.map((h) => ({
        ...serializeMessage(h.message),
        authorName: h.authorName,
      })),
      evalResults: evals,
      pendingApprovals: pendingApprovalsFor(id, req.user!.id),
    };
  });

  app.patch("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title } = req.body as { title?: string };
    if (typeof title !== "string" || !title.trim() || title.length > 200) {
      return reply.code(400).send({ error: "A title (max 200 chars) is required" });
    }
    const [row] = await db
      .update(sessions)
      .set({ title: title.trim(), updatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.orgId, req.user!.orgId),
          eq(sessions.userId, req.user!.id),
        ),
      )
      .returning();
    if (!row) return reply.code(404).send({ error: "Session not found" });
    return { session: serializeSession(row) };
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.orgId, req.user!.orgId),
          eq(sessions.userId, req.user!.id),
        ),
      )
      .returning({ id: sessions.id });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: "Session not found" });
    }
    return { ok: true };
  });

  // Resolve a pending in-thread approval
  app.post("/api/sessions/:id/approvals/:approvalId", async (req, reply) => {
    const { id, approvalId } = req.params as { id: string; approvalId: string };
    const body = approvalDecisionSchema.parse(req.body);
    const ok = decideApproval(
      approvalId,
      id,
      req.user!.id,
      body.decision === "approve"
        ? "approve"
        : body.decision === "deny"
          ? "deny"
          : "run-as-service",
    );
    if (!ok) {
      return reply
        .code(404)
        .send({ error: "This approval is no longer pending" });
    }
    return { ok: true };
  });

  // Post a user message; the agent's reply streams back as SSE.
  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = postMessageSchema.parse(req.body);

    const [row] = await db
      .select({ session: sessions, agent: agents })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.orgId, req.user!.orgId),
          participantPredicate(req.user!.id),
        ),
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Session not found" });

    const { resolveAgentModel } = await import("../models/resolve.js");
    const model = await resolveAgentModel(row.agent);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    try {
      const history = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, id))
        .orderBy(messages.createdAt);

      const { orgs } = await import("../db/schema.js");
      const { orgSettingsSchema } = await import("@rabblehq/core");
      const [org] = await db
        .select({ settings: orgs.settings })
        .from(orgs)
        .where(eq(orgs.id, req.user!.orgId))
        .limit(1);
      const orgSettings = orgSettingsSchema.parse({ ...(org?.settings as object) });
      const sessionApproved = history.some((m) =>
        ((m.toolCalls ?? []) as Array<{ approval?: { status?: string } | null }>).some(
          (tc) =>
            tc.approval?.status === "approved" ||
            tc.approval?.status === "auto-approved",
        ),
      );

      const [userMessage] = await db
        .insert(messages)
        .values({
          sessionId: id,
          role: "user",
          content: body.content,
          authorUserId: req.user!.id,
        })
        .returning();
      sendEvent(reply, {
        type: "user-message",
        message: { ...serializeMessage(userMessage!), authorName: req.user!.name },
      });

      if (history.length === 0) {
        const title =
          body.content.length > 60 ? `${body.content.slice(0, 57)}…` : body.content;
        await db.update(sessions).set({ title }).where(eq(sessions.id, id));
      }

      let fullText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCalls: ToolCall[] = [];
      for await (const event of runAgentTurn({
        agent: row.agent,
        model,
        user: req.user!,
        sessionId: id,
        history,
        userContent: body.content,
        requireApproval: orgSettings.requireApprovalForUserTools,
        sessionApproved,
        interactive: true,
      })) {
        if (event.type === "usage") {
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
        } else if (event.type === "text") {
          fullText += event.text;
          sendEvent(reply, { type: "delta", text: event.text });
        } else if (event.type === "tool-start") {
          sendEvent(reply, { type: "tool-start", toolCall: event.toolCall });
        } else if (event.type === "tool-end") {
          toolCalls.push(event.toolCall);
          sendEvent(reply, { type: "tool-end", toolCall: event.toolCall });
        } else if (event.type === "approval-request") {
          sendEvent(reply, {
            type: "approval-request",
            approvalId: event.approvalId,
            toolName: event.toolName,
            serverName: event.serverName,
            input: event.input,
          });
        }
      }

      const [agentMessage] = await db
        .insert(messages)
        .values({
          sessionId: id,
          role: "agent",
          content: fullText,
          toolCalls,
          inputTokens,
          outputTokens,
          modelId: model?.id ?? null,
        })
        .returning();
      await db
        .update(sessions)
        .set({ updatedAt: new Date() })
        .where(eq(sessions.id, id));
      sendEvent(reply, {
        type: "done",
        message: { ...serializeMessage(agentMessage!), authorName: null },
      });

      // Live evals: judge this session against the agent's criteria in the
      // background — results appear on the session when it's next loaded.
      void judgeSession({
        sessionId: id,
        agent: row.agent,
        model,
      }).catch((err) => req.log.warn({ err }, "live eval failed"));
    } catch (err) {
      // Operational, not a server bug: the failure is surfaced to the user
      // in the thread. warn keeps the log-cleanliness gate meaningful.
      req.log.warn({ err }, "agent turn failed");
      sendEvent(reply, {
        type: "error",
        error: err instanceof Error ? err.message : "Agent turn failed",
      });
    } finally {
      reply.raw.end();
    }
  });
}
