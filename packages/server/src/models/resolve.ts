/**
 * Model resolution for a turn. User-made agents run exactly the model
 * pinned on their Identity tab. Built-in agents (the Builder) ship without
 * a pinned model and fall back to the org's first enabled one, so they
 * work the moment an org registers any model.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, models } from "../db/schema.js";

export async function resolveAgentModel(
  agent: typeof agents.$inferSelect,
): Promise<typeof models.$inferSelect | undefined> {
  if (agent.modelId) {
    const [row] = await db
      .select()
      .from(models)
      .where(eq(models.id, agent.modelId))
      .limit(1);
    return row;
  }
  if (!agent.builtin) return undefined;
  const [fallback] = await db
    .select()
    .from(models)
    .where(and(eq(models.orgId, agent.orgId), eq(models.enabled, true)))
    .orderBy(asc(models.createdAt))
    .limit(1);
  return fallback;
}
