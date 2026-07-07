import { describe, expect, it } from "vitest";
import { relativeTime, relativeFuture, count, AGENT_COLORS, AGENT_GLYPHS } from "./time";

describe("count", () => {
  it("pluralizes on everything but one", () => {
    expect(count(1, "tool")).toBe("1 tool");
    expect(count(0, "tool")).toBe("0 tools");
    expect(count(3, "tool")).toBe("3 tools");
  });
  it("takes an explicit plural", () => {
    expect(count(2, "agent", "agents")).toBe("2 agents");
  });
});

describe("relativeTime", () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("covers the ladder from seconds to weekday names", () => {
    expect(relativeTime(at(5_000))).toBe("just now");
    expect(relativeTime(at(4 * 60_000))).toBe("4m ago");
    expect(relativeTime(at(3 * 3_600_000))).toBe("3h ago");
    expect(relativeTime(at(30 * 3_600_000))).toBe("Yesterday");
    // 2-6 days back: short weekday; older: short date
    expect(relativeTime(at(3 * 86_400_000))).toMatch(/^[A-Z][a-z]{2}$/);
    expect(relativeTime(at(30 * 86_400_000))).toMatch(/[A-Z][a-z]{2} \d{1,2}/);
  });

  it("reads 'never' for null-ish input", () => {
    expect(relativeTime(null)).toBe("never");
    expect(relativeTime(undefined)).toBe("never");
  });
});

describe("relativeFuture", () => {
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("covers the ladder from minutes to days", () => {
    expect(relativeFuture(inMs(2 * 60_000))).toBe("in 2m");
    expect(relativeFuture(inMs(3 * 3_600_000))).toBe("in 3h");
    expect(relativeFuture(inMs(26 * 3_600_000))).toBe("tomorrow");
    expect(relativeFuture(inMs(4 * 86_400_000))).toBe("in 4d");
  });

  it("reads 'now' for past/immediate and '—' for null-ish", () => {
    expect(relativeFuture(inMs(-5_000))).toBe("now");
    expect(relativeFuture(null)).toBe("—");
    expect(relativeFuture(undefined)).toBe("—");
  });
});

describe("agent identity palette", () => {
  it("maps every named color to a css variable", () => {
    for (const value of Object.values(AGENT_COLORS)) {
      expect(value).toMatch(/^var\(--/);
    }
  });
  it("offers distinct glyphs", () => {
    expect(new Set(AGENT_GLYPHS).size).toBe(AGENT_GLYPHS.length);
  });
});
