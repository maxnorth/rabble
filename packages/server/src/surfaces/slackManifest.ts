/**
 * Sync the settings Rabble needs onto a Slack app's manifest via the
 * apps.manifest.* API. Flow: rotate the config token → export the current
 * manifest → union-merge in our required scopes/events + flip Socket Mode and
 * interactivity on → validate → (unless dry run) update. We only ever ADD to
 * the manifest, never remove, so we don't clobber the app's name/description or
 * anything the user set by hand.
 *
 * These methods require an App *Configuration* token (xoxe.xoxp-…), not the
 * bot or app-level token — see docs/DECISIONS and the connection's
 * encryptedConfigToken/RefreshToken columns.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { slackClient } from "./slackClient.js";

type SlackConnection = typeof connections.$inferSelect;

/** Bot scopes the platform relies on (identity, posting, events, status). */
export const REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "chat:write.public",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "users:read",
  "users:read.email",
  "assistant:write",
];

/** Bot events the surface pipeline needs delivered. */
export const REQUIRED_BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
];

interface SlackManifest {
  features?: {
    app_home?: {
      messages_tab_enabled?: boolean;
      messages_tab_read_only_enabled?: boolean;
    };
  };
  oauth_config?: {
    scopes?: { bot?: string[]; user?: string[] };
    redirect_urls?: string[];
  };
  settings?: {
    event_subscriptions?: { bot_events?: string[]; request_url?: string };
    interactivity?: { is_enabled?: boolean; request_url?: string };
    socket_mode_enabled?: boolean;
  };
  [key: string]: unknown;
}

function union(existing: string[], required: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const r of required) if (!seen.has(r)) out.push(r);
  return out;
}

/** Add Rabble's required scopes/events + transport/interactivity settings,
 * preserving everything else in the manifest. Socket Mode supersedes Events
 * API delivery on Slack's side, so it must match the connection's transport:
 * on for app-token (socket) connections, off for webhook connections — never
 * forced on, or a sync would silently stop webhook event delivery.
 * Pure — exported for tests. */
export function mergeRequiredSettings(
  manifest: SlackManifest,
  opts: { socketMode: boolean; publicUrl?: string },
): SlackManifest {
  const m: SlackManifest = structuredClone(manifest);
  m.oauth_config ??= {};
  m.oauth_config.scopes ??= {};
  m.oauth_config.scopes.bot = union(m.oauth_config.scopes.bot ?? [], REQUIRED_BOT_SCOPES);
  m.settings ??= {};
  m.settings.event_subscriptions ??= {};
  m.settings.event_subscriptions.bot_events = union(
    m.settings.event_subscriptions.bot_events ?? [],
    REQUIRED_BOT_EVENTS,
  );
  m.settings.socket_mode_enabled = opts.socketMode;
  m.settings.interactivity ??= {};
  m.settings.interactivity.is_enabled = true;
  // The Messages tab is Slack's switch for DMing a bot; whether the agent
  // actually answers DMs is the surface's dm_enabled setting.
  m.features ??= {};
  m.features.app_home = {
    ...m.features.app_home,
    messages_tab_enabled: true,
    messages_tab_read_only_enabled: false,
  };
  // Webhook connections: pin delivery/callback URLs to where Rabble lives
  // now — a changed PUBLIC_URL (new tunnel, new domain) otherwise leaves the
  // app pointed at a dead address with no error anywhere.
  if (!opts.socketMode && opts.publicUrl) {
    const root = opts.publicUrl.replace(/\/+$/, "");
    m.settings.event_subscriptions.request_url = `${root}/api/inbound/slack`;
    m.settings.interactivity.request_url = `${root}/api/inbound/slack-interactive`;
    m.oauth_config.redirect_urls = [`${root}/api/connections/slack/oauth/callback`];
  }
  return m;
}

export interface ManifestDiff {
  addedScopes: string[];
  addedEvents: string[];
  socketModeChanged: boolean;
  interactivityChanged: boolean;
  urlsChanged: boolean;
  messagesTabChanged: boolean;
}

/** What mergeRequiredSettings changed. Pure — exported for tests. */
export function diffManifest(before: SlackManifest, after: SlackManifest): ManifestDiff {
  const beforeScopes = new Set(before.oauth_config?.scopes?.bot ?? []);
  const beforeEvents = new Set(before.settings?.event_subscriptions?.bot_events ?? []);
  return {
    addedScopes: (after.oauth_config?.scopes?.bot ?? []).filter((s) => !beforeScopes.has(s)),
    addedEvents: (after.settings?.event_subscriptions?.bot_events ?? []).filter(
      (e) => !beforeEvents.has(e),
    ),
    socketModeChanged:
      (before.settings?.socket_mode_enabled ?? false) !==
      (after.settings?.socket_mode_enabled ?? false),
    interactivityChanged:
      (before.settings?.interactivity?.is_enabled ?? false) !==
      (after.settings?.interactivity?.is_enabled ?? false),
    urlsChanged:
      before.settings?.event_subscriptions?.request_url !==
        after.settings?.event_subscriptions?.request_url ||
      before.settings?.interactivity?.request_url !==
        after.settings?.interactivity?.request_url ||
      JSON.stringify(before.oauth_config?.redirect_urls ?? []) !==
        JSON.stringify(after.oauth_config?.redirect_urls ?? []),
    messagesTabChanged:
      (before.features?.app_home?.messages_tab_enabled ?? false) !==
        (after.features?.app_home?.messages_tab_enabled ?? false) ||
      (before.features?.app_home?.messages_tab_read_only_enabled ?? false) !==
        (after.features?.app_home?.messages_tab_read_only_enabled ?? false),
  };
}

/** Raw config-token API call (form-encoded, non-throwing) so we can read
 * validation errors rather than have the SDK reject. */
async function configCall(
  baseUrl: string,
  token: string | null,
  method: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function saveSlackConfigTokens(
  connectionId: string,
  accessToken: string,
  refreshToken?: string,
): Promise<void> {
  await db
    .update(connections)
    .set({
      encryptedConfigToken: encryptSecret(accessToken),
      encryptedConfigRefreshToken: refreshToken ? encryptSecret(refreshToken) : null,
    })
    .where(eq(connections.id, connectionId));
}

/**
 * The access token to use for a sync. With a refresh token we rotate to a
 * fresh pair (config access tokens expire in 12h); without one we use the
 * stored access token directly (valid until it expires — then re-paste).
 */
export async function currentAccessToken(connection: SlackConnection): Promise<string> {
  if (connection.encryptedConfigRefreshToken) return rotateConfigToken(connection);
  if (connection.encryptedConfigToken) return decryptSecret(connection.encryptedConfigToken);
  throw new Error("Add a Slack app configuration token first");
}

/** Rotate the stored refresh token to a fresh access+refresh pair (config
 * tokens are short-lived), persist the new pair, return the access token. */
async function rotateConfigToken(connection: SlackConnection): Promise<string> {
  if (!connection.encryptedConfigRefreshToken) {
    throw new Error("Add a Slack app configuration token first");
  }
  const baseUrl = connection.baseUrl ?? "https://slack.com";
  const refresh = decryptSecret(connection.encryptedConfigRefreshToken);
  const res = await configCall(baseUrl, null, "tooling.tokens.rotate", {
    refresh_token: refresh,
  });
  if (!res.ok || typeof res.token !== "string" || typeof res.refresh_token !== "string") {
    throw new Error(
      `Config token rotation failed (${res.error ?? "unknown"}). Regenerate the token`,
    );
  }
  await saveSlackConfigTokens(connection.id, res.token, res.refresh_token);
  return res.token;
}

/** apps.manifest.export needs the app_id; resolve it from the bot token. */
async function resolveAppId(connection: SlackConnection): Promise<string> {
  const botToken = connection.encryptedToken ? decryptSecret(connection.encryptedToken) : "";
  const client = slackClient(connection.baseUrl, botToken);
  const auth = await client.auth.test();
  const botId = typeof auth.bot_id === "string" ? auth.bot_id : undefined;
  if (!botId) throw new Error("Could not resolve the bot from Slack (check the bot token)");
  const info = await client.bots.info({ bot: botId });
  const appId = (info.bot as { app_id?: string } | undefined)?.app_id;
  if (!appId) throw new Error("Could not resolve the Slack app id");
  return appId;
}

export interface SlackSyncResult extends ManifestDiff {
  applied: boolean;
  reinstallRequired: boolean;
}

/**
 * Rotate → export → merge → validate → (apply). With dryRun, everything runs
 * except the final update, so the caller can preview the diff safely.
 */
export async function syncSlackApp(
  connectionId: string,
  opts: { dryRun: boolean; publicUrl?: string },
): Promise<SlackSyncResult> {
  const [connection] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  if (!connection) throw new Error("Connection not found");
  if (connection.vendor !== "slack") throw new Error("Not a Slack connection");

  const baseUrl = connection.baseUrl ?? "https://slack.com";
  const accessToken = await currentAccessToken(connection);
  const appId = await resolveAppId(connection);

  const exported = await configCall(baseUrl, accessToken, "apps.manifest.export", {
    app_id: appId,
  });
  if (!exported.ok || !exported.manifest) {
    throw new Error(`Manifest export failed (${exported.error ?? "unknown"})`);
  }
  const current = exported.manifest as SlackManifest;
  const merged = mergeRequiredSettings(current, {
    socketMode: connection.encryptedAppToken != null,
    publicUrl: opts.publicUrl,
  });
  const diff = diffManifest(current, merged);

  // Validate the merged manifest before ever applying it — catches problems
  // (bad scope, malformed setting) without touching the live app.
  const validated = await configCall(baseUrl, accessToken, "apps.manifest.validate", {
    app_id: appId,
    manifest: merged,
  });
  if (!validated.ok) {
    throw new Error(
      `Manifest validation failed: ${validated.error ?? JSON.stringify(validated.errors ?? {})}`,
    );
  }

  let applied = false;
  if (!opts.dryRun) {
    const updated = await configCall(baseUrl, accessToken, "apps.manifest.update", {
      app_id: appId,
      manifest: merged,
    });
    if (!updated.ok) throw new Error(`Manifest update failed (${updated.error ?? "unknown"})`);
    applied = true;
  }

  return {
    ...diff,
    applied,
    // New scopes only take effect once a human reinstalls the app.
    reinstallRequired: diff.addedScopes.length > 0,
  };
}
