/**
 * Session retention: transcripts older than the org's retentionDays are
 * deleted (messages and eval results cascade; frozen eval cases and scope
 * violations keep their rows with the session reference nulled).
 *
 * Runs once at boot and on demand from Settings. A recurring sweep joins
 * the Hatchet scheduler when it lands (docs/DECISIONS.md).
 */
import { and, eq, sql } from "drizzle-orm";
import { orgSettingsSchema } from "@rabblehq/core";
import { db } from "./db/client.js";
import { orgs, sessions } from "./db/schema.js";

export async function applyRetention(orgId: string): Promise<number> {
  const [org] = await db
    .select({ settings: orgs.settings })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org) return 0;
  const settings = orgSettingsSchema.parse({ ...(org.settings as object) });
  const deleted = await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.orgId, orgId),
        sql`${sessions.updatedAt} < now() - make_interval(days => ${settings.retentionDays})`,
      ),
    )
    .returning({ id: sessions.id });
  return deleted.length;
}

export async function applyRetentionForAllOrgs(): Promise<void> {
  const rows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of rows) {
    await applyRetention(org.id);
  }
}
