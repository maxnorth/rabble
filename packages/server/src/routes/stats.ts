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

  // Drill-down: an agent's failing judge verdicts in the window.
  app.get("/api/stats/failures", async (req) => {
    const { agentId, days: daysRaw } = req.query as {
      agentId?: string;
      days?: string;
    };
    const days = Math.min(Math.max(Number(daysRaw ?? 30), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        id: evalResults.id,
        criterionName: evalCriteria.name,
        reasoning: evalResults.reasoning,
        sessionId: evalResults.sessionId,
        sessionTitle: sessions.title,
        createdAt: evalResults.createdAt,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .innerJoin(sessions, eq(evalResults.sessionId, sessions.id))
      .innerJoin(agents, eq(evalCriteria.agentId, agents.id))
      .where(
        and(
          eq(agents.orgId, req.user!.orgId),
          eq(evalResults.passed, false),
          gte(evalResults.createdAt, since),
          ...(agentId ? [eq(evalCriteria.agentId, agentId)] : []),
        ),
      )
      .orderBy(sql`${evalResults.createdAt} DESC`)
      .limit(50);
    return {
      failures: rows.map((r) => ({
        id: r.id,
        criterionName: r.criterionName,
        reasoning: r.reasoning,
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.get("/api/stats", async (req) => {
    const { days: daysRaw, agentId, userId } = req.query as {
      days?: string;
      agentId?: string;
      userId?: string;
    };
    const days = Math.min(Math.max(Number(daysRaw ?? 30), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const priorSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);
    const orgId = req.user!.orgId;
    const agentFilter = [
      ...(agentId ? [eq(sessions.agentId, agentId)] : []),
      ...(userId ? [eq(sessions.userId, userId)] : []),
    ];
    // Raw-SQL equivalents (alias `s`) so every session-derived panel honours
    // the same agent/user filter — otherwise the page mixes scoped KPIs with
    // unscoped tables under one filter and reads as one coherent view.
    const sAgent = agentId ? sql`AND s.agent_id = ${agentId}` : sql``;
    const sUser = userId ? sql`AND s.user_id = ${userId}` : sql``;
    // Evals have no user dimension; only the agent filter narrows them.
    const evalAgentFilter = agentId ? [eq(evalCriteria.agentId, agentId)] : [];

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
    const [priorMessageKpis] = await db
      .select({
        messages: sql<number>`count(*)::int`,
        toolCalls: sql<number>`coalesce(sum(jsonb_array_length(${messages.toolCalls})), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${messages.outputTokens}), 0)::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.orgId, orgId),
          gte(messages.createdAt, priorSince),
          sql`${messages.createdAt} < ${since}`,
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
        // Distinct sessions, not verdict rows — eval_results has one row per
        // (session, criterion), so count(*) would multiply by the criteria count.
        evaluated: sql<number>`count(DISTINCT ${evalResults.sessionId})::int`,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .innerJoin(agents, eq(evalCriteria.agentId, agents.id))
      .where(and(eq(agents.orgId, orgId), gte(evalResults.createdAt, since), ...evalAgentFilter));

    const evalByAgent = await db
      .select({
        agentId: agents.id,
        agentName: agents.name,
        passRate: sql<number>`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END))::int`,
        results: sql<number>`count(*)::int`,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .innerJoin(agents, eq(evalCriteria.agentId, agents.id))
      .where(and(eq(agents.orgId, orgId), gte(evalResults.createdAt, since), ...evalAgentFilter))
      .groupBy(agents.id, agents.name)
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

    // Dense daily series: generate every day in the window and left-join
    // counts, so the chart shows the real timeline (gaps and spikes) instead
    // of collapsing to one equal-height bar per day that happened to have a
    // session. date_trunc on both sides keeps the buckets timezone-aligned.
    const perDayResult = await db.execute(sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(c.count, 0)::int AS count
      FROM generate_series(
        date_trunc('day', ${since}::timestamptz),
        date_trunc('day', now()),
        interval '1 day'
      ) AS d
      LEFT JOIN (
        SELECT date_trunc('day', created_at) AS day, count(*)::int AS count
        FROM sessions
        WHERE org_id = ${orgId} AND created_at >= ${since}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
          ${userId ? sql`AND user_id = ${userId}` : sql``}
        GROUP BY 1
      ) c ON c.day = d
      ORDER BY d
    `);
    const perDay = perDayResult.rows as Array<{ day: string; count: number }>;

    // Tool usage by tool name and server ("skill use")
    const perToolResult = await db.execute(sql`
      SELECT tc->>'name' AS tool, tc->>'serverName' AS server, count(*)::int AS count
      FROM messages m
      JOIN sessions s ON s.id = m.session_id,
      LATERAL jsonb_array_elements(m.tool_calls) AS tc
      WHERE s.org_id = ${orgId} AND m.created_at >= ${since} ${sAgent} ${sUser}
      GROUP BY tc->>'name', tc->>'serverName'
      ORDER BY count(*) DESC
      LIMIT 20
    `);
    const perTool = (perToolResult.rows as Array<{
      tool: string | null;
      server: string | null;
      count: number;
    }>).map((r) => ({ tool: r.tool ?? "unknown", server: r.server, count: Number(r.count) }));

    // $ spend: message tokens priced by model rate. Unpriced models (null
    // price) contribute $0 — the totals are a lower bound when any active
    // model is unpriced. Group by agent id, not name: names aren't unique, so
    // grouping by name would merge two distinct agents' cost into one row.
    const spendResult = await db.execute(sql`
      SELECT a.id AS agent_id, a.name AS agent_name,
             count(DISTINCT s.id)::int AS sessions,
             sum(m.input_tokens  * coalesce(m.price_input_per_mtok,  mo.price_input_per_mtok,  0) / 1e6
               + m.output_tokens * coalesce(m.price_output_per_mtok, mo.price_output_per_mtok, 0) / 1e6
             )::numeric(12,4) AS spend
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      JOIN agents a ON a.id = s.agent_id
      LEFT JOIN models mo ON mo.id = coalesce(m.model_id, a.model_id)
      WHERE s.org_id = ${orgId} AND m.created_at >= ${since}
        ${agentId ? sql`AND s.agent_id = ${agentId}` : sql``}
        ${userId ? sql`AND s.user_id = ${userId}` : sql``}
      GROUP BY a.id, a.name
      ORDER BY spend DESC
    `);
    const spendByAgent = (spendResult.rows as Array<{
      agent_name: string;
      sessions: number;
      spend: string | null;
    }>).map((r) => ({
      agentName: r.agent_name,
      sessions: Number(r.sessions),
      spend: Number(r.spend ?? 0),
    }));
    const totalSpend = spendByAgent.reduce((sum, r) => sum + r.spend, 0);
    const totalSpendSessions = spendByAgent.reduce((sum, r) => sum + r.sessions, 0);

    // Messages per model ("usage & spend")
    const perModel = await db
      .select({
        modelName: sql<string>`coalesce(mo.display_name, '(no model)')`,
        count: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${messages.inputTokens} + ${messages.outputTokens}), 0)::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .leftJoin(sql`models mo`, sql`mo.id = coalesce(messages.model_id, agents.model_id)`)
      .where(and(eq(sessions.orgId, orgId), gte(messages.createdAt, since), ...agentFilter))
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
      .where(and(eq(agents.orgId, orgId), gte(evalResults.createdAt, since), ...evalAgentFilter))
      .groupBy(evalCriteria.id, evalCriteria.name, agents.name)
      .orderBy(sql`round(avg(CASE WHEN ${evalResults.passed} THEN 100.0 ELSE 0.0 END)) ASC`);

    const authSplitResult = await db.execute(sql`
      SELECT tc->>'authType' AS auth_type, count(*)::int AS count
      FROM messages m
      JOIN sessions s ON s.id = m.session_id,
      LATERAL jsonb_array_elements(m.tool_calls) AS tc
      WHERE s.org_id = ${orgId} AND m.created_at >= ${since} ${sAgent} ${sUser}
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
        priorMessages: priorMessageKpis?.messages ?? 0,
        toolCalls: messageKpis?.toolCalls ?? 0,
        priorToolCalls: priorMessageKpis?.toolCalls ?? 0,
        inputTokens: tokenKpis?.inputTokens ?? 0,
        outputTokens: tokenKpis?.outputTokens ?? 0,
        priorOutputTokens: priorMessageKpis?.outputTokens ?? 0,
        spend: Math.round(totalSpend * 100) / 100,
        avgCostPerSession:
          totalSpendSessions > 0
            ? Math.round((totalSpend / totalSpendSessions) * 100) / 100
            : 0,
        avgTurns,
        activeAgents: agentKpis?.active ?? 0,
        totalAgents: agentKpis?.total ?? 0,
        evalPassRate: evalKpis?.passRate ?? null,
        evaluatedSessions: evalKpis?.evaluated ?? 0,
      },
      spendByAgent,
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
