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
  toolName: string;
  serverName: string | null;
  input: unknown;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

// Overridable so tests (and impatient orgs) can tighten the window.
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000);

export function requestApproval(input: {
  sessionId: string;
  userId: string;
  toolName?: string;
  serverName?: string | null;
  input?: unknown;
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
      toolName: input.toolName ?? "tool",
      serverName: input.serverName ?? null,
      input: input.input ?? null,
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

/** Pending approvals a given user can decide on a session (for UI resume). */
export function pendingApprovalsFor(
  sessionId: string,
  userId: string,
): Array<{ approvalId: string; toolName: string; serverName: string | null; input: unknown }> {
  return [...pending.entries()]
    .filter(([, p]) => p.sessionId === sessionId && p.userId === userId)
    .map(([approvalId, p]) => ({
      approvalId,
      toolName: p.toolName,
      serverName: p.serverName,
      input: p.input,
    }));
}

// --- Personal-credential connect asks -------------------------------------
// Same pause/resume shape as approvals, but resolved by the user CONNECTING
// a credential (PUT /api/me/mcp-credentials/:serverId) rather than clicking
// a decision — so resolution is keyed by (user, server), not by ask id.

export type ConnectDecision = "connected" | "timed-out";

interface PendingConnect {
  sessionId: string;
  userId: string;
  serverId: string;
  serverName: string;
  resolve: (decision: ConnectDecision) => void;
}

const pendingConnects = new Map<string, PendingConnect>();

export function requestConnect(input: {
  sessionId: string;
  userId: string;
  serverId: string;
  serverName: string;
}): { connectId: string; decision: Promise<ConnectDecision> } {
  const connectId = randomUUID();
  const decision = new Promise<ConnectDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingConnects.delete(connectId);
      resolve("timed-out");
    }, APPROVAL_TIMEOUT_MS);
    pendingConnects.set(connectId, {
      ...input,
      resolve: (d) => {
        clearTimeout(timer);
        pendingConnects.delete(connectId);
        resolve(d);
      },
    });
  });
  return { connectId, decision };
}

/** A credential landed: release every turn waiting on this (user, server). */
export function resolveConnects(userId: string, serverId: string): void {
  for (const p of [...pendingConnects.values()]) {
    if (p.userId === userId && p.serverId === serverId) p.resolve("connected");
  }
}

/** Pending connect asks for a session, for GET-session hydration. */
export function pendingConnectsFor(
  sessionId: string,
  userId: string,
): Array<{ connectId: string; serverId: string; serverName: string }> {
  return [...pendingConnects.entries()]
    .filter(([, p]) => p.sessionId === sessionId && p.userId === userId)
    .map(([connectId, p]) => ({
      connectId,
      serverId: p.serverId,
      serverName: p.serverName,
    }));
}
