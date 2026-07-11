/**
 * The agent gate, shared by every path that can change an agent's behavior
 * (the HTTP PATCH route and the Builder's update tools). Behavior-affecting
 * changes must pass the agent's gating suites against the CANDIDATE
 * configuration before anything is saved; a failing case blocks the change.
 * One implementation so the Builder can never drift from the config tabs.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { evalCases, evalSuites, models, type agents } from "../db/schema.js";
import { recordAudit } from "../audit.js";
import { executeSuiteCases, recordSuiteRun } from "./suiteRunner.js";

export interface GateCandidate {
  name: string;
  description: string;
  instructions: string;
  tone: string;
  modelId: string | null;
}

export type GateResult =
  | { ok: true; ran: number }
  | {
      ok: false;
      error: string;
      block?: {
        suiteId: string;
        suiteName: string;
        failures: Array<{ caseName: string; reasoning: string }>;
      };
    };

export function behaviorChanged(
  current: typeof agents.$inferSelect,
  candidate: GateCandidate,
): boolean {
  return (
    candidate.instructions !== current.instructions ||
    candidate.description !== current.description ||
    candidate.name !== current.name ||
    candidate.tone !== current.tone ||
    candidate.modelId !== current.modelId
  );
}

/** Run the agent's gating suites against a candidate config. Assumes the
 * caller already verified edit rights and computed behaviorChanged. */
export async function runAgentGate(opts: {
  orgId: string;
  actorUserId: string;
  agent: typeof agents.$inferSelect;
  candidate: GateCandidate;
}): Promise<GateResult> {
  const { orgId, actorUserId, agent, candidate } = opts;
  const gatingSuites = await db
    .select()
    .from(evalSuites)
    .where(and(eq(evalSuites.agentId, agent.id), eq(evalSuites.gating, true)));
  const [model] = candidate.modelId
    ? await db.select().from(models).where(eq(models.id, candidate.modelId)).limit(1)
    : [];

  // Gating suites can't run without a model — refuse to save silently
  // ungated rather than let a regression slip through the hole.
  if (gatingSuites.length > 0 && !model) {
    const withCases = [];
    for (const suite of gatingSuites) {
      const cases = await db
        .select({ id: evalCases.id })
        .from(evalCases)
        .where(eq(evalCases.suiteId, suite.id));
      if (cases.length > 0) withCases.push(suite);
    }
    if (withCases.length > 0) {
      return {
        ok: false,
        error:
          `This agent has gating suites (${withCases.map((g) => `"${g.name}"`).join(", ")}) ` +
          "but no model to run them against. Pick a model, or unmark the suites as gating.",
      };
    }
  }

  let ran = 0;
  if (model) {
    for (const suite of gatingSuites) {
      const cases = await db
        .select({ id: evalCases.id })
        .from(evalCases)
        .where(eq(evalCases.suiteId, suite.id));
      if (cases.length === 0) continue;
      const outcomes = await executeSuiteCases(
        suite.id,
        {
          name: candidate.name,
          description: candidate.description,
          instructions: candidate.instructions,
          tone: candidate.tone,
        },
        model,
      );
      await recordSuiteRun(suite.id, outcomes);
      ran += outcomes.length;
      const failed = outcomes.filter((o) => !o.passed);
      if (failed.length > 0) {
        await recordAudit({
          orgId,
          actorUserId,
          action: "eval.gate.block",
          targetType: "agent",
          targetId: agent.id,
          summary:
            `Gating suite "${suite.name}" blocked a change to ` +
            `"${agent.name}" (${failed.length}/${outcomes.length} cases failed)`,
          metadata: {
            suiteId: suite.id,
            failures: failed.map((f) => ({ case: f.caseName, reasoning: f.reasoning })),
          },
        });
        return {
          ok: false,
          error:
            `Blocked by gating suite "${suite.name}": ` +
            `${failed.length} of ${outcomes.length} cases failed ` +
            `(${failed.map((f) => f.caseName).join(", ")}). ` +
            "The change was not saved.",
          block: {
            suiteId: suite.id,
            suiteName: suite.name,
            failures: failed.map((f) => ({
              caseName: f.caseName,
              reasoning: f.reasoning,
            })),
          },
        };
      }
      await recordAudit({
        orgId,
        actorUserId,
        action: "eval.gate.pass",
        targetType: "agent",
        targetId: agent.id,
        summary: `Gating suite "${suite.name}" passed (${outcomes.length}/${outcomes.length}) for a change to "${agent.name}"`,
      });
    }
  }
  return { ok: true, ran };
}
