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

    const cases = await db
      .select()
      .from(evalCases)
      .where(eq(evalCases.suiteId, suiteId))
      .orderBy(evalCases.createdAt);
    if (cases.length === 0) {
      return reply.code(409).send({ error: "This suite has no test cases yet" });
    }

    const [run] = await db
      .insert(suiteRuns)
      .values({ suiteId, status: "running" })
      .returning();

    try {
      const chat = await chatModelFor(model);
      for (const testCase of cases) {
        const reply2 = await chat.invoke([
          new SystemMessage(
            `You are ${agent.name}. ${agent.description}\n\n${agent.instructions}`,
          ),
          new HumanMessage(testCase.input),
        ]);
        const output =
          typeof reply2.content === "string"
            ? reply2.content
            : reply2.content
                .map((b) =>
                  typeof b === "string" ? b : ((b as { text?: string }).text ?? ""),
                )
                .join("");
        const verdict = await judgeText(
          model,
          testCase.rubric,
          `The agent was asked:\n${testCase.input}\n\nThe agent replied:\n${output}`,
        );
        await db.insert(caseResults).values({
          runId: run!.id,
          caseId: testCase.id,
          passed: verdict.passed,
          output: output.slice(0, 5000),
          reasoning: verdict.reasoning,
        });
      }
      await db
        .update(suiteRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(suiteRuns.id, run!.id));
    } catch (err) {
      await db
        .update(suiteRuns)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(suiteRuns.id, run!.id));
      throw err;
    }

    const results = await db
      .select()
      .from(caseResults)
      .where(eq(caseResults.runId, run!.id));
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "eval.suite.run",
      targetType: "agent",
      targetId: suite.agentId,
      summary: `Ran suite "${suite.name}": ${results.filter((r) => r.passed).length}/${results.length} passed`,
    });
    return {
      run: {
        id: run!.id,
        status: "completed",
        results: results.map((r) => ({
          caseId: r.caseId,
          passed: r.passed,
          output: r.output,
          reasoning: r.reasoning,
        })),
      },
    };
  });
}
