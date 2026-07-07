/**
 * Automation scheduling. dueAutomations() is a pure, tested selector — which
 * automations should fire at a given minute; runDueAutomations() is the
 * executor the Hatchet tick calls, reusing the same governed executor as the
 * "Run now" route (an automation runs as its creator, since a cron tick has
 * no request user).
 */
import { and, eq } from "drizzle-orm";
import { cronMatches, orgSettingsSchema } from "@rabblehq/core";
import { db } from "../db/client.js";
import { agents, automations, models, orgs, sessions, users } from "../db/schema.js";
import { executeTurnAndPersist } from "../runtime/executeTurn.js";
import { recordAudit } from "../audit.js";

interface Schedulable {
  schedule: string;
  enabled: boolean;
  lastRunAt: Date | null;
  createdBy: string | null;
}

function sameMinuteUtc(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate() &&
    a.getUTCHours() === b.getUTCHours() &&
    a.getUTCMinutes() === b.getUTCMinutes()
  );
}

/**
 * Automations that should fire at `now`: enabled, with an owner to run as,
 * matching their cron this minute, and not already fired this same minute
 * (idempotent if the tick runs twice).
 */
export function dueAutomations<T extends Schedulable>(list: T[], now: Date): T[] {
  return list.filter((a) => {
    if (!a.enabled || !a.createdBy) return false;
    if (!cronMatches(a.schedule, now)) return false;
    if (a.lastRunAt && sameMinuteUtc(a.lastRunAt, now)) return false;
    return true;
  });
}

interface SchedLogger {
  warn: (obj: unknown, msg: string) => void;
}

/** Run every automation due at `now`. Returns how many actually ran. */
export async function runDueAutomations(
  log: SchedLogger,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.select().from(automations);
  const due = dueAutomations(rows, now).filter((a) => a.prompt.trim());
  let ran = 0;

  for (const automation of due) {
    try {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, automation.agentId))
        .limit(1);
      if (!agent) continue;
      const [model] = agent.modelId
        ? await db.select().from(models).where(eq(models.id, agent.modelId)).limit(1)
        : [];
      if (!model) continue;
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, automation.createdBy!), eq(users.orgId, agent.orgId)))
        .limit(1);
      if (!user) continue;

      const [org] = await db
        .select({ settings: orgs.settings })
        .from(orgs)
        .where(eq(orgs.id, agent.orgId))
        .limit(1);
      const orgSettings = orgSettingsSchema.parse({ ...(org?.settings as object) });

      const [session] = await db
        .insert(sessions)
        .values({
          orgId: agent.orgId,
          userId: user.id,
          agentId: agent.id,
          title: automation.name,
          surface: `Automation · ${automation.name}`,
        })
        .returning();

      await executeTurnAndPersist({
        sessionId: session!.id,
        agent,
        model,
        user,
        content: automation.prompt,
        requireApproval: orgSettings.requireApprovalForUserTools,
        sessionApproved: false,
        // No one is watching a scheduled run — approvals can't prompt.
        interactive: false,
      });

      await db
        .update(automations)
        .set({ lastRunAt: now, lastSessionId: session!.id })
        .where(eq(automations.id, automation.id));
      await recordAudit({
        orgId: agent.orgId,
        actorUserId: user.id,
        action: "automation.run",
        targetType: "agent",
        targetId: agent.id,
        summary: `Ran automation "${automation.name}" on schedule`,
      });
      ran += 1;
    } catch (err) {
      log.warn({ err, automationId: automation.id }, "scheduled automation run failed");
    }
  }
  return ran;
}
