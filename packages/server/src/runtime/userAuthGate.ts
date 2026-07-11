/**
 * The user-auth consent gate, shared by every governed tool source (MCP
 * tools and the Builder's platform tools). A user-auth call either
 * auto-approves (trust posture / session posture), is refused outright when
 * the surface can't host a prompt, or goes PENDING: the ask is recorded
 * durably, surfaced on every surface (web card, Slack DM buttons), and the
 * tool returns immediately — the turn never blocks on a human. On approval
 * the platform executes the recorded call verbatim and notifies the agent
 * in a follow-up turn (runtime/approvalDecide.ts). See DECISIONS.md
 * "Approvals are asynchronous".
 */
import type { ApprovalOutcome, ToolCall } from "@rabblehq/core";
import { db } from "../db/client.js";
import { approvals } from "../db/schema.js";

export interface GateContext {
  sessionId: string;
  orgId: string;
  agentId: string;
  userId: string;
  userName: string;
  /** Org floor: when true, user-auth tools always prompt. */
  requireApproval: boolean;
  sessionApproved: boolean;
  interactive: boolean;
  approvalPosture: string;
  approvalPrompt?: (request: {
    approvalId: string;
    toolName: string;
    serverName: string | null;
    input: unknown;
  }) => Promise<void>;
  emit: (event: {
    type: "approval-request";
    approvalId: string;
    toolName: string;
    serverName: string | null;
    input: unknown;
  }) => void;
}

/** What the durable executor needs to re-run the call on approval. */
export interface GateCallMeta {
  kind: "mcp" | "platform";
  serverId?: string | null;
}

export type GateResult =
  | { outcome: "proceed"; approval: ApprovalOutcome | null }
  | { outcome: "refused"; approval: ApprovalOutcome; toolOutput: string; modelText: string }
  | { outcome: "pending"; approval: ApprovalOutcome; toolOutput: string; modelText: string };

export async function gateUserAuth(
  ctx: GateContext,
  call: ToolCall,
  meta: GateCallMeta,
): Promise<GateResult> {
  // A surface with no way to prompt (a delegated sub-agent turn, an
  // automation, an inbound event without an out-of-band prompt) can never
  // surface this action to the user — so refuse it BEFORE considering any
  // auto-approval. "Trust" posture means "don't ask me in my own sessions,"
  // not "silently act as me in a nested turn I can't see"; letting trust
  // auto-approve here would run a user-auth write with no consent path and
  // break the delegation guarantee that a parent's session never authorizes
  // a different agent.
  if (!ctx.interactive && !ctx.approvalPrompt) {
    return {
      outcome: "refused",
      approval: { status: "denied", decidedByName: null },
      toolOutput:
        "Approvals aren't available on this surface yet. Run this from the web app.",
      modelText:
        "This action needs the user's approval, which isn't possible on " +
        "this surface. Tell the user to run it from the Rabble web app.",
    };
  }

  const autoApprove =
    !ctx.requireApproval &&
    (ctx.approvalPosture === "trust" ||
      (ctx.approvalPosture === "session" && ctx.sessionApproved));
  if (autoApprove) {
    return {
      outcome: "proceed",
      approval: { status: "auto-approved", decidedByName: ctx.userName },
    };
  }

  // Async ask: record it durably and move on. The decision can land hours
  // later, from any surface, even after a restart.
  const [row] = await db
    .insert(approvals)
    .values({
      orgId: ctx.orgId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      kind: meta.kind,
      toolName: call.name,
      serverId: meta.serverId ?? null,
      serverName: call.serverName ?? null,
      input: call.input ?? {},
    })
    .returning({ id: approvals.id });
  const approvalId = row!.id;

  if (!ctx.interactive && ctx.approvalPrompt) {
    // Deliver the ask where the user actually is.
    void ctx
      .approvalPrompt({
        approvalId,
        toolName: call.name,
        serverName: call.serverName ?? null,
        input: call.input,
      })
      .catch(() => {});
  }
  ctx.emit({
    type: "approval-request",
    approvalId,
    toolName: call.name,
    serverName: call.serverName ?? null,
    input: call.input,
  });

  return {
    outcome: "pending",
    approval: { status: "pending", decidedByName: null, approvalId },
    toolOutput: `Queued for ${ctx.userName}'s approval.`,
    modelText:
      `This action needs ${ctx.userName}'s approval and has been queued — ` +
      "you are not blocked. When it's decided, the platform will run it " +
      "exactly as asked (or not, if declined) and post the outcome into " +
      "this conversation. Do NOT retry or re-issue this call; continue " +
      "with anything that doesn't depend on it, or wrap up for now.",
  };
}
