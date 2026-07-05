import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createSessionSchema,
  postMessageSchema,
  type StreamEvent,
} from "@rabble/core";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, messages, models, sessions } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { serializeMessage, serializeSession } from "../serialize.js";
import { runAgentTurn } from "../runtime/agentTurn.js";

function sendEvent(reply: FastifyReply, event: StreamEvent) {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function sessionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/sessions", async (req) => {
    const rows = await db
      .select({ session: sessions, agentName: agents.name, agentSlug: agents.slug })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(
        and(
          eq(sessions.orgId, req.user!.orgId),
          eq(sessions.userId, req.user!.id),
        ),
      )
      .orderBy(desc(sessions.updatedAt))
      .limit(100);
    return {
      sessions: rows.map((r) => ({
        ...serializeSession(r.session),
        agentName: r.agentName,
        agentSlug: r.agentSlug,
      })),
    };
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = createSessionSchema.parse(req.body ?? {});
    let agentId = body.agentId ?? null;

    if (agentId) {
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, req.user!.orgId)))
        .limit(1);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
    } else {
      // "Auto": pick an active agent. Real routing comes later.
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.orgId, req.user!.orgId), eq(agents.status, "active")),
        )
        .orderBy(agents.name)
        .limit(1);
      if (!agent) {
        return reply
          .code(409)
          .send({ error: "No active agents available. Create one first." });
      }
      agentId = agent.id;
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
      .select({ session: sessions, agentName: agents.name, agentSlug: agents.slug })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.orgId, req.user!.orgId),
          eq(sessions.userId, req.user!.id),
        ),
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Session not found" });

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, id))
      .orderBy(messages.createdAt);

    return {
      session: {
        ...serializeSession(row.session),
        agentName: row.agentName,
        agentSlug: row.agentSlug,
      },
      messages: history.map(serializeMessage),
    };
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
          eq(sessions.userId, req.user!.id),
        ),
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Session not found" });

    const model = row.agent.modelId
      ? (
          await db
            .select()
            .from(models)
            .where(eq(models.id, row.agent.modelId))
            .limit(1)
        )[0]
      : undefined;

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

      const [userMessage] = await db
        .insert(messages)
        .values({ sessionId: id, role: "user", content: body.content })
        .returning();
      sendEvent(reply, {
        type: "user-message",
        message: serializeMessage(userMessage!),
      });

      // First message titles the session.
      if (history.length === 0) {
        const title =
          body.content.length > 60 ? `${body.content.slice(0, 57)}…` : body.content;
        await db.update(sessions).set({ title }).where(eq(sessions.id, id));
      }

      let fullText = "";
      const toolCalls = [];
      for await (const event of runAgentTurn({
        agent: row.agent,
        model,
        history,
        userContent: body.content,
      })) {
        if (event.type === "text") {
          fullText += event.text;
          sendEvent(reply, { type: "delta", text: event.text });
        } else {
          toolCalls.push(event.toolCall);
        }
      }

      const [agentMessage] = await db
        .insert(messages)
        .values({ sessionId: id, role: "agent", content: fullText, toolCalls })
        .returning();
      await db
        .update(sessions)
        .set({ updatedAt: new Date() })
        .where(eq(sessions.id, id));
      sendEvent(reply, {
        type: "done",
        message: serializeMessage(agentMessage!),
      });
    } catch (err) {
      req.log.error(err);
      sendEvent(reply, {
        type: "error",
        error: err instanceof Error ? err.message : "Agent turn failed",
      });
    } finally {
      reply.raw.end();
    }
  });
}
