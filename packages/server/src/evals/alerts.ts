/**
 * Pulse-back (J1 Stage 7): when live judging drags an agent's recent pass
 * rate under the floor, tell the person who owns its quality — don't wait
 * for them to open the Stats page. Event-driven off each judgment, so it
 * needs no scheduler; recurring digests land with Hatchet.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, auditEvents, users } from "../db/schema.js";
import { recordAudit } from "../audit.js";

/** Alert when ≥ MIN_GRADED sessions in 7 days pass at ≤ THRESHOLD %. */
const THRESHOLD_PCT = 60;
const MIN_GRADED_7D = 4;
const DEDUPE_HOURS = 24;

export async function checkPassRateAlert(agentId: string): Promise<void> {
  try {
    const [window] = await db
      .select({
        graded: sql<number>`count(*)::int`,
        passed: sql<number>`count(*) FILTER (WHERE er.passed)::int`,
      })
      .from(sql`eval_results er`)
      .innerJoin(sql`eval_criteria ec`, sql`ec.id = er.criterion_id`)
      .where(
        sql`ec.agent_id = ${agentId} AND er.created_at > now() - interval '7 days'`,
      );
    const graded = window?.graded ?? 0;
    if (graded < MIN_GRADED_7D) return;
    const rate = Math.round(((window?.passed ?? 0) / graded) * 100);
    if (rate > THRESHOLD_PCT) return;

    // One alert per agent per day is plenty.
    const [recent] = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "eval.alert"),
          eq(auditEvents.targetId, agentId),
          sql`${auditEvents.createdAt} > now() - interval '${sql.raw(String(DEDUPE_HOURS))} hours'`,
        ),
      )
      .limit(1);
    if (recent) return;

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) return;

    await recordAudit({
      orgId: agent.orgId,
      actorUserId: null,
      action: "eval.alert",
      targetType: "agent",
      targetId: agentId,
      summary: `Pass rate dropped to ${rate}% (${graded} graded, 7d) for "${agent.name}"`,
    });

    // DM the agent's creator (fall back to org admins) — best-effort.
    const recipients = agent.createdBy
      ? await db.select().from(users).where(eq(users.id, agent.createdBy))
      : await db
          .select()
          .from(users)
          .where(
            and(eq(users.orgId, agent.orgId), sql`${users.role} IN ('owner','admin')`),
          );
    if (recipients.length === 0) return;

    const { decryptSecret } = await import("../crypto.js");
    const { orgSlackConnection } = await import("../runtime/notify.js");
    const slack = await orgSlackConnection(agent.orgId);
    if (!slack) return;
    const baseUrl = slack.baseUrl ?? "https://slack.com";
    const token = decryptSecret(slack.encryptedToken!);
    const call = async (method: string, body: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/api/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    for (const person of recipients) {
      const lookup = await call("users.lookupByEmail", { email: person.email });
      const dmUser = (lookup.user as { id?: string } | undefined)?.id;
      if (!lookup.ok || !dmUser) continue;
      await call("chat.postMessage", {
        channel: dmUser,
        text:
          `⚠ ${agent.name}'s pass rate dropped to ${rate}% over the last 7 days ` +
          `(${graded} sessions graded). Review its evals tab: /agents/${agent.id}`,
      });
    }
  } catch {
    // Alerting must never break the judging path.
  }
}
