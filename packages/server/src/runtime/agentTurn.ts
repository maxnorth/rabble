/**
 * Executes one agent turn on the LangChain Deep Agents SDK, with Rabble's
 * governance layered around it:
 *
 * - The agent's model and credentials come from the model registry.
 * - Its MCP servers (enabled tools only) are injected as callable tools.
 * - Every tool carries an auth type. Service tools run under the org
 *   credential; user tools pause the turn on an in-thread approval card
 *   (unless the user's approval posture is "auto").
 * - Every tool call is surfaced live (tool-start / tool-end) and recorded
 *   on the transcript.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { tool } from "@langchain/core/tools";
import { AIMessageChunk, isAIMessageChunk } from "@langchain/core/messages";
import { createDeepAgent } from "deepagents";
import {
  userPreferencesSchema,
  type ApprovalOutcome,
  type ToolCall,
} from "@rabblehq/core";
import { db } from "../db/client.js";
import {
  agentMcpServers,
  agentToolConfigs,
  mcpServers,
  type agents,
  type messages,
  type models,
  type users,
} from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { chatModelFor } from "../models/chat.js";
import { mcpCallTool } from "../mcp/client.js";
import { Channel } from "./channel.js";
import { requestApproval, type ApprovalDecision } from "./approvals.js";

interface AgentTurnInput {
  agent: typeof agents.$inferSelect;
  model: typeof models.$inferSelect | undefined;
  user: typeof users.$inferSelect;
  sessionId: string;
  history: Array<typeof messages.$inferSelect>;
  userContent: string;
  /** Org floor: when true, user-auth tools always prompt. */
  requireApproval: boolean;
  /** An earlier call in this session was already approved by this user. */
  sessionApproved: boolean;
}

export type AgentTurnEvent =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "tool-start"; toolCall: ToolCall }
  | { type: "tool-end"; toolCall: ToolCall }
  | {
      type: "approval-request";
      approvalId: string;
      toolName: string;
      serverName: string | null;
      input: unknown;
    };

function buildSystemPrompt(
  agent: typeof agents.$inferSelect,
  preferences: { responseStyle: string; suggestNextSteps: boolean },
): string {
  const parts = [
    `You are ${agent.name}, an agent operating inside Rabble, your organization's agent platform.`,
  ];
  if (agent.description) parts.push(`Your role: ${agent.description}`);
  if (agent.instructions) parts.push(agent.instructions);
  if (agent.tone) parts.push(`Tone & style: ${agent.tone}`);
  parts.push(
    preferences.responseStyle === "detailed"
      ? "The user prefers detailed replies with full reasoning."
      : "The user prefers concise, direct replies.",
  );
  if (!preferences.suggestNextSteps) {
    parts.push("Do not propose follow-up actions unless the user asks.");
  }
  return parts.join("\n\n");
}

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

/** Build governed LangChain tools from the agent's attached MCP servers. */
async function buildGovernedTools(
  input: AgentTurnInput,
  emit: (event: AgentTurnEvent) => void,
) {
  const attached = await db
    .select({ server: mcpServers })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(agentMcpServers.serverId, mcpServers.id))
    .where(eq(agentMcpServers.agentId, input.agent.id));
  if (attached.length === 0) return [];

  const configs = await db
    .select()
    .from(agentToolConfigs)
    .where(
      and(
        eq(agentToolConfigs.agentId, input.agent.id),
        inArray(
          agentToolConfigs.serverId,
          attached.map((a) => a.server.id),
        ),
      ),
    );
  const configFor = new Map(configs.map((c) => [`${c.serverId}:${c.toolName}`, c]));

  const preferences = userPreferencesSchema.parse({
    ...(input.user.preferences as Record<string, unknown>),
  });

  const tools = [];
  for (const { server } of attached) {
    const serverTools = (server.tools ?? []) as Array<{
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
    }>;
    for (const toolInfo of serverTools) {
      const config = configFor.get(`${server.id}:${toolInfo.name}`);
      if (config && !config.enabled) continue;
      const authType = config?.authType ?? "service";

      tools.push(
        tool(
          async (args: Record<string, unknown>) => {
            const callId = randomUUID();
            const startedAt = Date.now();
            const call: ToolCall = {
              id: callId,
              name: toolInfo.name,
              serverName: server.name,
              input: args,
              output: null,
              authType,
              approval: null,
            };
            emit({ type: "tool-start", toolCall: call });

            let approval: ApprovalOutcome | null = null;
            if (authType === "user") {
              const autoApprove =
                !input.requireApproval &&
                (preferences.approvalPosture === "trust" ||
                  (preferences.approvalPosture === "session" && input.sessionApproved));
              if (autoApprove) {
                approval = { status: "auto-approved", decidedByName: input.user.name };
              } else {
                const { approvalId, decision } = requestApproval({
                  sessionId: input.sessionId,
                  userId: input.user.id,
                });
                emit({
                  type: "approval-request",
                  approvalId,
                  toolName: toolInfo.name,
                  serverName: server.name,
                  input: args,
                });
                const result: ApprovalDecision = await decision;
                if (result === "deny" || result === "timed-out") {
                  approval = {
                    status: result === "deny" ? "denied" : "timed-out",
                    decidedByName: result === "deny" ? input.user.name : null,
                  };
                  const denied: ToolCall = {
                    ...call,
                    output: "The user declined this action.",
                    approval,
                    durationMs: Date.now() - startedAt,
                  };
                  emit({ type: "tool-end", toolCall: denied });
                  return "The user declined this action. Do not retry it; explain what you were unable to do.";
                }
                approval = {
                  status: result === "approve" ? "approved" : "ran-as-service",
                  decidedByName: input.user.name,
                };
              }
            }

            try {
              const output = await mcpCallTool(
                server.url,
                toolInfo.name,
                args,
                server.encryptedToken ? decryptSecret(server.encryptedToken) : null,
              );
              const finished: ToolCall = {
                ...call,
                output,
                approval,
                durationMs: Date.now() - startedAt,
              };
              emit({ type: "tool-end", toolCall: finished });
              return output;
            } catch (err) {
              const message = err instanceof Error ? err.message : "Tool call failed";
              const failed: ToolCall = {
                ...call,
                output: `Error: ${message}`,
                approval,
                durationMs: Date.now() - startedAt,
              };
              emit({ type: "tool-end", toolCall: failed });
              return `Error: ${message}`;
            }
          },
          {
            name: toolInfo.name,
            description:
              `${toolInfo.description} (via ${server.name}; runs as ` +
              `${authType === "service" ? "the org service account" : "the requesting user"})`,
            schema: toolInfo.inputSchema ?? { type: "object", properties: {} },
          },
        ),
      );
    }
  }
  return tools;
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

  const chatModel = await chatModelFor(input.model);
  const channel = new Channel<AgentTurnEvent>();
  const governedTools = await buildGovernedTools(input, (event) =>
    channel.push(event),
  );

  const turnPreferences = userPreferencesSchema.parse({
    ...(input.user.preferences as Record<string, unknown>),
  });
  const deepAgent = createDeepAgent({
    name: input.agent.slug,
    model: chatModel,
    systemPrompt: buildSystemPrompt(input.agent, turnPreferences),
    tools: governedTools,
  });

  const turnMessages = [
    ...input.history.map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
    { role: "user" as const, content: input.userContent },
  ];

  // Drive the graph in the background; all events flow through the channel.
  const run = (async () => {
    const stream = await deepAgent.stream(
      { messages: turnMessages },
      { streamMode: "messages", recursionLimit: 50 },
    );
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const item of stream) {
      const [chunk] = item as [unknown, unknown];
      if (isAIMessageChunk(chunk as AIMessageChunk)) {
        const aiChunk = chunk as AIMessageChunk;
        const text = chunkText(aiChunk.content);
        if (text) channel.push({ type: "text", text });
        if (aiChunk.usage_metadata) {
          inputTokens += aiChunk.usage_metadata.input_tokens ?? 0;
          outputTokens += aiChunk.usage_metadata.output_tokens ?? 0;
        }
      }
    }
    if (inputTokens || outputTokens) {
      channel.push({ type: "usage", inputTokens, outputTokens });
    }
  })();
  void run.finally(() => channel.close()).catch(() => channel.close());

  for await (const event of channel) {
    yield event;
  }
  await run; // surface graph errors after draining
}
