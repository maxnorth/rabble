import { describe, expect, it } from "vitest";
import {
  detectMention,
  dmAllowed,
  resolveChannelMode,
  shouldEngageSlack,
  type SurfaceRow,
} from "./slack.js";

const row = (label: string, responseMode = "thread", dmEnabled = true): SurfaceRow => ({
  label,
  responseMode,
  dmEnabled,
});

/**
 * The per-surface response-mode gating: whether a given Slack message gets a
 * reply. This is the whole behavior contract for the `all` / `thread` /
 * `mention` modes, so the truth table is enumerated exhaustively.
 */
describe("shouldEngageSlack", () => {
  const base = { isDm: false, isMention: false, mode: "mention", hasThreadSession: false };

  it("DMs always engage regardless of mode or mention", () => {
    for (const mode of ["all", "thread", "mention"]) {
      for (const hasThreadSession of [false, true]) {
        expect(shouldEngageSlack({ ...base, isDm: true, mode, hasThreadSession })).toBe(true);
      }
    }
  });

  it("an @-mention always engages, in any mode", () => {
    for (const mode of ["all", "thread", "mention"]) {
      expect(shouldEngageSlack({ ...base, isMention: true, mode })).toBe(true);
    }
  });

  it("mode 'all' answers every channel message", () => {
    expect(shouldEngageSlack({ ...base, mode: "all" })).toBe(true);
    expect(shouldEngageSlack({ ...base, mode: "all", hasThreadSession: true })).toBe(true);
  });

  it("mode 'thread' answers follow-ups only once a thread session exists", () => {
    // A non-mention with no active thread does NOT start a conversation.
    expect(shouldEngageSlack({ ...base, mode: "thread", hasThreadSession: false })).toBe(false);
    // A non-mention inside an engaged thread continues it.
    expect(shouldEngageSlack({ ...base, mode: "thread", hasThreadSession: true })).toBe(true);
  });

  it("mode 'mention' never answers a plain message, even inside a thread", () => {
    expect(shouldEngageSlack({ ...base, mode: "mention", hasThreadSession: false })).toBe(false);
    expect(shouldEngageSlack({ ...base, mode: "mention", hasThreadSession: true })).toBe(false);
  });

  it("unmapped channels (default mode) only answer mentions", () => {
    // Non-mention, no session, default 'mention' mode → ignored.
    expect(shouldEngageSlack({ ...base })).toBe(false);
  });
});

describe("detectMention", () => {
  it("app_mention events are mentions even without a bot id", () => {
    expect(detectMention("app_mention", "hi", undefined)).toBe(true);
  });

  it("message events mention when the text tags the bot (both tag forms)", () => {
    expect(detectMention("message", "hey <@U0BOT> status?", "U0BOT")).toBe(true);
    expect(detectMention("message", "hey <@U0BOT|garth> status?", "U0BOT")).toBe(true);
  });

  it("plain messages and tags of other users are not mentions", () => {
    expect(detectMention("message", "just chatting", "U0BOT")).toBe(false);
    expect(detectMention("message", "ask <@U0OTHER> instead", "U0BOT")).toBe(false);
    // Without a resolved bot id a message can never read as a mention.
    expect(detectMention("message", "hey <@U0BOT>", undefined)).toBe(false);
  });
});

describe("resolveChannelMode", () => {
  it("a channel-labeled surface wins, matching with or without '#'", () => {
    const rows = [row("", "thread"), row("#eng", "all")];
    expect(resolveChannelMode(rows, "eng", "C1").mode).toBe("all");
    expect(resolveChannelMode([row("eng", "all")], "eng", "C1").mode).toBe("all");
  });

  it("channel ids match too (directory lookup can fail)", () => {
    expect(resolveChannelMode([row("C1", "all")], "", "C1").mode).toBe("all");
  });

  it("channels without their own row inherit the workspace surface's mode", () => {
    const rows = [row("", "thread"), row("#other", "all")];
    const { matched, mode } = resolveChannelMode(rows, "eng", "C1");
    expect(matched).toBeUndefined();
    expect(mode).toBe("thread");
  });

  it("with no workspace row either, channels are mention-only", () => {
    expect(resolveChannelMode([row("#other", "all")], "eng", "C1").mode).toBe("mention");
    expect(resolveChannelMode([], "eng", "C1").mode).toBe("mention");
  });

  it("the workspace row never matches a channel by label", () => {
    // A channel literally named like the empty label can't exist, but the
    // workspace row must also never win the `matched` slot.
    const { matched } = resolveChannelMode([row("", "all")], "", "C1");
    expect(matched).toBeUndefined();
  });
});

describe("dmAllowed", () => {
  it("defaults on when no workspace row exists", () => {
    expect(dmAllowed([])).toBe(true);
    expect(dmAllowed([row("#eng")])).toBe(true);
  });

  it("follows the workspace row's dm_enabled", () => {
    expect(dmAllowed([row("", "thread", true)])).toBe(true);
    expect(dmAllowed([row("", "thread", false)])).toBe(false);
    // Channel rows never carry the DM decision.
    expect(dmAllowed([row("#eng", "all", false), row("", "thread", true)])).toBe(true);
  });
});
