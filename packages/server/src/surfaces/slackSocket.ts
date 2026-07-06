/**
 * Slack Socket Mode: instead of Slack POSTing webhooks to a public URL, the
 * server dials out — apps.connections.open (authorized by the app-level
 * xapp- token) returns a WebSocket URL, and event/interactivity envelopes
 * stream in over that socket. Each envelope is acked immediately by
 * envelope_id and then processed through the exact same shared handlers the
 * webhook routes use, so governance behavior is identical either way.
 *
 * A connection opts in by having an app token; the Events webhook keeps
 * working regardless (shared event_id dedupe means a message delivered on
 * both paths still runs exactly one agent turn).
 */
import { isNotNull, and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import {
  processSlackEvent,
  processSlackInteraction,
  type SlackConnection,
  type SlackEventEnvelope,
  type SlackInteractionPayload,
} from "./slack.js";

interface SocketLogger {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

interface SocketEnvelope {
  envelope_id?: string;
  type?: string; // hello | events_api | interactive | disconnect
  reason?: string;
  payload?: unknown;
}

interface ManagedSocket {
  connectionId: string;
  ws: WebSocket | null;
  stopped: boolean;
  attempts: number;
  reconnectTimer: NodeJS.Timeout | null;
}

const managed = new Map<string, ManagedSocket>();
let log: SocketLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const MAX_BACKOFF_MS = 30_000;

function scheduleReconnect(entry: ManagedSocket): void {
  if (entry.stopped || entry.reconnectTimer) return;
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(entry.attempts, 5));
  entry.attempts += 1;
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    void connect(entry);
  }, delay);
  // Never keep the process alive just to retry a socket.
  entry.reconnectTimer.unref?.();
}

async function connect(entry: ManagedSocket): Promise<void> {
  if (entry.stopped) return;

  // Re-read the row each attempt so token rotations and edits apply
  // without a restart.
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, entry.connectionId),
        isNotNull(connections.encryptedAppToken),
      ),
    )
    .limit(1);
  if (!row) {
    stopSocket(entry.connectionId);
    return;
  }

  const baseUrl = row.baseUrl ?? "https://slack.com";
  let wsUrl: string | undefined;
  try {
    const appToken = decryptSecret(row.encryptedAppToken!);
    const res = await fetch(`${baseUrl}/api/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}` },
    });
    const data = (await res.json()) as { ok?: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) {
      log.warn(
        { connectionId: entry.connectionId, error: data.error },
        "slack socket: apps.connections.open refused",
      );
      scheduleReconnect(entry);
      return;
    }
    wsUrl = data.url;
  } catch (err) {
    log.warn({ err, connectionId: entry.connectionId }, "slack socket: open failed");
    scheduleReconnect(entry);
    return;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    log.warn({ err, connectionId: entry.connectionId }, "slack socket: dial failed");
    scheduleReconnect(entry);
    return;
  }
  entry.ws = ws;

  ws.addEventListener("open", () => {
    entry.attempts = 0;
    log.info({ connectionId: entry.connectionId }, "slack socket: connected");
  });

  ws.addEventListener("message", (event) => {
    void handleFrame(entry, row, ws, String(event.data));
  });

  ws.addEventListener("close", () => {
    if (entry.ws === ws) entry.ws = null;
    if (!entry.stopped) {
      log.warn({ connectionId: entry.connectionId }, "slack socket: closed, reconnecting");
      scheduleReconnect(entry);
    }
  });

  ws.addEventListener("error", () => {
    // close always follows error; reconnect is scheduled there.
  });
}

async function handleFrame(
  entry: ManagedSocket,
  connection: SlackConnection,
  ws: WebSocket,
  raw: string,
): Promise<void> {
  let envelope: SocketEnvelope;
  try {
    envelope = JSON.parse(raw) as SocketEnvelope;
  } catch {
    log.warn({ connectionId: entry.connectionId }, "slack socket: non-JSON frame");
    return;
  }

  // Ack before processing — Slack redelivers unacked envelopes within
  // seconds, and a slow agent turn must not look like a failed delivery.
  if (envelope.envelope_id) {
    try {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    } catch {
      // Socket died mid-ack; the redelivery will be deduped by event_id.
    }
  }

  switch (envelope.type) {
    case "hello":
      return;
    case "disconnect":
      // Slack refreshes sockets periodically; reconnect through a fresh
      // apps.connections.open call.
      log.info(
        { connectionId: entry.connectionId, reason: envelope.reason },
        "slack socket: server asked us to reconnect",
      );
      try {
        ws.close();
      } catch {
        // Already closing.
      }
      return;
    case "events_api": {
      const result = await processSlackEvent(
        connection,
        (envelope.payload ?? {}) as SlackEventEnvelope,
        log,
      );
      if (result.error) {
        log.warn(
          { connectionId: entry.connectionId, result },
          "slack socket: event processing failed",
        );
      }
      return;
    }
    case "interactive":
      await processSlackInteraction(
        connection,
        (envelope.payload ?? {}) as SlackInteractionPayload,
      );
      return;
    default:
      return;
  }
}

function stopSocket(connectionId: string): void {
  const entry = managed.get(connectionId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  try {
    entry.ws?.close();
  } catch {
    // Already closed.
  }
  managed.delete(connectionId);
}

/**
 * Reconcile running sockets with the database: open one per Slack
 * connection that has an app token, close ones whose connection lost the
 * token or was deleted. Called at boot and after connection mutations.
 */
export async function refreshSlackSockets(): Promise<void> {
  if (typeof WebSocket === "undefined") {
    log.warn({}, "slack socket: WebSocket unavailable (Node >= 22 required); Socket Mode off");
    return;
  }
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(eq(connections.vendor, "slack"), isNotNull(connections.encryptedAppToken)),
    );
  const wanted = new Set(rows.map((r) => r.id));
  for (const id of [...managed.keys()]) {
    if (!wanted.has(id)) stopSocket(id);
  }
  for (const id of wanted) {
    if (managed.has(id)) continue;
    const entry: ManagedSocket = {
      connectionId: id,
      ws: null,
      stopped: false,
      attempts: 0,
      reconnectTimer: null,
    };
    managed.set(id, entry);
    void connect(entry);
  }
}

export async function startSlackSocketManager(logger: SocketLogger): Promise<void> {
  log = logger;
  await refreshSlackSockets();
}

/** Close everything (tests, shutdown). */
export function stopSlackSocketManager(): void {
  for (const id of [...managed.keys()]) stopSocket(id);
}
