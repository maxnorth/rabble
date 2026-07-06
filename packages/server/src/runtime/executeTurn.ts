/**
 * Non-streaming turn execution: run the governed agent runtime to
 * completion and persist the transcript. Shared by surfaces that don't
 * hold an open stream to a browser (Slack delivery, automation runs) —
 * the web SSE route streams instead and persists inline.
 */
import { eq } from "drizzle-orm";
import type { ToolCall } from "@rabblehq/core";
import { db } from "../db/client.js";
import {
  messages,
  sessions,
  type agents,
  type models,
  type users,
} from "../db/schema.js";
import { runAgentTurn } from "./agentTurn.js";
import { judgeSession } from "../evals/judge.js";

export interface ExecuteTurnInput {
  sessionId: string;
  agent: typeof agents.$inferSelect;
  model: typeof models.$inferSelect | undefined;
  user: typeof users.$inferSelect;
  content: string;
  requireApproval: boolean;
  sessionApproved: boolean;
  interactive: boolean;
}

export interface ExecuteTurnResult {
  fullText: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

export async function executeTurnAndPersist(
  input: ExecuteTurnInput,
): Promise<ExecuteTurnResult> {
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, input.sessionId))
    .orderBy(messages.createdAt);
  await db
    .insert(messages)
    .values({ sessionId: input.sessionId, role: "user", content: input.content });

  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: ToolCall[] = [];
  for await (const event of runAgentTurn({
    agent: input.agent,
    model: input.model,
    user: input.user,
    sessionId: input.sessionId,
    history,
    userContent: input.content,
    requireApproval: input.requireApproval,
    sessionApproved: input.sessionApproved,
    interactive: input.interactive,
  })) {
    if (event.type === "text") fullText += event.text;
    else if (event.type === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
    } else if (event.type === "tool-end") {
      toolCalls.push(event.toolCall);
    }
  }

  await db.insert(messages).values({
    sessionId: input.sessionId,
    role: "agent",
    content: fullText,
    toolCalls,
    inputTokens,
    outputTokens,
    modelId: input.model?.id ?? null,
  });
  await db
    .update(sessions)
    .set({ updatedAt: new Date() })
    .where(eq(sessions.id, input.sessionId));

  if (input.model) {
    void judgeSession({
      sessionId: input.sessionId,
      agent: input.agent,
      model: input.model,
    }).catch(() => {
      /* judged best-effort; failures are visible in criteria coverage */
    });
  }

  return { fullText, toolCalls, inputTokens, outputTokens };
}
