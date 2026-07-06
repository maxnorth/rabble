/**
 * Control-plane audit log. Every mutation of platform state (agents, grants,
 * teams, domains, models, keys, connections, settings) records an event.
 * Deliberately NOT a session log — transcripts live on sessions.
 */
import { db } from "./db/client.js";
import { auditEvents } from "./db/schema.js";

export async function recordAudit(input: {
  orgId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      summary: input.summary,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    // Audit must never take down the mutation it describes.
    console.error("audit write failed", err);
  }
}
