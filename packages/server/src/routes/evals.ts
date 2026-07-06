import type { FastifyInstance } from "fastify";
import {
  createEvalCaseSchema,
  createEvalCriterionSchema,
} from "@rabblehq/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { db } from "../db/client.js";
import {
  agents,
  caseResults,
  evalCases,
  evalCriteria,
  evalResults,
  evalSuites,
  messages,
  models,
  sessions,
  suiteRuns,
} from "../db/schema.js";
import { requireUser } from "../auth.js";
import { recordAudit } from "../audit.js";
import { hasRight, rightsForAllAgents } from "../rights.js";
import { chatModelFor } from "../models/chat.js";
import { judgeText } from "../evals/judge.js";
import { executeSuiteCases, recordSuiteRun } from "../evals/suiteRunner.js";

async function requireEdit(req: { user: unknown }, agentId: string) {
  const rights = await rightsForAllAgents(req.user as never);
  return hasRight(rights.get(agentId) ?? null, "edit");
}

export async function evalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  // --- Criteria (live, evaluated against real sessions) ---

  app.get("/api/agents/:agentId/criteria", async (req) => {
    const { agentId } = req.params as { agentId: string };
    const rows = await db
      .select({
        criterion: evalCriteria,
        passRate: sql<number | null>`(
          SELECT round(avg(CASE WHEN r.passed THEN 100.0 ELSE 0.0 END))::int
          FROM eval_results r WHERE r.criterion_id = eval_criteria.id
        )`,
        sessionCount: sql<number>`(
          SELECT count(DISTINCT r.session_id)::int
          FROM eval_results r WHERE r.criterion_id = eval_criteria.id
        )`,
      })
      .from(evalCriteria)
      .where(eq(evalCriteria.agentId, agentId))
      .orderBy(evalCriteria.createdAt);
    return {
      criteria: rows.map((r) => ({
        id: r.criterion.id,
        agentId: r.criterion.agentId,
        name: r.criterion.name,
        description: r.criterion.description,
        enabled: r.criterion.enabled,
        passRate: r.passRate,
        sessionCount: r.sessionCount,
        createdAt: r.criterion.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/agents/:agentId/criteria", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    if (!(await requireEdit(req, agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const body = createEvalCriterionSchema.parse(req.body);
    const [row] = await db
      .insert(evalCriteria)
      .values({ agentId, name: body.name, description: body.description })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.criterion.create",
      targetType: "agent",
      targetId: agentId,
      summary: `Added eval criterion "${body.name}"`,
    });
    return { criterion: row };
  });

  app.delete("/api/criteria/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [criterion] = await db
      .select()
      .from(evalCriteria)
      .where(eq(evalCriteria.id, id))
      .limit(1);
    if (!criterion) return reply.code(404).send({ error: "Criterion not found" });
    if (!(await requireEdit(req, criterion.agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    await db.delete(evalCriteria).where(eq(evalCriteria.id, id));
    return { ok: true };
  });

  // --- Suites (offline mock-session test cases) ---

  app.get("/api/agents/:agentId/suites", async (req) => {
    const { agentId } = req.params as { agentId: string };
    const rows = await db
      .select()
      .from(evalSuites)
      .where(eq(evalSuites.agentId, agentId))
      .orderBy(evalSuites.createdAt);

    const suites = [];
    for (const suite of rows) {
      const [caseCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(evalCases)
        .where(eq(evalCases.suiteId, suite.id));
      const [lastRun] = await db
        .select()
        .from(suiteRuns)
        .where(eq(suiteRuns.suiteId, suite.id))
        .orderBy(desc(suiteRuns.startedAt))
        .limit(1);
      let runSummary = null;
      if (lastRun) {
        const [tally] = await db
          .select({
            passed: sql<number>`count(*) FILTER (WHERE passed)::int`,
            total: sql<number>`count(*)::int`,
          })
          .from(caseResults)
          .where(eq(caseResults.runId, lastRun.id));
        runSummary = {
          id: lastRun.id,
          status: lastRun.status,
          passed: tally?.passed ?? 0,
          total: tally?.total ?? 0,
          startedAt: lastRun.startedAt.toISOString(),
        };
      }
      suites.push({
        id: suite.id,
        agentId: suite.agentId,
        name: suite.name,
        gating: suite.gating,
        caseCount: caseCount?.count ?? 0,
        lastRun: runSummary,
        createdAt: suite.createdAt.toISOString(),
      });
    }
    return { suites };
  });

  app.post("/api/agents/:agentId/suites", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    if (!(await requireEdit(req, agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const { name, gating } = req.body as { name: string; gating?: boolean };
    if (!name?.trim()) return reply.code(400).send({ error: "Name is required" });
    const [row] = await db
      .insert(evalSuites)
      .values({ agentId, name: name.trim(), gating: gating ?? false })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.suite.create",
      targetType: "agent",
      targetId: agentId,
      summary: `Created eval suite "${name}"`,
    });
    return { suite: row };
  });

  // --- Judge spot-checking: dispute a verdict, review the queue ---

  app.post("/api/eval-results/:resultId/dispute", async (req, reply) => {
    const { resultId } = req.params as { resultId: string };
    const [row] = await db
      .select({ result: evalResults, session: sessions })
      .from(evalResults)
      .innerJoin(sessions, eq(evalResults.sessionId, sessions.id))
      .where(eq(evalResults.id, resultId))
      .limit(1);
    if (!row || row.session.orgId !== req.user!.orgId) {
      return reply.code(404).send({ error: "Eval result not found" });
    }
    // The session's owner (or an org admin) can contest the judge.
    const isAdmin = req.user!.role === "owner" || req.user!.role === "admin";
    if (!isAdmin && row.session.userId !== req.user!.id) {
      return reply.code(403).send({ error: "Only the session owner can dispute this" });
    }
    if (row.result.reviewStatus) {
      return reply.code(409).send({ error: "Already in review" });
    }
    await db
      .update(evalResults)
      .set({ reviewStatus: "open", disputedBy: req.user!.id, disputedAt: new Date() })
      .where(eq(evalResults.id, resultId));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.result.dispute",
      targetType: "session",
      targetId: row.session.id,
      summary: `Disputed a ${row.result.passed ? "PASS" : "FAIL"} judge verdict`,
    });
    return { ok: true };
  });

  app.post("/api/eval-results/:resultId/resolve", async (req, reply) => {
    const { resultId } = req.params as { resultId: string };
    const { outcome } = req.body as { outcome?: "upheld" | "overturned" };
    if (outcome !== "upheld" && outcome !== "overturned") {
      return reply.code(400).send({ error: "outcome must be upheld or overturned" });
    }
    const [row] = await db
      .select({ result: evalResults, criterion: evalCriteria })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .where(eq(evalResults.id, resultId))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Eval result not found" });
    if (row.result.reviewStatus !== "open") {
      return reply.code(409).send({ error: "This verdict is not awaiting review" });
    }
    if (!(await requireEdit(req, row.criterion.agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    await db
      .update(evalResults)
      .set({
        reviewStatus: outcome,
        // Overturning flips the verdict — the human is the source of truth.
        passed: outcome === "overturned" ? !row.result.passed : row.result.passed,
      })
      .where(eq(evalResults.id, resultId));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.review.resolve",
      targetType: "agent",
      targetId: row.criterion.agentId,
      summary:
        outcome === "overturned"
          ? `Overturned the judge on "${row.criterion.name}"`
          : `Upheld the judge on "${row.criterion.name}"`,
    });
    return { ok: true };
  });

  // Trust panel: review queue + scope violations + judge disclosure.
  app.get("/api/agents/:agentId/trust", async (req) => {
    const { agentId } = req.params as { agentId: string };
    const { scopeViolations } = await import("../db/schema.js");

    const openReviews = await db
      .select({
        id: evalResults.id,
        criterionName: evalCriteria.name,
        passed: evalResults.passed,
        reasoning: evalResults.reasoning,
        sessionId: evalResults.sessionId,
        sessionTitle: sessions.title,
        disputedAt: evalResults.disputedAt,
      })
      .from(evalResults)
      .innerJoin(evalCriteria, eq(evalResults.criterionId, evalCriteria.id))
      .innerJoin(sessions, eq(evalResults.sessionId, sessions.id))
      .where(
        and(eq(evalCriteria.agentId, agentId), eq(evalResults.reviewStatus, "open")),
      )
      .orderBy(desc(evalResults.disputedAt));

    const [violations] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(scopeViolations)
      .where(
        and(
          eq(scopeViolations.agentId, agentId),
          sql`${scopeViolations.createdAt} > now() - interval '30 days'`,
        ),
      );

    const [agentRow] = await db
      .select({ modelId: agents.modelId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const [judge] = agentRow?.modelId
      ? await db
          .select({ displayName: models.displayName })
          .from(models)
          .where(eq(models.id, agentRow.modelId))
          .limit(1)
      : [];

    return {
      openReviews: openReviews.map((r) => ({
        id: r.id,
        criterionName: r.criterionName,
        passed: r.passed,
        reasoning: r.reasoning,
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle,
        disputedAt: r.disputedAt?.toISOString() ?? null,
      })),
      scopeViolations30d: violations?.count ?? 0,
      judgeModel: judge?.displayName ?? null,
    };
  });

  app.patch("/api/suites/:suiteId", async (req, reply) => {
    const { suiteId } = req.params as { suiteId: string };
    const [suite] = await db
      .select()
      .from(evalSuites)
      .where(eq(evalSuites.id, suiteId))
      .limit(1);
    if (!suite) return reply.code(404).send({ error: "Suite not found" });
    if (!(await requireEdit(req, suite.agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const { gating } = req.body as { gating?: boolean };
    if (typeof gating !== "boolean") {
      return reply.code(400).send({ error: "gating (boolean) is required" });
    }
    await db.update(evalSuites).set({ gating }).where(eq(evalSuites.id, suiteId));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.suite.update",
      targetType: "agent",
      targetId: suite.agentId,
      summary: `${gating ? "Marked" : "Unmarked"} eval suite "${suite.name}" as gating`,
    });
    return { ok: true };
  });

  app.get("/api/suites/:suiteId/cases", async (req) => {
    const { suiteId } = req.params as { suiteId: string };
    const rows = await db
      .select()
      .from(evalCases)
      .where(eq(evalCases.suiteId, suiteId))
      .orderBy(evalCases.createdAt);
    return {
      cases: rows.map((c) => ({
        id: c.id,
        suiteId: c.suiteId,
        name: c.name,
        input: c.input,
        rubric: c.rubric,
        sourceSessionId: c.sourceSessionId,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/suites/:suiteId/cases", async (req, reply) => {
    const { suiteId } = req.params as { suiteId: string };
    const [suite] = await db
      .select()
      .from(evalSuites)
      .where(eq(evalSuites.id, suiteId))
      .limit(1);
    if (!suite) return reply.code(404).send({ error: "Suite not found" });
    if (!(await requireEdit(req, suite.agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const body = createEvalCaseSchema.parse(req.body);
    const [row] = await db
      .insert(evalCases)
      .values({ suiteId, name: body.name, input: body.input, rubric: body.rubric })
      .returning();
    return { case: row };
  });

  // Freeze a real session into a suite as a test case
  app.post("/api/sessions/:sessionId/freeze", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const { suiteId, rubric } = req.body as { suiteId: string; rubric?: string };
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, req.user!.id)),
      )
      .limit(1);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const [suite] = await db
      .select()
      .from(evalSuites)
      .where(eq(evalSuites.id, suiteId))
      .limit(1);
    if (!suite) return reply.code(404).send({ error: "Suite not found" });
    if (!(await requireEdit(req, suite.agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt);
    const firstUser = history.find((m) => m.role === "user");
    if (!firstUser) return reply.code(400).send({ error: "Session has no messages" });

    const [row] = await db
      .insert(evalCases)
      .values({
        suiteId,
        name: session.title || "Frozen session",
        input: firstUser.content,
        rubric:
          rubric?.trim() ||
          "The reply should be materially equivalent in substance and quality to the recorded good response.",
        sourceSessionId: sessionId,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.case.freeze",
      targetType: "agent",
      targetId: suite.agentId,
      summary: `Froze session "${session.title}" into suite "${suite.name}"`,
    });
    return { case: row };
  });

  // Run a suite: execute each case against the agent's model, judge outputs
  app.post("/api/suites/:suiteId/run", async (req, reply) => {
    const { suiteId } = req.params as { suiteId: string };
    const [suite] = await db
      .select()
      .from(evalSuites)
      .where(eq(evalSuites.id, suiteId))
      .limit(1);
    if (!suite) return reply.code(404).send({ error: "Suite not found" });
    if (!(await requireEdit(req, suite.agentId))) {
      return reply.code(403).send({ error: "You need edit access on this agent" });
    }
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, suite.agentId))
      .limit(1);
    if (!agent?.modelId) {
      return reply.code(409).send({ error: "The agent has no model configured" });
    }
    const [model] = await db
      .select()
      .from(models)
      .where(eq(models.id, agent.modelId))
      .limit(1);
    if (!model) return reply.code(409).send({ error: "Model not found" });

    const caseCount = await db
      .select({ id: evalCases.id })
      .from(evalCases)
      .where(eq(evalCases.suiteId, suiteId));
    if (caseCount.length === 0) {
      return reply.code(409).send({ error: "This suite has no test cases yet" });
    }

    const outcomes = await executeSuiteCases(
      suiteId,
      { name: agent.name, description: agent.description, instructions: agent.instructions },
      model,
    );
    const runId = await recordSuiteRun(suiteId, outcomes);

    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.suite.run",
      targetType: "agent",
      targetId: suite.agentId,
      summary: `Ran suite "${suite.name}": ${outcomes.filter((r) => r.passed).length}/${outcomes.length} passed`,
    });
    return {
      run: {
        id: runId,
        status: "completed",
        results: outcomes.map((r) => ({
          caseId: r.caseId,
          passed: r.passed,
          output: r.output,
          reasoning: r.reasoning,
        })),
      },
    };
  });
}
