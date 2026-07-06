/**
 * The eval judge: uses the agent's own model as an LLM judge to score live
 * sessions against criteria and suite cases against rubrics. Verdicts are
 * the PASS/FAIL first token of the reply; the rest is kept as reasoning.
 */
import { and, eq } from "drizzle-orm";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { db } from "../db/client.js";
import {
  evalCriteria,
  evalResults,
  messages,
  type agents,
  type models,
} from "../db/schema.js";
import { chatModelFor } from "../models/chat.js";

const JUDGE_SYSTEM =
  "You are a strict evaluation judge for an AI agent platform. " +
  "Assess whether the agent's behavior satisfies the criterion. " +
  "Respond with exactly PASS or FAIL on the first line, then one short sentence of reasoning.";

export interface Verdict {
  passed: boolean;
  reasoning: string;
}

export async function judgeText(
  model: typeof models.$inferSelect,
  criterion: string,
  content: string,
): Promise<Verdict> {
  const chat = await chatModelFor(model);
  const reply = await chat.invoke([
    new SystemMessage(JUDGE_SYSTEM),
    new HumanMessage(
      `Criterion: ${criterion}\n\n${content}\n\nRespond with exactly PASS or FAIL on the first line, then a short reason.`,
    ),
  ]);
  const text =
    typeof reply.content === "string"
      ? reply.content
      : reply.content
          .map((b) => (typeof b === "string" ? b : ((b as { text?: string }).text ?? "")))
          .join("");
  const firstLine = text.trim().split("\n")[0] ?? "";
  const passed = /\bPASS\b/i.test(firstLine) && !/\bFAIL\b/i.test(firstLine);
  const reasoning = text.trim().split("\n").slice(1).join(" ").trim() || firstLine;
  return { passed, reasoning: reasoning.slice(0, 500) };
}

/** Evaluate a session against the agent's enabled live criteria. */
export async function judgeSession(input: {
  sessionId: string;
  agent: typeof agents.$inferSelect;
  model: typeof models.$inferSelect | undefined;
}): Promise<void> {
  if (!input.model) return;
  const criteria = await db
    .select()
    .from(evalCriteria)
    .where(
      and(eq(evalCriteria.agentId, input.agent.id), eq(evalCriteria.enabled, true)),
    );
  if (criteria.length === 0) return;

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, input.sessionId))
    .orderBy(messages.createdAt);
  const transcript = history
    .map((m) => `${m.role === "user" ? "User" : input.agent.name}: ${m.content}`)
    .join("\n")
    .slice(-8000);

  for (const criterion of criteria) {
    const verdict = await judgeText(
      input.model,
      `${criterion.name}${criterion.description ? ` — ${criterion.description}` : ""}`,
      `Transcript:\n${transcript}`,
    );
    // Keep only the latest verdict per (criterion, session)
    await db
      .delete(evalResults)
      .where(
        and(
          eq(evalResults.criterionId, criterion.id),
          eq(evalResults.sessionId, input.sessionId),
        ),
      );
    await db.insert(evalResults).values({
      criterionId: criterion.id,
      sessionId: input.sessionId,
      passed: verdict.passed,
      reasoning: verdict.reasoning,
    });
  }
}
