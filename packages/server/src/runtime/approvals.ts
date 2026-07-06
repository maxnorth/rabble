/**
 * In-memory broker for in-thread tool approvals. When an agent invokes a
 * user-auth tool, the turn pauses on a pending approval; the approval card
 * in the session UI resolves it (approve / deny / run as service account).
 * Unanswered requests time out as denials.
 */
import { randomUUID } from "node:crypto";

export type ApprovalDecision = "approve" | "deny" | "run-as-service" | "timed-out";

interface Pending {
  sessionId: string;
  userId: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

const APPROVAL_TIMEOUT_MS = 120_000;

export function requestApproval(input: {
  sessionId: string;
  userId: string;
}): { approvalId: string; decision: Promise<ApprovalDecision> } {
  const approvalId = randomUUID();
  const decision = new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(approvalId);
      resolve("timed-out");
    }, APPROVAL_TIMEOUT_MS);
    pending.set(approvalId, {
      sessionId: input.sessionId,
      userId: input.userId,
      resolve: (d) => {
        clearTimeout(timer);
        pending.delete(approvalId);
        resolve(d);
      },
      timer,
    });
  });
  return { approvalId, decision };
}

/** Returns false when the approval is unknown or not the caller's to decide. */
export function decideApproval(
  approvalId: string,
  sessionId: string,
  userId: string,
  decision: Exclude<ApprovalDecision, "timed-out">,
): boolean {
  const entry = pending.get(approvalId);
  if (!entry || entry.sessionId !== sessionId || entry.userId !== userId) {
    return false;
  }
  entry.resolve(decision);
  return true;
}
