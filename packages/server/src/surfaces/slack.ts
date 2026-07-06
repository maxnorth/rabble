/**
 * Shared Slack surface processing, transport-agnostic. Two delivery paths
 * feed it the exact same payloads:
 *
 *   - Events API webhook (routes/inbound.ts) — Slack POSTs signed HTTP
 *     requests to a public URL.
 *   - Socket Mode (surfaces/slackSocket.ts) — the server dials out over a
 *     WebSocket and receives the same envelopes, no public URL needed.
 *
 * A message in a channel mapped to an agent surface starts (or continues) a
 * governed session for the matching platform user, runs a real agent turn,
 * and threads the reply back via chat.postMessage. Interactivity payloads
 * (Approve/Deny buttons on approval DMs) resolve pending approvals through
 * the same broker the web session card uses.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentSurfaces,
  agents,
  connections,
  messages,
  models,
  sessions,
  users,
} from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { executeTurnAndPersist } from "../runtime/executeTurn.js";

export type SlackConnection = typeof connections.$inferSelect;

export interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export interface SlackInteractionPayload {
  type?: string;
  user?: { id?: string };
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
}

/** The slice of a logger both Fastify's req.log and pino satisfy. */
export interface SurfaceLogger {
  error: (obj: unknown, msg: string) => void;
}

export async function slackApi(
  baseUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Slack redelivers events it thinks failed (slow responses trigger retries
 * after ~3s; Socket Mode re-pushes unacked envelopes). Remember recent event
 * ids so a redelivery never runs a second agent turn or posts a duplicate
 * reply. Shared across transports on purpose — Slack can retry a webhook
 * delivery over the socket and vice versa.
 */
const seenEvents = new Set<string>();
const SEEN_EVENTS_CAP = 5000;
export function alreadyDelivered(eventId: string | undefined): boolean {
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  seenEvents.add(eventId);
  if (seenEvents.size > SEEN_EVENTS_CAP) {
    const oldest = seenEvents.values().next().value;
    if (oldest) seenEvents.delete(oldest);
  }
  return false;
}

/**
 * Handle one event_callback envelope: channel message -> governed session
 * turn -> threaded reply. Returns the same shape the webhook route responds
 * with so both transports can log/inspect the outcome.
 */
export async function processSlackEvent(
  connection: SlackConnection,
  envelope: SlackEventEnvelope,
  log: SurfaceLogger,
): Promise<Record<string, unknown>> {
  if (envelope.type !== "event_callback" || !envelope.event) {
    return { ok: true, ignored: "unsupported envelope" };
  }
  if (alreadyDelivered(envelope.event_id)) {
    return { ok: true, ignored: "duplicate delivery" };
  }

  const event = envelope.event;
  // Only plain user messages — no bot echoes, edits, or joins.
  if (
    event.type !== "message" ||
    event.bot_id ||
    event.subtype ||
    !event.channel ||
    !event.user ||
    !event.text?.trim() ||
    !event.ts
  ) {
    return { ok: true, ignored: "not a user message" };
  }

  const baseUrl = connection.baseUrl ?? "https://slack.com";
  const token = connection.encryptedToken
    ? decryptSecret(connection.encryptedToken)
    : "";

  // Which agent listens on this channel?
  const channelInfo = await slackApi(baseUrl, token, "conversations.info", {
    channel: event.channel,
  });
  const channelName = (
    (channelInfo.channel as { name?: string } | undefined)?.name ?? ""
  ).replace(/^#/, "");
  const surfaceRows = await db
    .select({ surface: agentSurfaces, agent: agents })
    .from(agentSurfaces)
    .innerJoin(agents, eq(agentSurfaces.agentId, agents.id))
    .where(eq(agentSurfaces.connectionId, connection.id));
  const matched = surfaceRows.find((r) => {
    const label = r.surface.label.replace(/^#/, "");
    return label === channelName || label === event.channel;
  });
  if (!matched) return { ok: true, ignored: "no agent on this channel" };

  // Sessions belong to people: resolve the Slack user to a platform user.
  const userInfo = await slackApi(baseUrl, token, "users.info", {
    user: event.user,
  });
  const email = (userInfo.user as { profile?: { email?: string } } | undefined)
    ?.profile?.email;
  const threadTs = event.thread_ts ?? event.ts;
  const [platformUser] = email
    ? await db
        .select()
        .from(users)
        .where(and(eq(users.orgId, connection.orgId), eq(users.email, email)))
        .limit(1)
    : [];
  if (!platformUser) {
    await slackApi(baseUrl, token, "chat.postMessage", {
      channel: event.channel,
      thread_ts: threadTs,
      text: "Sorry — I can only act for Rabble users. Ask an org admin to invite you.",
    });
    return { ok: true, ignored: "no matching platform user" };
  }

  // One Slack thread = one session.
  const surfaceKey = `slack:${event.channel}:${threadTs}`;
  let [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.surfaceKey, surfaceKey))
    .limit(1);
  if (!session) {
    const title =
      event.text.length > 60 ? `${event.text.slice(0, 57)}…` : event.text;
    [session] = await db
      .insert(sessions)
      .values({
        orgId: connection.orgId,
        userId: platformUser.id,
        agentId: matched.agent.id,
        title,
        surface: `Slack #${channelName || event.channel}`,
        surfaceKey,
      })
      .returning();
  }

  const [model] = matched.agent.modelId
    ? await db
        .select()
        .from(models)
        .where(eq(models.id, matched.agent.modelId))
        .limit(1)
    : [];

  const { orgs } = await import("../db/schema.js");
  const { orgSettingsSchema } = await import("@rabblehq/core");
  const [org] = await db
    .select({ settings: orgs.settings })
    .from(orgs)
    .where(eq(orgs.id, connection.orgId))
    .limit(1);
  const orgSettings = orgSettingsSchema.parse({ ...(org?.settings as object) });
  const priorMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, session!.id));
  const sessionApproved = priorMessages.some((m) =>
    ((m.toolCalls ?? []) as Array<{ approval?: { status?: string } | null }>).some(
      (tc) =>
        tc.approval?.status === "approved" ||
        tc.approval?.status === "auto-approved",
    ),
  );

  let fullText = "";
  try {
    const result = await executeTurnAndPersist({
      sessionId: session!.id,
      agent: matched.agent,
      model,
      user: platformUser,
      content: event.text,
      requireApproval: orgSettings.requireApprovalForUserTools,
      sessionApproved,
      interactive: false,
      // Deliver approval asks as DM buttons instead of auto-denying —
      // the broker still owns the decision and the timeout.
      approvalPrompt: async (ask) => {
        const { sendSlackApprovalPrompt } = await import("../runtime/notify.js");
        await sendSlackApprovalPrompt({
          user: platformUser,
          sessionId: session!.id,
          surface: session!.surface,
          agentName: matched.agent.name,
          ask,
        });
      },
    });
    fullText = result.fullText;
  } catch (err) {
    log.error({ err }, "slack surface turn failed");
    await slackApi(baseUrl, token, "chat.postMessage", {
      channel: event.channel,
      thread_ts: threadTs,
      text: "Something went wrong running the agent — check the session in Rabble.",
    });
    return { ok: true, error: "turn failed" };
  }

  await slackApi(baseUrl, token, "chat.postMessage", {
    channel: event.channel,
    thread_ts: threadTs,
    text: fullText || "(no reply)",
  });

  return { ok: true, sessionId: session!.id };
}

/**
 * Handle one interactivity payload (block_actions): Approve/Deny button
 * clicks from the approval DM. The broker only accepts the decision from
 * the platform user the approval belongs to.
 */
export async function processSlackInteraction(
  connection: SlackConnection,
  payload: SlackInteractionPayload,
): Promise<Record<string, unknown>> {
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || !action?.value || !payload.user?.id) {
    return { ok: true, ignored: "unsupported interaction" };
  }

  const baseUrl = connection.baseUrl ?? "https://slack.com";
  const token = connection.encryptedToken
    ? decryptSecret(connection.encryptedToken)
    : "";
  const info = await slackApi(baseUrl, token, "users.info", {
    user: payload.user.id,
  });
  const email = (info.user as { profile?: { email?: string } } | undefined)
    ?.profile?.email;
  const [decider] = email
    ? await db
        .select()
        .from(users)
        .where(and(eq(users.orgId, connection.orgId), eq(users.email, email)))
        .limit(1)
    : [];
  if (!decider) return { ok: true, ignored: "unknown user" };

  let ref: { approvalId?: string; sessionId?: string };
  try {
    ref = JSON.parse(action.value) as typeof ref;
  } catch {
    return { ok: false, error: "Invalid action value" };
  }
  const { decideApproval } = await import("../runtime/approvals.js");
  const ok =
    ref.approvalId && ref.sessionId
      ? decideApproval(
          ref.approvalId,
          ref.sessionId,
          decider.id,
          action.action_id === "rabble_approve" ? "approve" : "deny",
        )
      : false;
  const outcomeText = ok
    ? action.action_id === "rabble_approve"
      ? "✅ Approved — the agent is continuing."
      : "🚫 Denied — the agent was told no."
    : "This approval already resolved or isn't yours to decide.";

  // Swap the buttons out of the DM so the ask can't be double-clicked.
  if (payload.response_url) {
    void fetch(payload.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace_original: true, text: outcomeText }),
    }).catch(() => {});
  }
  return { ok: true, resolved: ok, text: outcomeText };
}
