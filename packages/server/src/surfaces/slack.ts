/**
 * Shared Slack surface processing, transport-agnostic. Two delivery paths
 * feed it the exact same payloads:
 *
 *   - Events API webhook (routes/inbound.ts) — Slack POSTs signed HTTP
 *     requests to a public URL.
 *   - Socket Mode (surfaces/slackSocket.ts) — the server dials out over a
 *     WebSocket and receives the same envelopes, no public URL needed.
 *
 * A connection is an agent's Slack identity: exactly one agent links to it
 * (via agent_surfaces), and every DM/mention/channel message answers as that
 * agent — an unlinked connection answers as no one. Messages start (or
 * continue) a governed session for the matching platform user, run a real
 * agent turn, and thread the reply back via chat.postMessage. Interactivity
 * payloads (Approve/Deny buttons on approval DMs) resolve pending approvals
 * through the same broker the web session card uses.
 */
import { appendFile } from "node:fs/promises";
import type { WebClient } from "@slack/web-api";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentSurfaces,
  agents,
  connections,
  messages,
  sessions,
  users,
} from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { slackClient } from "./slackClient.js";
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
    channel_type?: string;
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
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
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
 * Whether a Slack message should get a reply, given the surface's response
 * mode. DMs and @-mentions always engage. In a channel it depends on the mode:
 *   all     – every message answers
 *   thread  – a tag starts a thread; follow-ups answer once its session exists
 *   mention – only @-mentions answer, even inside an active thread
 * Channels without their own surface row inherit the workspace-level surface's
 * mode (empty label); with neither, only @-mentions answer.
 */
export function shouldEngageSlack(opts: {
  isDm: boolean;
  isMention: boolean;
  mode: string;
  hasThreadSession: boolean;
}): boolean {
  const { isDm, isMention, mode, hasThreadSession } = opts;
  return isDm || isMention || mode === "all" || (mode === "thread" && hasThreadSession);
}

/** The slice of a surface row the routing decisions need. */
export interface SurfaceRow {
  label: string;
  responseMode: string;
  dmEnabled: boolean;
}

/**
 * Whether the message addresses the bot. A tag arrives as app_mention OR as
 * a plain message whose text contains `<@BOT>` (when both event types are
 * subscribed) — both must read as a mention so dedup can't drop the one
 * that would have engaged.
 */
export function detectMention(
  eventType: string,
  text: string,
  botUserId: string | undefined,
): boolean {
  if (eventType === "app_mention") return true;
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`);
}

/**
 * A channel's response mode: its own surface row wins, else the
 * workspace-level surface (empty label) applies, else mention-only.
 */
export function resolveChannelMode<T extends SurfaceRow>(
  surfaces: T[],
  channelName: string,
  channelId: string,
): { matched: T | undefined; mode: string } {
  const matched = surfaces.find((s) => {
    const label = s.label.replace(/^#/, "");
    return label !== "" && (label === channelName || label === channelId);
  });
  const workspace = surfaces.find((s) => s.label === "");
  return {
    matched,
    mode: matched?.responseMode ?? workspace?.responseMode ?? "mention",
  };
}

/** DMs are a workspace-level surface setting; no workspace row means on. */
export function dmAllowed(surfaces: SurfaceRow[]): boolean {
  const workspace = surfaces.find((s) => s.label === "");
  return workspace?.dmEnabled ?? true;
}

// [diag] TEMPORARY Slack diagnostics. Every step logs via the app logger AND
// mirrors to a file so the whole event lifecycle can be tailed while we
// root-cause delivery/threading. Remove this block + all slackDiag() calls
// (grep "slackDiag" / "slack.diag") once Slack is proven stable.
const SLACK_DIAG_FILE = "/tmp/rabble-slack-diag.log";
export function slackDiag(
  log: SurfaceLogger,
  msg: string,
  obj: Record<string, unknown> = {},
): void {
  log.info(obj, `slack.diag: ${msg}`);
  void appendFile(
    SLACK_DIAG_FILE,
    `${JSON.stringify({ at: new Date().toISOString(), msg, ...obj })}\n`,
  ).catch(() => {});
}

/**
 * The bot's own Slack user id, per connection. When both app_mention and
 * message.channels are subscribed, a tag arrives twice — as app_mention and
 * as a plain message whose text contains `<@BOT>`. We need the bot id to
 * recognize the message copy as a mention so both engage identically (the
 * dedup then keeps exactly one turn). Cached — auth.test only runs once.
 */
const botUserIdByConnection = new Map<string, string>();
async function resolveBotUserId(
  connectionId: string,
  slack: WebClient,
): Promise<string | undefined> {
  const cached = botUserIdByConnection.get(connectionId);
  if (cached) return cached;
  const id = await slack.auth
    .test()
    .then((r) => (typeof r.user_id === "string" ? r.user_id : undefined))
    .catch(() => undefined);
  if (id) botUserIdByConnection.set(connectionId, id);
  return id;
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
    slackDiag(log, "envelope received (unsupported)", {
      envelopeType: envelope.type,
      eventId: envelope.event_id ?? null,
    });
    return { ok: true, ignored: "unsupported envelope" };
  }

  const event = envelope.event;
  // Log EVERY inbound event before any filtering — this is how we see whether
  // Slack even delivers a given message (e.g. an untagged thread reply).
  slackDiag(log, "event received", {
    eventId: envelope.event_id ?? null,
    eventType: event.type,
    subtype: event.subtype ?? null,
    channel: event.channel ?? null,
    channelType: event.channel_type ?? null,
    user: event.user ?? null,
    threadTs: event.thread_ts ?? null,
    ts: event.ts ?? null,
    botId: event.bot_id ?? null,
    hasText: !!event.text?.trim(),
  });

  if (alreadyDelivered(envelope.event_id)) {
    slackDiag(log, "ignored: duplicate event_id", { eventId: envelope.event_id });
    return { ok: true, ignored: "duplicate delivery" };
  }

  // Only user messages and @-mentions; skip bot echoes, edits, and joins.
  // app_mention has no channel_type, so it never reads as a DM below.
  if (
    (event.type !== "message" && event.type !== "app_mention") ||
    event.bot_id ||
    event.subtype ||
    !event.channel ||
    !event.user ||
    !event.text?.trim() ||
    !event.ts
  ) {
    slackDiag(log, "ignored: not a user message", {
      eventType: event.type,
      subtype: event.subtype ?? null,
      botId: event.bot_id ?? null,
      hasChannel: !!event.channel,
      hasUser: !!event.user,
      hasText: !!event.text?.trim(),
    });
    return { ok: true, ignored: "not a user message" };
  }

  // A mention in a channel the app also reads arrives twice (app_mention +
  // message) under distinct event_ids; dedupe on channel+ts so one turn runs.
  if (alreadyDelivered(`msg:${event.channel}:${event.ts}`)) {
    slackDiag(log, "ignored: duplicate message identity", {
      channel: event.channel,
      ts: event.ts,
    });
    return { ok: true, ignored: "duplicate delivery" };
  }

  // Drop a leading "<@bot>" so routing/title/turn see the request itself;
  // fall back to raw text if the message was nothing but the mention.
  const text =
    event.text.replace(/^\s*(?:<@[^>]+>\s*)+/, "").trim() || event.text;

  const token = connection.encryptedToken
    ? decryptSecret(connection.encryptedToken)
    : "";
  const slack = slackClient(connection.baseUrl, token);
  const threadTs = event.thread_ts ?? event.ts;

  // Best-effort reply: a failed post must not throw out of the handler.
  const post = async (postText: string) => {
    try {
      await slack.chat.postMessage({
        channel: event.channel!,
        thread_ts: threadTs,
        text: postText,
      });
    } catch (err) {
      log.error({ err }, "slack chat.postMessage failed");
    }
  };

  const diag = (msg: string, extra: Record<string, unknown> = {}) =>
    slackDiag(log, msg, { eventId: envelope.event_id, channel: event.channel, ...extra });
  diag("passed filters", { eventType: event.type, slackUser: event.user, ts: event.ts });

  const isDm = event.channel_type === "im" || event.channel.startsWith("D");
  // A tag can arrive as app_mention OR as a message.channels event whose text
  // contains `<@BOT>` — treat both as a mention so the dedup can't drop the one
  // that would have engaged.
  const botUserId = await resolveBotUserId(connection.id, slack);
  const isMention = detectMention(event.type, event.text, botUserId);

  // A connection is an agent's Slack identity. Until an agent is linked (an
  // agent_surfaces row exists) there's no one to answer as — anyone who
  // addresses the app directly gets pointed at the fix; ambient channel
  // messages stay ignored.
  const surfaceRows = await db
    .select({ surface: agentSurfaces, agent: agents })
    .from(agentSurfaces)
    .innerJoin(agents, eq(agentSurfaces.agentId, agents.id))
    .where(eq(agentSurfaces.connectionId, connection.id));
  if (surfaceRows.length === 0) {
    diag("not linked to an agent", { isDm, isMention });
    if (isDm || isMention) {
      await post(
        "This app isn't linked to an agent yet. An admin can attach it in Rabble, under the agent's Surfaces tab.",
      );
    }
    return { ok: true, ignored: "connection not linked to an agent" };
  }
  const linkedAgent = surfaceRows[0]!.agent;
  const rows = surfaceRows.map((r) => r.surface);

  // DMs are a surface setting (workspace-level row). Off means a 1:1 message
  // gets a short pointer, never a session.
  if (isDm && !dmAllowed(rows)) {
    diag("refused: DMs disabled on this surface");
    await post(
      `${linkedAgent.name} doesn't take direct messages. Reach it in a channel instead.`,
    );
    return { ok: true, ignored: "DMs disabled on this surface" };
  }

  // Sessions belong to people: resolve the Slack user to a platform user via
  // their profile email. The SDK rejects on ok:false (e.g. user_not_found);
  // treat any failure as "no email" so the refusal path is taken.
  const email = await slack.users
    .info({ user: event.user })
    .then((r) => r.user?.profile?.email)
    .catch((err) => {
      log.warn({ err }, "slack users.info failed");
      return undefined;
    });
  const [platformUser] = email
    ? await db
        .select()
        .from(users)
        .where(and(eq(users.orgId, connection.orgId), eq(users.email, email)))
        .limit(1)
    : [];
  // [diag] email is not a secret, but this line is removable with the rest.
  diag("identity resolved", { email: email ?? null, platformUser: platformUser?.id ?? null });
  const notARabbleUser = async () => {
    diag("refused: no matching Rabble user", { email: email ?? null });
    await post("Sorry, I can only act for Rabble users. Ask an org admin to invite you.");
    return { ok: true, ignored: "no matching platform user" };
  };

  // One Slack thread (or DM) = one session.
  const surfaceKey = `slack:${event.channel}:${threadTs}`;
  const [existingSession] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.surfaceKey, surfaceKey))
    .limit(1);

  // Resolve the channel's response mode (channels only).
  let matched: (typeof rows)[number] | undefined;
  let channelName = "";
  let mode = "mention";
  if (!isDm) {
    channelName = (
      await slack.conversations
        .info({ channel: event.channel })
        .then((r) => r.channel?.name ?? "")
        .catch(() => "")
    ).replace(/^#/, "");
    ({ matched, mode } = resolveChannelMode(rows, channelName, event.channel));
  }
  diag("surface resolved", {
    isDm,
    isMention,
    channelName,
    matchedSurface: matched?.label ?? null,
    mode,
    hasThreadSession: !!existingSession,
  });

  // Whether to answer this message at all. DMs always continue their 1:1
  // thread; in a channel it depends on the surface's response mode:
  //   all     – every message answers
  //   thread  – a tag starts a thread; follow-ups in it auto-answer
  //   mention – only @-mentions answer, even inside an active thread
  const engage = shouldEngageSlack({
    isDm,
    isMention,
    mode,
    hasThreadSession: !!existingSession,
  });
  if (!engage) {
    diag("ignored: not engaged for this mode", {
      mode,
      isMention,
      hasThreadSession: !!existingSession,
      matched: !!matched,
    });
    return {
      ok: true,
      ignored: matched ? "surface mode requires a mention" : "no agent on this channel",
    };
  }
  if (!platformUser) return notARabbleUser();

  // Who answers? Always the connection's linked agent — the Slack identity IS
  // that agent. An active thread continues with its owning agent for safety
  // (sessions predating a re-link keep their original voice).
  let agent: typeof agents.$inferSelect;
  if (existingSession) {
    const [owner] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, existingSession.agentId))
      .limit(1);
    if (!owner) return { ok: true, ignored: "session agent missing" };
    agent = owner;
  } else {
    agent = linkedAgent;
  }
  const surfaceName =
    existingSession?.surface ??
    (isDm ? "Slack DM" : `Slack #${channelName || event.channel}`);
  diag("routed", {
    isDm,
    isMention,
    mode,
    continuing: !!existingSession,
    agentId: agent.id,
    agentName: agent.name,
  });

  // Create the session on first contact.
  let session = existingSession;
  if (!session) {
    const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    [session] = await db
      .insert(sessions)
      .values({
        orgId: connection.orgId,
        userId: platformUser.id,
        agentId: agent.id,
        title,
        surface: surfaceName,
        surfaceKey,
      })
      .returning();
  }

  // resolveAgentModel covers the Builder (no pinned model → org default).
  const { resolveAgentModel } = await import("../models/resolve.js");
  const model = await resolveAgentModel(agent);

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

  // Slack shows TWO agent working-indicators, both driven by setStatus:
  //   status           – the static bar under the message
  //   loading_messages – the rotating "typing" animation; if omitted, Slack
  //                      cycles its own built-ins ("Summarizing findings…" etc.)
  // Pin BOTH to the same text so neither rotates through the built-ins. Clears
  // when we post the reply; assistant:write/chat:write (both granted) cover it.
  const thinking = "Thinking…";
  try {
    const r = await slack.assistant.threads.setStatus({
      channel_id: event.channel,
      thread_ts: threadTs,
      status: thinking,
      loading_messages: [thinking],
    });
    slackDiag(log, "setStatus ok", { status: thinking, threadTs, ok: r.ok });
  } catch (err) {
    slackDiag(log, "setStatus FAILED", {
      threadTs,
      error: (err as { data?: { error?: string } })?.data?.error ?? String(err),
    });
    log.warn({ err }, "slack setStatus failed");
  }

  let fullText = "";
  try {
    const result = await executeTurnAndPersist({
      sessionId: session!.id,
      agent,
      model,
      user: platformUser,
      content: text,
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
          agentName: agent.name,
          ask,
        });
      },
    });
    fullText = result.fullText;
  } catch (err) {
    log.error({ err }, "slack surface turn failed");
    await post("Something went wrong running the agent. Check the session in Rabble.");
    return { ok: true, error: "turn failed" };
  }

  await post(fullText || "(no reply)");
  diag("reply posted", { sessionId: session!.id, replyChars: fullText.length });
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

  const token = connection.encryptedToken
    ? decryptSecret(connection.encryptedToken)
    : "";
  const slack = slackClient(connection.baseUrl, token);
  const email = await slack.users
    .info({ user: payload.user.id })
    .then((r) => r.user?.profile?.email)
    .catch(() => undefined);
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
      ? "✅ Approved. The agent is continuing."
      : "🚫 Denied. The agent was told no."
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
