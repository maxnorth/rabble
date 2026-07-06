import type { FastifyInstance } from "fastify";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agents,
  evalResults,
  evalCriteria,
  messages,
  sessions,
} from "../db/schema.js";
import { requireUser } from "../auth.js";

export async function statsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/stats", async (req) => {
    const { days: daysRaw } = req.query as { days?: string };
    const days = Math.min(Math.max(Number(daysRaw ?? 30), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const orgId = req.user!.orgId;

    const [kpis] = await db
      .select({
        sessions: sql<number>`count(DISTINCT ${sessions.id})::int`,
        users: sql<number>`count(DISTINCT ${sessions.userId})::int`,
      })
      .from(sessions)
      .where(and(eq(sessions.orgId, orgId), gte(sessions.createdAt, since)));

    const [messageKpis] = await db
      .select({
        messages: sql<number>`count(*)::int`,
        toolCalls: sql<number>`coalesce(sum(jsonb_array_length(${messages.toolCalls})), 0)::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(eq(sessions.orgId, orgId), gte(messages.createdAt, since)));

    const [agentKpis] = await db
      .select({
        active: sql<number>`count(*) FILTER (WHERE status = 'active')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(agents)
      .where(eq(agents.orgId, orgId));

    const [evalKpis] = await db
      .select({
        passRate: sql<number | null>`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END))::int`,
        evaluated: sql<number>`count(*)::int`,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .innerJoin(agents, eq(evalCriteria.agentId, agents.id))
      .where(and(eq(agents.orgId, orgId), gte(evalResults.createdAt, since)));

    const perAgent = await db
      .select({
        agentId: sessions.agentId,
        agentName: agents.name,
        count: sql<number>`count(*)::int`,
      })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(and(eq(sessions.orgId, orgId), gte(sessions.createdAt, since)))
      .groupBy(sessions.agentId, agents.name)
      .orderBy(sql`count(*) DESC`)
      .limit(10);

    const perDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${sessions.createdAt}), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(sessions)
      .where(and(eq(sessions.orgId, orgId), gte(sessions.createdAt, since)))
      .groupBy(sql`date_trunc('day', ${sessions.createdAt})`)
      .orderBy(sql`date_trunc('day', ${sessions.createdAt})`);

    const authSplitResult = await db.execute(sql`
      SELECT tc->>'authType' AS auth_type, count(*)::int AS count
      FROM messages m
      JOIN sessions s ON s.id = m.session_id,
      LATERAL jsonb_array_elements(m.tool_calls) AS tc
      WHERE s.org_id = ${orgId} AND m.created_at >= ${since}
      GROUP BY tc->>'authType'
    `);
    const authSplit = (authSplitResult.rows as Array<{
      auth_type: string | null;
      count: number;
    }>).map((r) => ({ authType: r.auth_type, count: Number(r.count) }));

    return {
      days,
      kpis: {
        sessions: kpis?.sessions ?? 0,
        activeUsers: kpis?.users ?? 0,
        messages: messageKpis?.messages ?? 0,
        toolCalls: messageKpis?.toolCalls ?? 0,
        activeAgents: agentKpis?.active ?? 0,
        totalAgents: agentKpis?.total ?? 0,
        evalPassRate: evalKpis?.passRate ?? null,
        evaluatedSessions: evalKpis?.evaluated ?? 0,
      },
      sessionsPerAgent: perAgent,
      sessionsPerDay: perDay,
      toolAuthSplit: authSplit.filter((r) => r.authType),
    };
  });
}
