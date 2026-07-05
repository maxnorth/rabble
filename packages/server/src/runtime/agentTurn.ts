/**
 * Executes one agent turn on top of the LangChain Deep Agents SDK
 * (`deepagents`, LangGraph-based). Rabble resolves the agent's model and
 * credentials from its own registry, hands the turn to a deep agent, and
 * normalizes the run into a stream of events (text deltas + tool calls).
 *
 * The SDK's built-ins (planning todos, virtual filesystem, sub-agents) come
 * for free; Rabble-governed tools (MCP, grants, service-vs-user auth,
 * approval interrupts via `interruptOn`) attach here as the platform grows.
 */
import { and, eq } from "drizzle-orm";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  isAIMessage,
  isAIMessageChunk,
  isToolMessage,
} from "@langchain/core/messages";
import { createDeepAgent } from "deepagents";
import type { ToolCall } from "@rabble/core";
import { db } from "../db/client.js";
import { providerKeys, type agents, type messages, type models } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { env } from "../env.js";
import { getCatalogModel } from "../models/catalog.js";

interface AgentTurnInput {
  agent: typeof agents.$inferSelect;
  model: typeof models.$inferSelect | undefined;
  history: Array<typeof messages.$inferSelect>;
  userContent: string;
}

export type AgentTurnEvent =
  | { type: "text"; text: string }
  | { type: "tool"; toolCall: ToolCall };

async function resolveApiKey(
  model: typeof models.$inferSelect,
): Promise<string> {
  // Custom models carry their own key.
  if (model.encryptedKey) return decryptSecret(model.encryptedKey);

  // Built-in models use the org-level provider key, falling back to the
  // server environment.
  const provider = model.catalogId
    ? (getCatalogModel(model.catalogId)?.provider ?? "anthropic")
    : "anthropic";
  const [row] = await db
    .select()
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.orgId, model.orgId),
        eq(providerKeys.provider, provider),
      ),
    )
    .limit(1);
  if (row) return decryptSecret(row.encryptedKey);
  if (provider === "anthropic" && env.anthropicApiKey) return env.anthropicApiKey;
  throw new Error(
    `No API key configured for provider "${provider}". Add one in Admin > Models.`,
  );
}

function buildChatModel(
  model: typeof models.$inferSelect,
  apiKey: string,
): BaseChatModel {
  if (model.protocol === "anthropic") {
    return new ChatAnthropic({
      model: model.modelId,
      apiKey,
      maxTokens: 4096,
      ...(model.baseUrl ? { anthropicApiUrl: model.baseUrl } : {}),
    });
  }
  return new ChatOpenAI({
    model: model.modelId,
    apiKey,
    configuration: model.baseUrl ? { baseURL: model.baseUrl } : undefined,
  });
}

function buildSystemPrompt(agent: typeof agents.$inferSelect): string {
  const parts = [
    `You are ${agent.name}, an agent operating inside Rabble, your organization's agent platform.`,
  ];
  if (agent.description) parts.push(`Your role: ${agent.description}`);
  if (agent.instructions) parts.push(agent.instructions);
  return parts.join("\n\n");
}

/** Extract plain text from a message chunk's content (string or block array). */
function chunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

export async function* runAgentTurn(
  input: AgentTurnInput,
): AsyncGenerator<AgentTurnEvent> {
  if (!input.model) {
    throw new Error(
      `Agent "${input.agent.name}" has no model configured. Pick one on the agent's identity tab.`,
    );
  }
  if (!input.model.enabled) {
    throw new Error(`Model "${input.model.displayName}" is disabled.`);
  }

  const apiKey = await resolveApiKey(input.model);
  const deepAgent = createDeepAgent({
    name: input.agent.slug,
    model: buildChatModel(input.model, apiKey),
    systemPrompt: buildSystemPrompt(input.agent),
  });

  const turnMessages = [
    ...input.history.map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
    { role: "user" as const, content: input.userContent },
  ];

  // "messages" streams LLM tokens; "updates" carries completed node output
  // (tool executions, final messages) so tool calls can be recorded.
  const stream = await deepAgent.stream(
    { messages: turnMessages },
    { streamMode: ["messages", "updates"], recursionLimit: 50 },
  );

  // Tool inputs live on AI messages (tool_calls), outputs on ToolMessages —
  // stitch the two together by tool_call_id as updates arrive.
  const pendingToolInputs = new Map<string, { name: string; input: unknown }>();

  for await (const item of stream) {
    const [mode, payload] = item as [string, unknown];

    if (mode === "messages") {
      const [chunk] = payload as [unknown, unknown];
      if (isAIMessageChunk(chunk as AIMessageChunk)) {
        const text = chunkText((chunk as AIMessageChunk).content);
        if (text) yield { type: "text", text };
      }
      continue;
    }

    if (mode === "updates") {
      const update = payload as Record<
        string,
        { messages?: unknown[] } | undefined
      >;
      for (const nodeOutput of Object.values(update)) {
        for (const message of nodeOutput?.messages ?? []) {
          if (isAIMessage(message as AIMessage)) {
            for (const call of (message as AIMessage).tool_calls ?? []) {
              if (call.id) {
                pendingToolInputs.set(call.id, {
                  name: call.name,
                  input: call.args,
                });
              }
            }
          } else if (isToolMessage(message as ToolMessage)) {
            const toolMessage = message as ToolMessage;
            const pending = pendingToolInputs.get(toolMessage.tool_call_id);
            yield {
              type: "tool",
              toolCall: {
                id: toolMessage.tool_call_id,
                name: pending?.name ?? toolMessage.name ?? "tool",
                input: pending?.input ?? null,
                output: chunkText(toolMessage.content) || null,
                authType: null,
              },
            };
          }
        }
      }
    }
  }
}
