/**
 * The decision side of async approvals (DECISIONS.md "Approvals are
 * asynchronous"). Deciding an ask — from the web card or Slack DM buttons —
 * does three things, in order:
 *
 *   1. Executes the RECORDED call verbatim on approval (same tool, same
 *      arguments, same acting identity). Approval authorizes one concrete
 *      action, never a re-plan.
 *   2. Updates the persisted tool-call chip in the transcript from
 *      "pending" to the outcome, so the session posture ("first approval
 *      covers the session") and the UI stay coherent.
 *   3. Notifies the agent with a follow-up turn in the session, so it can
 *      continue the work with the result in hand. On Slack-origin sessions
 *      the reply is delivered back into the thread.
 */
import { and, eq, lt } from "drizzle-orm";
import type { ToolCall } from "@rabblehq/core";
import { db } from "../db/client.js";
import {
  agentSurfaces,
  agents,
  approvals,
  connections,
  mcpServers,
  messages,
  orgs,
  sessions,
  users,
} from "../db/schema.js";
import { recordAudit } from "../audit.js";

export type DurableDecision = "approve" | "deny";

const finalStatus = (d: DurableDecision) =>
  d === "approve" ? "approved" : "denied";

/** Execute the recorded call exactly as asked. Returns the tool output. */
async function executeRecordedCall(
  row: typeof approvals.$inferSelect,
): Promise<string> {
  const [actingUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!actingUser) throw new Error("Acting user no longer exists");

  if (row.kind === "platform") {
    const { buildPlatformDefs } = await import("./platformTools.js");
    const def = buildPlatformDefs(actingUser).find((d) => d.name === row.toolName);
    if (!def) throw new Error(`Unknown platform tool "${row.toolName}"`);
    return def.run((row.input ?? {}) as Record<string, unknown>);
  }

  if (!row.serverId) throw new Error("Approval has no MCP server recorded");
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, row.serverId))
    .limit(1);
  if (!server) throw new Error("MCP server no longer exists");

  // Built-in Slack tools dispatch in-process (they're service-auth so an
  // approval here would be unusual, but the recorded call still runs).
  const { isBuiltinSlack, runSlackWorkspaceTool } = await import("../mcp/slackTools.js");
  if (isBuiltinSlack(server.url)) {
    return runSlackWorkspaceTool(
      server,
      row.toolName,
      (row.input ?? {}) as Record<string, unknown>,
    );
  }

  const { usableAccessToken } = await import("../mcp/oauthFlow.js");
  const credential = await usableAccessToken(server, row.userId, Date.now());
  if (!credential) {
    throw new Error(
      `No ${server.name} account connected for the approver — connect one under Profile and approve again.`,
    );
  }
  const { mcpCallTool } = await import("../mcp/client.js");
  return mcpCallTool(
    server.url,
    row.toolName,
    (row.input ?? {}) as Record<string, unknown>,
    credential,
  );
}

/** Find the persisted message carrying this ask's tool call, if any. */
async function findMessageWithAsk(
  row: typeof approvals.$inferSelect,
): Promise<{ id: string; calls: ToolCall[]; idx: number } | null> {
  const sessionMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, row.sessionId));
  for (const m of sessionMessages) {
    const calls = (m.toolCalls ?? []) as ToolCall[];
    const idx = calls.findIndex((c) => c.approval?.approvalId === row.id);
    if (idx !== -1) return { id: m.id, calls, idx };
  }
  return null;
}

/**
 * A decision can land while the turn that raised the ask is still
 * streaming (the card shows up mid-turn over SSE, and the turn no longer
 * blocks). Wait — bounded — for that turn to persist its message, so the
 * chip update finds its target and the follow-up turn's messages sort
 * AFTER the reply that asked. If the turn crashed before persisting, give
 * up and proceed; the follow-up still informs the agent.
 */
async function waitForPersistedAsk(
  row: typeof approvals.$inferSelect,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await findMessageWithAsk(row)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Flip the persisted transcript chip for this ask from pending → outcome. */
async function updatePersistedToolCall(
  row: typeof approvals.$inferSelect,
  status: string,
  deciderName: string | null,
  output: string | null,
): Promise<void> {
  const found = await findMessageWithAsk(row);
  if (!found) return;
  const { id, calls, idx } = found;
  calls[idx] = {
    ...calls[idx]!,
    output: output ?? calls[idx]!.output,
    approval: {
      status: status as NonNullable<ToolCall["approval"]>["status"],
      decidedByName: deciderName,
      approvalId: row.id,
    },
  };
  await db.update(messages).set({ toolCalls: calls }).where(eq(messages.id, id));
}

/** Post a reply into the Slack thread a session lives in (best-effort). */
async function deliverToSlackThread(
  session: typeof sessions.$inferSelect,
  agentId: string,
  text: string,
): Promise<void> {
  if (!session.surfaceKey?.startsWith("slack:")) return;
  const [, channel, threadTs] = session.surfaceKey.split(":");
  if (!channel || !threadTs) return;
  // Prefer the connection that is this agent's Slack identity; fall back to
  // the org's primary/any connected workspace.
  const [linked] = await db
    .select({ connection: connections })
    .from(agentSurfaces)
    .innerJoin(connections, eq(agentSurfaces.connectionId, connections.id))
    .where(eq(agentSurfaces.agentId, agentId))
    .limit(1);
  const { orgSlackConnection } = await import("./notify.js");
  const conn = linked?.connection ?? (await orgSlackConnection(session.orgId));
  if (!conn?.encryptedToken) return;
  const { decryptSecret } = await import("../crypto.js");
  const { slackClient } = await import("../surfaces/slackClient.js");
  const slack = slackClient(conn.baseUrl, decryptSecret(conn.encryptedToken));
  await slack.chat
    .postMessage({ channel, thread_ts: threadTs, text })
    .catch(() => {});
}

/**
 * Decide a durable approval. Only the acting identity (the user the call
 * would run as) may decide. Returns false when the ask is unknown, already
 * decided, or not the caller's to decide.
 */
export async function decideDurableApproval(opts: {
  approvalId: string;
  sessionId?: string;
  deciderId: string;
  decision: DurableDecision;
}): Promise<{ ok: boolean; status?: string }> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, opts.approvalId), eq(approvals.status, "pending")))
    .limit(1);
  if (!row) return { ok: false };
  if (row.userId !== opts.deciderId) return { ok: false };
  if (opts.sessionId && row.sessionId !== opts.sessionId) return { ok: false };

  const [decider] = await db
    .select()
    .from(users)
    .where(eq(users.id, opts.deciderId))
    .limit(1);
  const deciderName = decider?.name ?? null;
  const status = finalStatus(opts.decision);

  // Claim the row first so a double-click can't execute twice.
  const claimed = await db
    .update(approvals)
    .set({ status, decidedBy: opts.deciderId, decidedAt: new Date() })
    .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (claimed.length === 0) return { ok: false };

  // 1. Execute (approve only).
  let output: string | null = null;
  let executionError: string | null = null;
  if (opts.decision !== "deny") {
    try {
      output = await executeRecordedCall(row);
      await db
        .update(approvals)
        .set({ executedAt: new Date(), output })
        .where(eq(approvals.id, row.id));
    } catch (err) {
      executionError = err instanceof Error ? err.message : "Execution failed";
      await db
        .update(approvals)
        .set({ output: `Error: ${executionError}` })
        .where(eq(approvals.id, row.id));
    }
  }

  await recordAudit({
    orgId: row.orgId,
    actorUserId: opts.deciderId,
    action: `approval.${opts.decision === "deny" ? "deny" : "approve"}`,
    targetType: "session",
    targetId: row.sessionId,
    summary:
      opts.decision === "deny"
        ? `Declined ${row.toolName}${row.serverName ? ` via ${row.serverName}` : ""}`
        : `Approved ${row.toolName}${row.serverName ? ` via ${row.serverName}` : ""} — executed ${
            executionError ? "with an error" : "successfully"
          }`,
  });

  // 2. Transcript chip: pending → outcome. First wait out the turn that
  // raised the ask — a decision can arrive while it is still streaming.
  await waitForPersistedAsk(row);
  await updatePersistedToolCall(
    row,
    status,
    deciderName,
    executionError ? `Error: ${executionError}` : output,
  );

  // 3. Follow-up turn: tell the agent what happened so it can continue.
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, row.sessionId))
    .limit(1);
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, row.agentId))
    .limit(1);
  const [actingUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!session || !agent || !actingUser) return { ok: true, status };

  const label = `${row.toolName}${row.serverName ? ` via ${row.serverName}` : ""}`;
  const content =
    opts.decision === "deny"
      ? `Approval update: ${deciderName ?? "the user"} DECLINED ${label}. Do not retry it; adjust or explain what you couldn't do.`
      : executionError
        ? `Approval update: ${deciderName ?? "the user"} approved ${label}, but executing it failed: ${executionError}`
        : `Approval update: ${deciderName ?? "the user"} approved ${label} and the platform executed it. Result:\n${(output ?? "").slice(0, 4000)}`;

  try {
    const { resolveAgentModel } = await import("../models/resolve.js");
    const { executeTurnAndPersist } = await import("./executeTurn.js");
    const { orgSettingsSchema } = await import("@rabblehq/core");
    const [org] = await db
      .select({ settings: orgs.settings })
      .from(orgs)
      .where(eq(orgs.id, row.orgId))
      .limit(1);
    const orgSettings = orgSettingsSchema.parse({ ...(org?.settings as object) });
    const model = await resolveAgentModel(agent);
    const result = await executeTurnAndPersist({
      sessionId: row.sessionId,
      agent,
      model,
      user: actingUser,
      content,
      requireApproval: orgSettings.requireApprovalForUserTools,
      // An explicit approval IS the session consent from here on.
      sessionApproved: opts.decision !== "deny",
      interactive: false,
    });
    await deliverToSlackThread(session, agent.id, result.fullText || "(no reply)");
  } catch {
    // The decision and execution are already durable; a failed follow-up
    // turn must not roll them back.
  }
  return { ok: true, status };
}

/** Pending asks for a session the given user can decide (UI hydration). */
export async function pendingDurableApprovals(
  sessionId: string,
  userId: string,
): Promise<
  Array<{ approvalId: string; toolName: string; serverName: string | null; input: unknown }>
> {
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.sessionId, sessionId),
        eq(approvals.userId, userId),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(approvals.createdAt);
  return rows.map((r) => ({
    approvalId: r.id,
    toolName: r.toolName,
    serverName: r.serverName,
    input: r.input,
  }));
}

/** Boot sweep: expire asks older than the TTL (recurring sweeps land with
 * Hatchet). Expired chips flip in the transcript; no follow-up turn — the
 * agent learns on its next invocation. */
export async function expireStaleApprovals(
  ttlMs = Number(process.env.APPROVAL_TTL_MS ?? 86_400_000),
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs);
  const expired = await db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), lt(approvals.createdAt, cutoff)))
    .returning();
  for (const row of expired) {
    await updatePersistedToolCall(row, "expired", null, null);
  }
  return expired.length;
}

