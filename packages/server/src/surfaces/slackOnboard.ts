/**
 * Fully-managed Slack setup. Given a config token and a bot name, Rabble:
 *   1. creates the app from a manifest (apps.manifest.create) — which returns
 *      the OAuth client credentials + signing secret,
 *   2. configures Events API delivery + interactivity (apps.manifest.update)
 *      pointed at Rabble's own inbound URLs,
 *   3. hands back an install URL whose redirect_uri is Rabble's OAuth callback.
 * When the admin installs, the callback exchanges the code for the bot token.
 * No manual token pasting — the only human step is clicking "Allow".
 *
 * Uses the Events API (not Socket Mode) because the OAuth callback already
 * requires Rabble to be publicly reachable, and Events delivery then needs no
 * manually-generated app-level token — the signing secret comes from create.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import {
  REQUIRED_BOT_EVENTS,
  REQUIRED_BOT_SCOPES,
  currentAccessToken,
} from "./slackManifest.js";

type SlackConnection = typeof connections.$inferSelect;

async function api(
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

const callbackPath = "/api/connections/slack/oauth/callback";

export interface ProvisionResult {
  appId: string;
  installUrl: string;
}

/**
 * Create + configure a Slack app for this connection and return the install
 * URL. Requires a config token already stored on the connection.
 */
export async function provisionSlackApp(input: {
  connectionId: string;
  botName: string;
  publicUrl: string;
}): Promise<ProvisionResult> {
  const [connection] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, input.connectionId))
    .limit(1);
  if (!connection || connection.vendor !== "slack") {
    throw new Error("Slack connection not found");
  }
  const baseUrl = connection.baseUrl ?? "https://slack.com";
  const publicUrl = input.publicUrl.replace(/\/+$/, "");
  const configToken = await currentAccessToken(connection);
  const callbackUrl = `${publicUrl}${callbackPath}`;
  const name = input.botName.trim();
  if (!name) throw new Error("A bot name is required");

  // Fail fast before creating anything: Slack redirects the install to the
  // OAuth callback and delivers events to the request_url, so a local
  // address can never work.
  const isRealSlack = baseUrl === "https://slack.com";
  if (isRealSlack && /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(publicUrl)) {
    throw new Error(
      `Rabble is running at ${publicUrl}, which Slack can't reach. Set PUBLIC_URL ` +
        `to a public https address (e.g. an ngrok/cloudflared tunnel to this server) and retry`,
    );
  }

  // 1. Create — returns credentials (client_id/secret, signing_secret) + an
  // authorize URL. Settings (events/interactivity) can't be set at create.
  const created = await api(baseUrl, configToken, "apps.manifest.create", {
    manifest: {
      display_information: { name },
      features: { bot_user: { display_name: name } },
      oauth_config: {
        scopes: { bot: REQUIRED_BOT_SCOPES },
        redirect_urls: [callbackUrl],
      },
    },
  });
  if (!created.ok) throw new Error(`App creation failed (${created.error ?? "unknown"})`);
  const appId = created.app_id as string;
  const creds = created.credentials as {
    client_id?: string;
    client_secret?: string;
    signing_secret?: string;
  };
  const authorizeUrl = created.oauth_authorize_url as string;

  // 2. Store the credentials BEFORE configuring events: Slack verifies the
  // request_url lazily (a signed url_verification POST can arrive any time
  // after configuration), and /api/inbound/slack authenticates by signature —
  // the new app's signing secret must already be in the DB.
  const state = randomUUID();
  await db
    .update(connections)
    .set({
      slackAppId: appId,
      slackClientId: creds.client_id ?? null,
      encryptedClientSecret: creds.client_secret
        ? encryptSecret(creds.client_secret)
        : null,
      encryptedSigningSecret: creds.signing_secret
        ? encryptSecret(creds.signing_secret)
        : null,
      oauthState: state,
      status: "needs-auth",
    })
    .where(eq(connections.id, connection.id));

  // 3. Configure Events API delivery + interactivity at Rabble's inbound URLs.
  const configured = await api(baseUrl, configToken, "apps.manifest.update", {
    app_id: appId,
    manifest: {
      display_information: { name },
      features: { bot_user: { display_name: name } },
      oauth_config: {
        scopes: { bot: REQUIRED_BOT_SCOPES },
        redirect_urls: [callbackUrl],
      },
      settings: {
        event_subscriptions: {
          request_url: `${publicUrl}/api/inbound/slack`,
          bot_events: REQUIRED_BOT_EVENTS,
        },
        interactivity: {
          is_enabled: true,
          request_url: `${publicUrl}/api/inbound/slack-interactive`,
        },
        org_deploy_enabled: false,
      },
    },
  });
  if (!configured.ok) {
    // Roll back the half-made app + stored creds so a failed setup leaves
    // nothing behind.
    await api(baseUrl, configToken, "apps.manifest.delete", { app_id: appId }).catch(
      () => {},
    );
    await db
      .update(connections)
      .set({
        slackAppId: null,
        slackClientId: null,
        encryptedClientSecret: null,
        encryptedSigningSecret: null,
        oauthState: null,
      })
      .where(eq(connections.id, connection.id));
    const detail = configured.errors
      ? ` — ${JSON.stringify(configured.errors)}`
      : ` — Slack must be able to reach Rabble at ${publicUrl} to verify event delivery`;
    throw new Error(`App event configuration failed (${configured.error ?? "unknown"})${detail}`);
  }

  const installUrl =
    `${authorizeUrl}&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&state=${encodeURIComponent(state)}`;
  return { appId, installUrl };
}

export interface OAuthResult {
  connectionId: string;
  teamName: string | null;
}

/**
 * Handle the OAuth redirect: match the state to a connection, exchange the
 * code for the bot token, and store it. Completes the managed setup.
 */
export async function completeSlackOAuth(input: {
  code: string;
  state: string;
  publicUrl: string;
}): Promise<OAuthResult> {
  const [connection] = await db
    .select()
    .from(connections)
    .where(
      and(eq(connections.vendor, "slack"), eq(connections.oauthState, input.state)),
    )
    .limit(1);
  if (!connection) throw new Error("Unknown or expired install request");
  if (!connection.slackClientId || !connection.encryptedClientSecret) {
    throw new Error("Connection is missing OAuth credentials");
  }
  const baseUrl = connection.baseUrl ?? "https://slack.com";
  const callbackUrl = `${input.publicUrl.replace(/\/+$/, "")}${callbackPath}`;

  const res = await api(baseUrl, null, "oauth.v2.access", {
    client_id: connection.slackClientId,
    client_secret: decryptSecret(connection.encryptedClientSecret),
    code: input.code,
    redirect_uri: callbackUrl,
  });
  if (!res.ok || typeof res.access_token !== "string") {
    throw new Error(`Install failed (${res.error ?? "no bot token returned"})`);
  }

  await db
    .update(connections)
    .set({
      encryptedToken: encryptSecret(res.access_token),
      oauthState: null,
      status: "connected",
    })
    .where(eq(connections.id, connection.id));

  const team = res.team as { name?: string } | undefined;
  return { connectionId: connection.id, teamName: team?.name ?? null };
}
