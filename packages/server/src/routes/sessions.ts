import type { FastifyInstance, FastifyReply } from "fastify";
import {
  approvalDecisionSchema,
  createSessionSchema,
  postMessageSchema,
  type StreamEvent,
  type ToolCall,
} from "@rabblehq/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, messages, sessions, users } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { serializeMessage, serializeSession } from "../serialize.js";
import { runAgentTurn } from "../runtime/agentTurn.js";
import { orderAutoRoster, routeByIntent } from "../runtime/router.js";
import { pendingConnectsFor } from "../runtime/approvals.js";
import {
  decideDurableApproval,
  pendingDurableApprovals,
} from "../runtime/approvalDecide.js";
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
      .leftJoin(agents, eq(sessions.agentId, agents.id))
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
        .select({ id: agents.id, status: agents.status, webEnabled: agents.webEnabled })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, req.user!.orgId)))
        .limit(1);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!hasRight(rights.get(agentId) ?? null, "use")) {
        return reply
          .code(403)
          .send({ error: "You don't have use access to this agent" });
      }
      if (!agent.webEnabled) {
        return reply
          .code(403)
          .send({ error: "This agent isn't available in web sessions" });
      }
    } else {
      // "Auto": a multi-party session with NO pinned agent (DECISIONS.md).
      // The invisible orchestrator decides who responds to each message at
      // message time (decideResponders); creation only checks that the
      // user has at least one usable agent to talk to.
      const candidates = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.orgId, req.user!.orgId),
            eq(agents.status, "active"),
            eq(agents.webEnabled, true),
          ),
        )
        .orderBy(agents.name);
      const usable = candidates.filter(
        (c) =>
          (!c.builtin || c.builtin === "builder") &&
          hasRight(rights.get(c.id) ?? null, "use"),
      );
      if (usable.length === 0) {
        return reply
          .code(409)
          .send({ error: "No agents available to you. Ask for access or create one." });
      }
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
      .leftJoin(agents, eq(sessions.agentId, agents.id))
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
      .select({
        message: messages,
        authorName: users.name,
        msgAgentName: agents.name,
        msgAgentIcon: agents.icon,
        msgAgentColor: agents.color,
      })
      .from(messages)
      .leftJoin(users, eq(messages.authorUserId, users.id))
      .leftJoin(agents, eq(messages.agentId, agents.id))
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
        ...serializeMessage(
          h.message,
          h.msgAgentName
            ? {
                name: h.msgAgentName,
                icon: h.msgAgentIcon ?? "",
                color: h.msgAgentColor ?? "",
              }
            : null,
        ),
        authorName: h.authorName,
      })),
      evalResults: evals,
      pendingApprovals: await pendingDurableApprovals(id, req.user!.id),
      pendingConnects: pendingConnectsFor(id, req.user!.id),
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

  // Decide a pending approval. Async contract (DECISIONS.md): the agent's
  // turn already moved on — deciding executes the recorded call verbatim
  // on approval, flips the transcript chip, and notifies the agent in a
  // follow-up turn before this responds, so the UI can simply refetch the
  // session to show the outcome.
  app.post("/api/sessions/:id/approvals/:approvalId", async (req, reply) => {
    const { id, approvalId } = req.params as { id: string; approvalId: string };
    const body = approvalDecisionSchema.parse(req.body);
    const result = await decideDurableApproval({
      approvalId,
      sessionId: id,
      deciderId: req.user!.id,
      decision: body.decision,
    });
    if (!result.ok) {
      return reply
        .code(404)
        .send({ error: "This approval is no longer pending" });
    }
    return { ok: true, status: result.status };
  });

  // Post a user message; the agent's reply streams back as SSE.
  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = postMessageSchema.parse(req.body);

    const [row] = await db
      .select({ session: sessions, agent: agents })
      .from(sessions)
      .leftJoin(agents, eq(sessions.agentId, agents.id))
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

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // Hoisted so a failed turn can persist whatever streamed before it broke.
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls: ToolCall[] = [];
    let currentModel: Awaited<ReturnType<typeof resolveAgentModel>> | undefined;
    let currentAgent: typeof row.agent = row.agent;

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
      const { sessionApprovedForUser } = await import(
        "../runtime/sessionApproval.js"
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

      // Who responds? A pinned session answers as its agent. An Auto
      // session asks the invisible orchestrator, which may pull several
      // agents into this round (DECISIONS.md "Sessions are multi-party").
      let responders: NonNullable<typeof row.agent>[];
      if (row.agent) {
        responders = [row.agent];
      } else {
        const { decideResponders } = await import("../runtime/router.js");
        responders = await decideResponders(req.user!, history, body.content);
        if (responders.length === 0) {
          sendEvent(reply, {
            type: "error",
            error: "No agents available to you. Ask for access or create one.",
          });
          return;
        }
      }

      // Later responders in the round see the shared transcript including
      // earlier replies (author-attributed inside the turn runtime).
      const roundHistory = [...history];
      let sawUserContent = false;
      const judged: Array<{
        agent: NonNullable<typeof row.agent>;
        model: Awaited<ReturnType<typeof resolveAgentModel>>;
      }> = [];

      for (const responder of responders) {
        currentAgent = responder;
        sendEvent(reply, {
          type: "turn-start",
          agentId: responder.id,
          agentName: responder.name,
          agentIcon: responder.icon ?? "",
          agentColor: responder.color ?? "",
        });
        const model = await resolveAgentModel(responder);
        currentModel = model;
        // Consent is per user AND per agent: in a multi-party session,
        // approving one responder's tool never unlocks another responder.
        const sessionApproved = sessionApprovedForUser(
          history,
          req.user!.id,
          responder.id,
        );
        fullText = "";
        inputTokens = 0;
        outputTokens = 0;
        toolCalls = [];

        for await (const event of runAgentTurn({
          agent: responder,
          model,
          user: req.user!,
          sessionId: id,
          history: roundHistory,
          // The user message rides history for every responder after the
          // first, so it isn't duplicated in the prompt.
          userContent: sawUserContent ? "" : body.content,
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
          } else if (event.type === "connect-request") {
            sendEvent(reply, {
              type: "connect-request",
              connectId: event.connectId,
              serverId: event.serverId,
              serverName: event.serverName,
              requiresOAuth: event.requiresOAuth,
            });
          }
        }

        const [agentMessage] = await db
          .insert(messages)
          .values({
            sessionId: id,
            role: "agent",
            agentId: responder.id,
            content: fullText,
            toolCalls,
            inputTokens,
            outputTokens,
            modelId: model?.id ?? null,
            priceInputPerMtok: model?.priceInputPerMtok ?? null,
            priceOutputPerMtok: model?.priceOutputPerMtok ?? null,
          })
          .returning();
        sendEvent(reply, {
          type: "done",
          message: {
            ...serializeMessage(agentMessage!, {
              name: responder.name,
              icon: responder.icon ?? "",
              color: responder.color ?? "",
            }),
            authorName: null,
          },
        });

        if (!sawUserContent) {
          roundHistory.push(userMessage!);
          sawUserContent = true;
        }
        roundHistory.push(agentMessage!);
        judged.push({ agent: responder, model });
      }

      await db
        .update(sessions)
        .set({ updatedAt: new Date() })
        .where(eq(sessions.id, id));

      // Live evals: judge each responder against ITS OWN criteria — AFTER
      // the whole round, so a judge's model calls can't interleave with a
      // later responder's turn.
      for (const j of judged) {
        void judgeSession({
          sessionId: id,
          agent: j.agent,
          model: j.model,
        }).catch((err) => req.log.warn({ err }, "live eval failed"));
      }
    } catch (err) {
      // Operational, not a server bug: the failure is surfaced to the user
      // in the thread. warn keeps the log-cleanliness gate meaningful.
      req.log.warn({ err }, "agent turn failed");
      const message = err instanceof Error ? err.message : "Agent turn failed";
      // Persist the failed turn so the session stays a complete record: a
      // reload should show the failure inline, not a dangling user question
      // with no reply. Best-effort — never let audit-of-failure mask the error.
      try {
        await db.insert(messages).values({
          sessionId: id,
          role: "agent",
          agentId: currentAgent?.id ?? null,
          content: fullText,
          error: message,
          toolCalls,
          inputTokens,
          outputTokens,
          modelId: currentModel?.id ?? null,
          priceInputPerMtok: currentModel?.priceInputPerMtok ?? null,
          priceOutputPerMtok: currentModel?.priceOutputPerMtok ?? null,
        });
        await db
          .update(sessions)
          .set({ updatedAt: new Date() })
          .where(eq(sessions.id, id));
      } catch (persistErr) {
        req.log.warn({ err: persistErr }, "failed to persist errored turn");
      }
      sendEvent(reply, { type: "error", error: message });
    } finally {
      reply.raw.end();
    }
  });
}
