import { describe, expect, it } from "vitest";
import {
  REQUIRED_BOT_EVENTS,
  REQUIRED_BOT_SCOPES,
  diffManifest,
  mergeRequiredSettings,
} from "./slackManifest.js";

describe("mergeRequiredSettings", () => {
  it("adds every required scope, event, and interactivity to an empty manifest", () => {
    const merged = mergeRequiredSettings({}, { socketMode: false });
    expect(merged.oauth_config?.scopes?.bot).toEqual(REQUIRED_BOT_SCOPES);
    expect(merged.settings?.event_subscriptions?.bot_events).toEqual(REQUIRED_BOT_EVENTS);
    expect(merged.settings?.interactivity?.is_enabled).toBe(true);
    // The Messages tab is Slack's prerequisite for DMing a bot at all.
    expect(merged.features?.app_home?.messages_tab_enabled).toBe(true);
    expect(merged.features?.app_home?.messages_tab_read_only_enabled).toBe(false);
  });

  it("sets socket mode to match the connection's transport", () => {
    expect(
      mergeRequiredSettings({}, { socketMode: true }).settings?.socket_mode_enabled,
    ).toBe(true);
    expect(
      mergeRequiredSettings({}, { socketMode: false }).settings?.socket_mode_enabled,
    ).toBe(false);
  });

  it("turns socket mode OFF for webhook connections even if the app has it on", () => {
    const merged = mergeRequiredSettings(
      { settings: { socket_mode_enabled: true } },
      { socketMode: false },
    );
    expect(merged.settings?.socket_mode_enabled).toBe(false);
  });

  it("pins delivery/callback URLs to publicUrl for webhook connections only", () => {
    const webhook = mergeRequiredSettings(
      { settings: { event_subscriptions: { request_url: "https://old.example/api/inbound/slack" } } },
      { socketMode: false, publicUrl: "https://new.example/" },
    );
    expect(webhook.settings?.event_subscriptions?.request_url).toBe(
      "https://new.example/api/inbound/slack",
    );
    expect(webhook.settings?.interactivity?.request_url).toBe(
      "https://new.example/api/inbound/slack-interactive",
    );
    expect(webhook.oauth_config?.redirect_urls).toEqual([
      "https://new.example/api/connections/slack/oauth/callback",
    ]);

    const socket = mergeRequiredSettings(
      { settings: { event_subscriptions: { request_url: "https://old.example/api/inbound/slack" } } },
      { socketMode: true, publicUrl: "https://new.example" },
    );
    expect(socket.settings?.event_subscriptions?.request_url).toBe(
      "https://old.example/api/inbound/slack",
    );
  });

  it("unions with existing scopes/events without duplicating or reordering", () => {
    const merged = mergeRequiredSettings(
      {
        oauth_config: { scopes: { bot: ["chat:write", "commands"] } },
        settings: { event_subscriptions: { bot_events: ["app_mention", "app_home_opened"] } },
      },
      { socketMode: false },
    );
    // existing first (order preserved), then only the missing required ones
    expect(merged.oauth_config?.scopes?.bot?.slice(0, 3)).toEqual([
      "chat:write",
      "commands",
      "app_mentions:read",
    ]);
    expect(merged.oauth_config?.scopes?.bot?.filter((s) => s === "chat:write")).toHaveLength(1);
    expect(merged.settings?.event_subscriptions?.bot_events).toContain("app_home_opened");
    expect(
      merged.settings?.event_subscriptions?.bot_events?.filter((e) => e === "app_mention"),
    ).toHaveLength(1);
  });

  it("preserves unrelated manifest fields and does not mutate its input", () => {
    const input = {
      display_information: { name: "Malgarth Agent", description: "keep me" },
      oauth_config: { scopes: { bot: ["chat:write"] } },
    };
    const merged = mergeRequiredSettings(input, { socketMode: false });
    expect(merged.display_information).toEqual({
      name: "Malgarth Agent",
      description: "keep me",
    });
    // input untouched (deep clone)
    expect(input.oauth_config.scopes.bot).toEqual(["chat:write"]);
  });
});

describe("diffManifest", () => {
  it("reports the added scopes/events and toggle changes", () => {
    const before = { oauth_config: { scopes: { bot: ["chat:write"] } } };
    const after = mergeRequiredSettings(before, { socketMode: true });
    const diff = diffManifest(before, after);
    expect(diff.addedScopes).toContain("users:read.email");
    expect(diff.addedScopes).not.toContain("chat:write");
    expect(diff.addedEvents).toEqual(REQUIRED_BOT_EVENTS);
    expect(diff.socketModeChanged).toBe(true);
    expect(diff.interactivityChanged).toBe(true);
  });

  it("is a no-op diff when the manifest already matches the transport", () => {
    const already = mergeRequiredSettings({}, { socketMode: false });
    const diff = diffManifest(already, mergeRequiredSettings(already, { socketMode: false }));
    expect(diff.addedScopes).toEqual([]);
    expect(diff.addedEvents).toEqual([]);
    expect(diff.socketModeChanged).toBe(false);
    expect(diff.interactivityChanged).toBe(false);
  });
});
