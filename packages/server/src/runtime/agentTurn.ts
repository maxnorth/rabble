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
  agentLinks,
  agentMcpServers,
  agentToolConfigs,
  agents as agentsTable,
  mcpServers,
  sessions,
  type agents,
  type messages,
  type models,
  type users,
} from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { chatModelFor } from "../models/chat.js";
import { resolveAgentModel } from "../models/resolve.js";
import { mcpCallTool } from "../mcp/client.js";
import { recordAudit } from "../audit.js";
import { Channel } from "./channel.js";
import { gateUserAuth, type GateContext } from "./userAuthGate.js";
import { buildPlatformTools } from "./platformTools.js";

// How deep a chain of agents-calling-agents may go. Bounded delegation is a
// product pillar, not open-ended recursion — a parent may delegate, and its
// sub-agent may delegate once more, but the chain stops there.
const MAX_DELEGATION_DEPTH = 3;

export interface AgentTurnInput {
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
  /**
   * Whether the surface can host an approval prompt. Non-interactive
   * surfaces auto-deny user-auth tools that would need one — unless the
   * caller supplies approvalPrompt, which delivers the ask out-of-band
   * (e.g. Slack DM buttons) and the broker still arbitrates the decision.
   */
  interactive: boolean;
  approvalPrompt?: (request: {
    approvalId: string;
    toolName: string;
    serverName: string | null;
    input: unknown;
  }) => Promise<void>;
  /**
   * Delegation bookkeeping for agents-calling-agents. `delegationChain` is
   * the agent ids already on the call stack (root first), used to bound depth
   * and refuse cycles; absent/empty for a top-level turn.
   */
  delegationChain?: string[];
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

export function buildSystemPrompt(
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

export function gateContextFor(
  input: AgentTurnInput,
  preferences: { approvalPosture: string },
  emit: (event: AgentTurnEvent) => void,
): GateContext {
  return {
    sessionId: input.sessionId,
    userId: input.user.id,
    userName: input.user.name,
    requireApproval: input.requireApproval,
    sessionApproved: input.sessionApproved,
    interactive: input.interactive,
    approvalPosture: preferences.approvalPosture,
    approvalPrompt: input.approvalPrompt,
    emit,
  };
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
              const gate = await gateUserAuth(gateContextFor(input, preferences, emit), call);
              if (gate.outcome === "refused") {
                const denied: ToolCall = {
                  ...call,
                  output: gate.toolOutput,
                  approval: gate.approval,
                  durationMs: Date.now() - startedAt,
                };
                emit({ type: "tool-end", toolCall: denied });
                return gate.modelText;
              }
              approval = gate.approval;
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

/** Sanitize an agent slug into a valid, prefixed tool name. */
export function subAgentToolName(slug: string): string {
  return `ask_${slug}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

/**
 * Which linked children may be offered as delegation tools given the current
 * call stack. The safety guard for agents-calling-agents: nothing is offered
 * once the chain has reached MAX_DELEGATION_DEPTH, and a child already
 * somewhere above us in the stack is dropped so A→B→A can't loop. Pure so the
 * bound is unit-tested rather than only exercised through a live turn.
 */
export function delegableChildIds(
  childIds: string[],
  chain: string[],
  maxDepth: number = MAX_DELEGATION_DEPTH,
): string[] {
  if (chain.length >= maxDepth) return [];
  const onStack = new Set(chain);
  return childIds.filter((id) => !onStack.has(id));
}

/**
 * Build governed tools for the agents this one is wired to call (the "Agents"
 * config tab). Each linked sub-agent becomes a callable tool whose body runs
 * that agent as a nested, non-interactive turn under the SAME user — so the
 * child's own model, MCP tools, and auth gates apply and governance composes.
 * The edge's note becomes the tool description, telling the model when to
 * delegate. Depth and cycles are bounded: a sub-agent already on the call
 * stack, or one past MAX_DELEGATION_DEPTH, is not offered.
 */
async function buildSubAgentTools(
  input: AgentTurnInput,
  emit: (event: AgentTurnEvent) => void,
) {
  const chain = input.delegationChain ?? [];
  if (chain.length >= MAX_DELEGATION_DEPTH) return [];

  const links = await db
    .select({ child: agentsTable, note: agentLinks.note })
    .from(agentLinks)
    .innerJoin(agentsTable, eq(agentLinks.subAgentId, agentsTable.id))
    .where(eq(agentLinks.agentId, input.agent.id));

  const offerable = new Set(
    delegableChildIds(
      links.map((l) => l.child.id),
      chain,
    ),
  );
  const tools = [];
  for (const { child, note } of links) {
    // Depth cap + cycle guard (see delegableChildIds).
    if (!offerable.has(child.id)) continue;

    const toolName = subAgentToolName(child.slug);
    tools.push(
      tool(
        async (args: Record<string, unknown>) => {
          const task = String(args.task ?? "");
          const callId = randomUUID();
          const startedAt = Date.now();
          const call: ToolCall = {
            id: callId,
            name: toolName,
            serverName: child.name,
            input: args,
            output: null,
            authType: "service",
            approval: null,
          };
          emit({ type: "tool-start", toolCall: call });

          // Everything runs inside one guard so a tool-end with a concrete
          // string output is ALWAYS emitted — the delegation call can never be
          // left dangling with a null output (which the UI would flag as a
          // failed/incomplete call).
          let output: string;
          let childSessionId: string | null = null;
          try {
            const childModel = await resolveAgentModel(child);
            if (!childModel) {
              throw new Error(`${child.name} has no model configured, so it can't run.`);
            }
            // The delegated turn is a real, governed session of the child —
            // persisted, judged, and viewable — so delegated work lands on the
            // child's own track record and the edge is fully auditable (not
            // just an ephemeral tool call). It runs as the same user, with the
            // call stack threaded so nested delegation stays bounded.
            const [childSession] = await db
              .insert(sessions)
              .values({
                orgId: child.orgId,
                userId: input.user.id,
                agentId: child.id,
                title: task.length > 60 ? `${task.slice(0, 57)}…` : task,
                surface: `Delegated by ${input.agent.name}`,
              })
              .returning();
            childSessionId = childSession!.id;
            const { executeTurnAndPersist } = await import("./executeTurn.js");
            const result = await executeTurnAndPersist({
              sessionId: childSession!.id,
              agent: child,
              model: childModel,
              user: input.user,
              content: task,
              requireApproval: input.requireApproval,
              sessionApproved: input.sessionApproved,
              // A nested turn has no surface of its own to prompt on.
              interactive: false,
              delegationChain: [...chain, input.agent.id],
            });
            output = result.fullText || `${child.name} returned no reply.`;
            await recordAudit({
              orgId: input.agent.orgId,
              actorUserId: input.user.id,
              action: "agent.delegate",
              targetType: "agent",
              targetId: child.id,
              summary: `${input.agent.name} delegated a task to ${child.name}`,
              metadata: {
                parentAgentId: input.agent.id,
                sessionId: input.sessionId,
                childSessionId: childSession!.id,
              },
            });
          } catch (err) {
            output = `Error: ${err instanceof Error ? err.message : "delegation failed"}`;
          }

          emit({
            type: "tool-end",
            toolCall: {
              ...call,
              output,
              childSessionId,
              durationMs: Date.now() - startedAt,
            },
          });
          return output;
        },
        {
          name: toolName,
          description:
            (note?.trim() ? `${note.trim()} ` : "") +
            `Delegate a task to ${child.name}` +
            (child.description ? ` (${child.description})` : "") +
            `. Pass the full task as "task"; the agent runs and returns its reply.`,
          schema: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "The task or question to hand to this agent.",
              },
            },
            required: ["task"],
          },
        },
      ),
    );
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
  if (input.agent.builtin === "builder") {
    // The Builder operates the platform itself through governed tools —
    // same inline tool-call UI, same consent gate, audited "via Builder".
    governedTools.push(
      ...buildPlatformTools(input, (event) => channel.push(event)),
    );
  }
  // Agents this one is wired to call become governed, callable tools — the
  // "bounded delegation" pillar. Included in the tool set below, so a
  // delegation is never misread as a scope violation.
  governedTools.push(
    ...(await buildSubAgentTools(input, (event) => channel.push(event))),
  );

  // Anything the model tries to call outside this set is a scope violation:
  // the governed tools it was given, plus the runtime's own built-ins.
  const RUNTIME_BUILTINS = new Set([
    "write_todos",
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "task",
  ]);
  const allowedTools = new Set([
    ...governedTools.map((t) => t.name),
    ...RUNTIME_BUILTINS,
  ]);
  const attemptedTools = new Set<string>();

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
        for (const call of aiChunk.tool_call_chunks ?? []) {
          if (call.name) attemptedTools.add(call.name);
        }
        if (aiChunk.usage_metadata) {
          inputTokens += aiChunk.usage_metadata.input_tokens ?? 0;
          outputTokens += aiChunk.usage_metadata.output_tokens ?? 0;
        }
      }
    }
    const violations = [...attemptedTools].filter((n) => !allowedTools.has(n));
    if (violations.length > 0) {
      const { scopeViolations } = await import("../db/schema.js");
      for (const toolName of violations) {
        await db.insert(scopeViolations).values({
          orgId: input.agent.orgId,
          agentId: input.agent.id,
          sessionId: input.sessionId,
          toolName,
        });
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
