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
import { slackClient } from "../surfaces/slackClient.js";

/**
 * Deliver an approval ask as Slack DM buttons through the org's Slack
 * connection. Best-effort: returns false when there's no Slack path (the
 * ask still pends for the web session card).
 */
export async function sendSlackApprovalPrompt(input: {
  user: typeof users.$inferSelect;
  sessionId: string;
  surface: string;
  agentName: string;
  ask: { approvalId: string; toolName: string; serverName: string | null };
}): Promise<boolean> {
  try {
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
    if (!slack) return false;
    const client = slackClient(slack.baseUrl, decryptSecret(slack.encryptedToken!));
    const lookup = await client.users
      .lookupByEmail({ email: input.user.email })
      .catch(() => undefined);
    const dmUser = lookup?.user?.id;
    if (!dmUser) return false;
    const value = JSON.stringify({
      approvalId: input.ask.approvalId,
      sessionId: input.sessionId,
    });
    await client.chat.postMessage({
      channel: dmUser,
      text:
        `${input.agentName} wants to run ${input.ask.toolName}` +
        `${input.ask.serverName ? ` via ${input.ask.serverName}` : ""} acting as you ` +
        `(from ${input.surface}).`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `*Approval needed · acting as you*\n` +
              `${input.agentName} wants to run \`${input.ask.toolName}\`` +
              `${input.ask.serverName ? ` via ${input.ask.serverName}` : ""} on ${input.surface}.`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              style: "primary",
              action_id: "rabble_approve",
              text: { type: "plain_text", text: "Approve as me" },
              value,
            },
            {
              type: "button",
              style: "danger",
              action_id: "rabble_deny",
              text: { type: "plain_text", text: "Deny" },
              value,
            },
          ],
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

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
    const client = slackClient(slack.baseUrl, decryptSecret(slack.encryptedToken!));
    const lookup = await client.users
      .lookupByEmail({ email: input.user.email })
      .catch(() => undefined);
    const slackUserId = lookup?.user?.id;
    if (!slackUserId) return;

    const preview =
      input.replyPreview.length > 140
        ? `${input.replyPreview.slice(0, 137)}…`
        : input.replyPreview;
    await client.chat.postMessage({
      channel: slackUserId,
      text: `${input.agentName} replied on ${input.surface}: "${preview}". Open the session in Rabble: /sessions/${input.sessionId}`,
    });
  } catch {
    // Best-effort by design.
  }
}
