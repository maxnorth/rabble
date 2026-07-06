/**
 * Best-effort Slack DM to every org admin when an access request lands —
 * §117's "admin is notified with context auto-attached". The request row
 * is the source of truth; notification failure never fails the request.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections, users } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";

export async function notifyAdminsOfAccessRequest(input: {
  orgId: string;
  requesterName: string;
  accessRight: string;
  targetLabel: string;
  reason: string;
  via?: "builder" | "web";
}): Promise<void> {
  try {
    const [slack] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
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
    const admins = await db
      .select()
      .from(users)
      .where(and(eq(users.orgId, input.orgId), sql`${users.role} IN ('owner','admin')`));
    for (const admin of admins) {
      const lookup = await call("users.lookupByEmail", { email: admin.email });
      const dmUser = (lookup.user as { id?: string } | undefined)?.id;
      if (!lookup.ok || !dmUser) continue;
      await call("chat.postMessage", {
        channel: dmUser,
        text:
          `Access request: ${input.requesterName} requests ${input.accessRight} ` +
          `on ${input.targetLabel}${input.via === "builder" ? " (via Builder)" : ""}. ` +
          `Reason: ${input.reason || "—"} — review under Admin › Access requests.`,
      });
    }
  } catch {
    // Notification is best-effort; the request row is the source of truth.
  }
}
