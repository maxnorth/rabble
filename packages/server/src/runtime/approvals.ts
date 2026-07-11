/**
 * In-memory broker for personal-credential CONNECT asks (a turn pauses
 * until the user connects an account, or times out). Tool APPROVALS are no
 * longer brokered here — they are durable and asynchronous
 * (runtime/approvalDecide.ts; DECISIONS.md "Approvals are asynchronous").
 */
import { randomUUID } from "node:crypto";

// Overridable so tests (and impatient orgs) can tighten the window.
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000);

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
  requiresOAuth: boolean;
  resolve: (decision: ConnectDecision) => void;
}

const pendingConnects = new Map<string, PendingConnect>();

export function requestConnect(input: {
  sessionId: string;
  userId: string;
  serverId: string;
  serverName: string;
  requiresOAuth: boolean;
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
): Array<{ connectId: string; serverId: string; serverName: string; requiresOAuth: boolean }> {
  return [...pendingConnects.entries()]
    .filter(([, p]) => p.sessionId === sessionId && p.userId === userId)
    .map(([connectId, p]) => ({
      connectId,
      serverId: p.serverId,
      serverName: p.serverName,
      requiresOAuth: p.requiresOAuth,
    }));
}
