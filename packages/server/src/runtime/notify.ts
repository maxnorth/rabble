/**
 * Background-reply notifications: when an agent replies on a surface the
 * user isn't watching (a GitHub issue, a scheduled run), and the user has
 * "Notify me when a background task finishes" on, ping their Slack DM
 * through the org's Slack connection. Best-effort — a failed notification
 * never fails the turn.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { userPreferencesSchema } from "@rabblehq/core";
import { db } from "../db/client.js";
import { connections, type users } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";

export async function notifyBackgroundReply(input: {
  user: typeof users.$inferSelect;
  sessionId: string;
  surface: string;
  agentName: string;
  replyPreview: string;
}): Promise<void> {
  try {
    const preferences = userPreferencesSchema.parse({
      ...(input.user.preferences as Record<string, unknown>),
    });
    if (!preferences.notifyOnBackground) return;

    const [slack] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.user.orgId),
          eq(connections.vendor, "slack"),
          isNotNull(connections.encryptedToken),
        ),
      )
      .limit(1);
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

    const lookup = await call("users.lookupByEmail", { email: input.user.email });
    const slackUserId = (lookup.user as { id?: string } | undefined)?.id;
    if (!lookup.ok || !slackUserId) return;

    const preview =
      input.replyPreview.length > 140
        ? `${input.replyPreview.slice(0, 137)}…`
        : input.replyPreview;
    await call("chat.postMessage", {
      channel: slackUserId,
      text: `${input.agentName} replied on ${input.surface}: "${preview}" — open the session in Rabble: /sessions/${input.sessionId}`,
    });
  } catch {
    // Best-effort by design.
  }
}
