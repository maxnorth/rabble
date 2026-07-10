/**
 * Shared suite-case executor: runs a suite's cases against an agent
 * *snapshot* (name/description/instructions + model), so callers can test a
 * candidate configuration before it is saved — the mechanism behind gating.
 */
import { eq } from "drizzle-orm";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { db } from "../db/client.js";
import { caseResults, evalCases, suiteRuns, type models } from "../db/schema.js";
import { chatModelFor } from "../models/chat.js";
import { judgeText } from "./judge.js";

export interface AgentSnapshot {
  name: string;
  description: string;
  instructions: string;
  /**
   * Tone is a gated, behavior-affecting field (routes/agents.ts). It MUST be
   * part of the snapshot prompt, or gating a tone change runs against a prompt
   * with no tone and passes falsely — the gate would protect the very field
   * that triggered it against a prompt that can't exhibit it.
   */
  tone: string | null;
}

export interface CaseOutcome {
  caseId: string;
  caseName: string;
  passed: boolean;
  output: string;
  reasoning: string;
}

/**
 * The system prompt a suite case runs under. Kept in step with the fields the
 * production runtime feeds from agent config (name/description/instructions/
 * tone) so gating tests the agent as it will actually behave. Pure + exported
 * so the tone-inclusion is unit-tested rather than only exercised through a
 * live model call.
 */
export function snapshotSystemPrompt(agent: AgentSnapshot): string {
  return [
    `You are ${agent.name}. ${agent.description}`,
    agent.instructions,
    ...(agent.tone ? [`Tone & style: ${agent.tone}`] : []),
  ].join("\n\n");
}

/** Execute every case in the suite against the snapshot. Does NOT persist. */
export async function executeSuiteCases(
  suiteId: string,
  agent: AgentSnapshot,
  model: typeof models.$inferSelect,
): Promise<CaseOutcome[]> {
  const cases = await db
    .select()
    .from(evalCases)
    .where(eq(evalCases.suiteId, suiteId))
    .orderBy(evalCases.createdAt);

  const chat = await chatModelFor(model);
  const outcomes: CaseOutcome[] = [];
  const systemPrompt = snapshotSystemPrompt(agent);
  for (const testCase of cases) {
    const reply = await chat.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(testCase.input),
    ]);
    const output =
      typeof reply.content === "string"
        ? reply.content
        : reply.content
            .map((b) =>
              typeof b === "string" ? b : ((b as { text?: string }).text ?? ""),
            )
            .join("");
    const verdict = await judgeText(
      model,
      testCase.rubric,
      `The agent was asked:\n${testCase.input}\n\nThe agent replied:\n${output}`,
    );
    outcomes.push({
      caseId: testCase.id,
      caseName: testCase.name,
      passed: verdict.passed,
      output: output.slice(0, 5000),
      reasoning: verdict.reasoning,
    });
  }
  return outcomes;
}

/** Persist outcomes as a suite run (the shape the UI's "last run" reads). */
export async function recordSuiteRun(
  suiteId: string,
  outcomes: CaseOutcome[],
): Promise<string> {
  const [run] = await db
    .insert(suiteRuns)
    .values({ suiteId, status: "completed", completedAt: new Date() })
    .returning();
  for (const outcome of outcomes) {
    await db.insert(caseResults).values({
      runId: run!.id,
      caseId: outcome.caseId,
      passed: outcome.passed,
      output: outcome.output,
      reasoning: outcome.reasoning,
    });
  }
  return run!.id;
}
