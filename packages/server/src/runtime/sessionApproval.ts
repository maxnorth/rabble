/**
 * "Approve once, then trust the rest of the session" — scoped to the user who
 * actually consented. Sessions can be multi-participant (a shared Slack
 * channel, a continued thread), so a session-wide latch would let one person's
 * approval silently auto-approve another person's user-auth tools acting as
 * *them*. Attribution: an approval recorded on an agent message belongs to the
 * user who drove that turn — the author of the immediately preceding user
 * message. This latch counts only the current user's own prior approvals.
 */

export interface ApprovalHistoryMessage {
  role: "user" | "agent";
  authorUserId: string | null;
  toolCalls: unknown;
  createdAt: Date;
}

export function sessionApprovedForUser(
  history: ApprovalHistoryMessage[],
  userId: string,
): boolean {
  const ordered = [...history].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  let driver: string | null = null;
  for (const m of ordered) {
    if (m.role === "user") {
      driver = m.authorUserId ?? null;
      continue;
    }
    // An agent turn's approvals are attributed to whoever drove it.
    if (driver !== userId) continue;
    const approved = (
      (m.toolCalls ?? []) as Array<{ approval?: { status?: string } | null }>
    ).some(
      (tc) =>
        tc.approval?.status === "approved" ||
        tc.approval?.status === "auto-approved",
    );
    if (approved) return true;
  }
  return false;
}
