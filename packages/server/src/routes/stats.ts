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
    const { days: daysRaw, agentId } = req.query as {
      days?: string;
      agentId?: string;
    };
    const days = Math.min(Math.max(Number(daysRaw ?? 30), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const priorSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);
    const orgId = req.user!.orgId;
    const agentFilter = agentId ? [eq(sessions.agentId, agentId)] : [];

    const [kpis] = await db
      .select({
        sessions: sql<number>`count(DISTINCT ${sessions.id})::int`,
        users: sql<number>`count(DISTINCT ${sessions.userId})::int`,
      })
      .from(sessions)
      .where(and(eq(sessions.orgId, orgId), gte(sessions.createdAt, since), ...agentFilter));

    const [messageKpis] = await db
      .select({
        messages: sql<number>`count(*)::int`,
        toolCalls: sql<number>`coalesce(sum(jsonb_array_length(${messages.toolCalls})), 0)::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(eq(sessions.orgId, orgId), gte(messages.createdAt, since), ...agentFilter));

    const [tokenKpis] = await db
      .select({
        inputTokens: sql<number>`coalesce(sum(${messages.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${messages.outputTokens}), 0)::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(eq(sessions.orgId, orgId), gte(messages.createdAt, since), ...agentFilter));

    // Prior-period comparators for KPI deltas
    const [priorKpis] = await db
      .select({
        sessions: sql<number>`count(DISTINCT ${sessions.id})::int`,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, orgId),
          gte(sessions.createdAt, priorSince),
          sql`${sessions.createdAt} < ${since}`,
          ...agentFilter,
        ),
      );

    // Session length: average turns (user+agent message pairs) and buckets
    const turnRows = await db
      .select({
        sessionId: messages.sessionId,
        count: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(eq(sessions.orgId, orgId), gte(sessions.createdAt, since), ...agentFilter))
      .groupBy(messages.sessionId);
    const turnCounts = turnRows.map((r) => Math.ceil(r.count / 2));
    const avgTurns =
      turnCounts.length > 0
        ? Math.round((turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length) * 10) / 10
        : 0;
    const buckets = [
      { label: "1–3 turns", min: 1, max: 3 },
      { label: "4–8 turns", min: 4, max: 8 },
      { label: "9–15 turns", min: 9, max: 15 },
      { label: "16+ turns", min: 16, max: Infinity },
    ].map((b) => ({
      label: b.label,
      count: turnCounts.filter((t) => t >= b.min && t <= b.max).length,
    }));

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

    const evalByAgent = await db
      .select({
        agentName: agents.name,
        passRate: sql<number>`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END))::int`,
        results: sql<number>`count(*)::int`,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .innerJoin(agents, eq(evalCriteria.agentId, agents.id))
      .where(and(eq(agents.orgId, orgId), gte(evalResults.createdAt, since)))
      .groupBy(agents.name)
      .orderBy(sql`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END)) DESC`);

    const perAgent = await db
      .select({
        agentId: sessions.agentId,
        agentName: agents.name,
        count: sql<number>`count(*)::int`,
      })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(and(eq(sessions.orgId, orgId), gte(sessions.createdAt, since), ...agentFilter))
      .groupBy(sessions.agentId, agents.name)
      .orderBy(sql`count(*) DESC`)
      .limit(10);

    const perDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${sessions.createdAt}), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(sessions)
      .where(and(eq(sessions.orgId, orgId), gte(sessions.createdAt, since), ...agentFilter))
      .groupBy(sql`date_trunc('day', ${sessions.createdAt})`)
      .orderBy(sql`date_trunc('day', ${sessions.createdAt})`);

    // Tool usage by tool name and server ("skill use")
    const perToolResult = await db.execute(sql`
      SELECT tc->>'name' AS tool, tc->>'serverName' AS server, count(*)::int AS count
      FROM messages m
      JOIN sessions s ON s.id = m.session_id,
      LATERAL jsonb_array_elements(m.tool_calls) AS tc
      WHERE s.org_id = ${orgId} AND m.created_at >= ${since}
      GROUP BY tc->>'name', tc->>'serverName'
      ORDER BY count(*) DESC
      LIMIT 20
    `);
    const perTool = (perToolResult.rows as Array<{
      tool: string | null;
      server: string | null;
      count: number;
    }>).map((r) => ({ tool: r.tool ?? "unknown", server: r.server, count: Number(r.count) }));

    // Messages per model ("usage & spend")
    const perModel = await db
      .select({
        modelName: sql<string>`coalesce(mo.display_name, '(no model)')`,
        count: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .leftJoin(sql`models mo`, sql`mo.id = agents.model_id`)
      .where(and(eq(sessions.orgId, orgId), gte(messages.createdAt, since)))
      .groupBy(sql`coalesce(mo.display_name, '(no model)')`)
      .orderBy(sql`count(*) DESC`);

    // Per-criterion pass rates ("eval performance")
    const perCriterion = await db
      .select({
        criterionId: evalCriteria.id,
        criterionName: evalCriteria.name,
        agentName: agents.name,
        passRate: sql<number>`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END))::int`,
        results: sql<number>`count(*)::int`,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .innerJoin(agents, eq(evalCriteria.agentId, agents.id))
      .where(and(eq(agents.orgId, orgId), gte(evalResults.createdAt, since)))
      .groupBy(evalCriteria.id, evalCriteria.name, agents.name)
      .orderBy(sql`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END)) ASC`);

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
        priorSessions: priorKpis?.sessions ?? 0,
        activeUsers: kpis?.users ?? 0,
        messages: messageKpis?.messages ?? 0,
        toolCalls: messageKpis?.toolCalls ?? 0,
        inputTokens: tokenKpis?.inputTokens ?? 0,
        outputTokens: tokenKpis?.outputTokens ?? 0,
        avgTurns,
        activeAgents: agentKpis?.active ?? 0,
        totalAgents: agentKpis?.total ?? 0,
        evalPassRate: evalKpis?.passRate ?? null,
        evaluatedSessions: evalKpis?.evaluated ?? 0,
      },
      sessionsPerAgent: perAgent,
      sessionsPerDay: perDay,
      toolAuthSplit: authSplit.filter((r) => r.authType),
      perTool,
      perModel,
      perCriterion,
      evalByAgent,
      turnDistribution: buckets,
    };
  });
}
