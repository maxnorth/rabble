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

/**
 * Parse a judge reply into a verdict. Pass only when the first line asserts
 * PASS and not FAIL — FAIL wins any ambiguous line, a conservative default
 * (a graded miss should never read as a pass). Everything after the first
 * line is the reasoning, falling back to the line itself when it's the only
 * one; capped so a runaway judge can't bloat the row.
 */
export function parseVerdict(text: string): Verdict {
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n")[0] ?? "";
  const passed = /\bPASS\b/i.test(firstLine) && !/\bFAIL\b/i.test(firstLine);
  const reasoning = trimmed.split("\n").slice(1).join(" ").trim() || firstLine;
  return { passed, reasoning: reasoning.slice(0, 500) };
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
  return parseVerdict(text);
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

  // Pulse-back: a sagging 7-day pass rate pings the agent's owner.
  const { checkPassRateAlert } = await import("./alerts.js");
  void checkPassRateAlert(input.agent.id);
}
