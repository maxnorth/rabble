/**
 * Built-in Slack workspace tools. Slack's hosted MCP server only accepts
 * its own OAuth — a workspace bot token is rejected — so "use the Slack
 * connection I already created" can't be satisfied by any external
 * endpoint. Instead of hosting a bridge server (needless public surface),
 * the platform implements the tools directly against the Slack Web API
 * with the connection's bot token.
 *
 * To the rest of the system this is still just an MCP server row: the
 * "Slack (your workspace)" library tile registers a connection-mode
 * server whose URL is the `builtin:slack` marker, its tool catalog is
 * this module's list, and the runtime dispatches calls here instead of
 * over HTTP. Attachment, per-tool toggles, grants, audit, and chips all
 * behave identically — no network hop, no endpoint.
 */
import type { McpToolInfo } from "@rabblehq/core";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections, mcpServers } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { slackClient } from "../surfaces/slackClient.js";

/** URL marker for the built-in Slack workspace toolset. */
export const BUILTIN_SLACK_URL = "builtin:slack";

export function isBuiltinSlack(url: string): boolean {
  return url === BUILTIN_SLACK_URL;
}

export const SLACK_TOOLS: McpToolInfo[] = [
  {
    name: "post_message",
    description: "Post a message to a channel as the workspace bot",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID (e.g. C0123…)" },
        text: { type: "string", description: "Message text (mrkdwn)" },
        thread_ts: { type: "string", description: "Reply in this thread (optional)" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "list_channels",
    description: "List channels in the workspace",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max channels (default 100)" },
      },
    },
  },
  {
    name: "get_channel_info",
    description: "Details for one channel (topic, purpose, member count)",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Channel ID" } },
      required: ["channel"],
    },
  },
  {
    name: "get_channel_history",
    description: "Recent messages in a channel, newest first",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID" },
        limit: { type: "number", description: "Max messages (default 20)" },
      },
      required: ["channel"],
    },
  },
  {
    name: "get_thread_replies",
    description: "The messages in one thread",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID" },
        thread_ts: { type: "string", description: "The thread's root timestamp" },
        limit: { type: "number", description: "Max replies (default 20)" },
      },
      required: ["channel", "thread_ts"],
    },
  },
  {
    name: "list_users",
    description: "List workspace members",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max users (default 100)" },
      },
    },
  },
  {
    name: "get_user",
    description: "Profile details for one user",
    inputSchema: {
      type: "object",
      properties: { user: { type: "string", description: "User ID (e.g. U0123…)" } },
      required: ["user"],
    },
  },
  {
    name: "lookup_user_by_email",
    description: "Find a workspace user by email address",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
  },
  {
    name: "search_messages",
    description:
      "Search messages the bot can see (public channels). Requires the " +
      "Slack app to have the search:read.public bot scope.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (Slack search syntax)" },
        limit: { type: "number", description: "Max matches (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "add_reaction",
    description: "Add an emoji reaction to a message",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID" },
        ts: { type: "string", description: "Timestamp of the message" },
        emoji: { type: "string", description: "Emoji name without colons, e.g. thumbsup" },
      },
      required: ["channel", "ts", "emoji"],
    },
  },
  {
    name: "join_channel",
    description: "Join a public channel so the bot can read and post there",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Channel ID" } },
      required: ["channel"],
    },
  },
];

/** The connection a built-in Slack server acts through, or a clear error. */
async function resolveConnection(
  server: typeof mcpServers.$inferSelect,
): Promise<{ baseUrl: string | null; token: string }> {
  if (!server.connectionId) {
    throw new Error(
      "This Slack toolset has no connection linked — re-register it against a Slack connection.",
    );
  }
  const [conn] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, server.connectionId))
    .limit(1);
  if (!conn?.encryptedToken) {
    throw new Error(
      "The linked Slack connection no longer holds a credential — reconnect it under Admin, Connections.",
    );
  }
  return { baseUrl: conn.baseUrl, token: decryptSecret(conn.encryptedToken) };
}

const trimMessage = (m: {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
}) => ({
  ts: m.ts,
  user: m.user ?? m.bot_id,
  text: m.text,
  ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
  ...(m.reply_count ? { reply_count: m.reply_count } : {}),
});

/** Verify the toolset can reach Slack as its connection (test-connection). */
export async function verifyBuiltinSlack(
  server: typeof mcpServers.$inferSelect,
): Promise<void> {
  const { baseUrl, token } = await resolveConnection(server);
  await slackClient(baseUrl, token).auth.test();
}

/** Run one built-in Slack tool through the server's linked connection. */
export async function runSlackWorkspaceTool(
  server: typeof mcpServers.$inferSelect,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { baseUrl, token } = await resolveConnection(server);
  const slack = slackClient(baseUrl, token);
  const str = (k: string) => String(args[k] ?? "");
  const num = (k: string, fallback: number) =>
    Number.isFinite(Number(args[k])) && Number(args[k]) > 0
      ? Math.min(Number(args[k]), 200)
      : fallback;

  switch (name) {
    case "post_message": {
      const res = await slack.chat.postMessage({
        channel: str("channel"),
        text: str("text"),
        ...(args.thread_ts ? { thread_ts: str("thread_ts") } : {}),
      });
      return JSON.stringify({ ok: true, channel: res.channel, ts: res.ts });
    }
    case "list_channels": {
      const res = await slack.conversations.list({ limit: num("limit", 100) });
      return JSON.stringify({
        channels: (res.channels ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          is_private: c.is_private ?? false,
        })),
      });
    }
    case "get_channel_info": {
      const res = await slack.conversations.info({ channel: str("channel") });
      const c = res.channel ?? {};
      return JSON.stringify({
        id: c.id,
        name: c.name,
        topic: c.topic?.value,
        purpose: c.purpose?.value,
        num_members: c.num_members,
      });
    }
    case "get_channel_history": {
      const res = await slack.conversations.history({
        channel: str("channel"),
        limit: num("limit", 20),
      });
      return JSON.stringify({ messages: (res.messages ?? []).map(trimMessage) });
    }
    case "get_thread_replies": {
      const res = await slack.conversations.replies({
        channel: str("channel"),
        ts: str("thread_ts"),
        limit: num("limit", 20),
      });
      return JSON.stringify({ messages: (res.messages ?? []).map(trimMessage) });
    }
    case "list_users": {
      const res = await slack.users.list({ limit: num("limit", 100) });
      return JSON.stringify({
        users: (res.members ?? [])
          .filter((u) => !u.deleted)
          .map((u) => ({
            id: u.id,
            name: u.profile?.real_name ?? u.name,
            email: u.profile?.email,
            is_bot: u.is_bot ?? false,
          })),
      });
    }
    case "get_user": {
      const res = await slack.users.info({ user: str("user") });
      const u = res.user;
      return JSON.stringify({
        id: u?.id,
        name: u?.profile?.real_name ?? u?.name,
        email: u?.profile?.email,
        title: u?.profile?.title,
        tz: u?.tz,
        is_bot: u?.is_bot ?? false,
      });
    }
    case "lookup_user_by_email": {
      const res = await slack.users.lookupByEmail({ email: str("email") });
      return JSON.stringify({
        id: res.user?.id,
        name: res.user?.profile?.real_name ?? res.user?.name,
      });
    }
    case "search_messages": {
      // Bot tokens can search via Slack's granular search scopes
      // (search:read.public); without the scope, Slack's error passes
      // through to the model verbatim.
      const res = await slack.search.messages({
        query: str("query"),
        count: num("limit", 20),
      });
      return JSON.stringify({
        total: res.messages?.total ?? 0,
        matches: (res.messages?.matches ?? []).map((m) => ({
          channel: { id: m.channel?.id, name: m.channel?.name },
          ts: m.ts,
          user: m.user ?? m.username,
          text: m.text,
          permalink: m.permalink,
        })),
      });
    }
    case "add_reaction": {
      await slack.reactions.add({
        channel: str("channel"),
        timestamp: str("ts"),
        name: str("emoji"),
      });
      return JSON.stringify({ ok: true });
    }
    case "join_channel": {
      const res = await slack.conversations.join({ channel: str("channel") });
      return JSON.stringify({ ok: true, channel: res.channel?.id });
    }
    default:
      throw new Error(`Unknown Slack tool: ${name}`);
  }
}
