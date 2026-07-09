/**
 * The user-auth consent gate, shared by every governed tool source (MCP
 * tools and the Builder's platform tools). A user-auth call either
 * auto-approves (trust posture / session posture), pauses on the approval
 * broker (in-thread card, or an out-of-band prompt like Slack DM buttons),
 * or is refused outright when the surface can't host a prompt.
 */
import type { ApprovalOutcome, ToolCall } from "@rabblehq/core";
import { requestApproval, type ApprovalDecision } from "./approvals.js";

export interface GateContext {
  sessionId: string;
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

export type GateResult =
  | { outcome: "proceed"; approval: ApprovalOutcome | null }
  | { outcome: "refused"; approval: ApprovalOutcome; toolOutput: string; modelText: string };

export async function gateUserAuth(
  ctx: GateContext,
  call: ToolCall,
): Promise<GateResult> {
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

  if (!ctx.interactive && !ctx.approvalPrompt) {
    // No way to prompt on this surface — refuse the action.
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

  const { approvalId, decision } = requestApproval({
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    toolName: call.name,
    serverName: call.serverName ?? null,
    input: call.input,
  });
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
  const result: ApprovalDecision = await decision;
  if (result === "deny" || result === "timed-out") {
    return {
      outcome: "refused",
      approval: {
        status: result === "deny" ? "denied" : "timed-out",
        decidedByName: result === "deny" ? ctx.userName : null,
      },
      toolOutput: "The user declined this action.",
      modelText:
        "The user declined this action. Do not retry it; explain what you were unable to do.",
    };
  }
  return {
    outcome: "proceed",
    approval: {
      status: result === "approve" ? "approved" : "ran-as-service",
      decidedByName: ctx.userName,
    },
  };
}
