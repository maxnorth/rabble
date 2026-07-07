import { describe, expect, it } from "vitest";
import { shouldEngageSlack } from "./slack.js";

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
