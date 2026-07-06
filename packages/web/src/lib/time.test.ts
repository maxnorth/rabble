import { describe, expect, it } from "vitest";
import { relativeTime, AGENT_COLORS, AGENT_GLYPHS } from "./time";

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
