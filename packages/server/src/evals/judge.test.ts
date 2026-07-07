import { describe, expect, it } from "vitest";
import { parseVerdict } from "./judge.js";

describe("parseVerdict", () => {
  it("reads PASS/FAIL from the first line, reasoning from the rest", () => {
    expect(parseVerdict("PASS\nStays on topic.")).toEqual({
      passed: true,
      reasoning: "Stays on topic.",
    });
    expect(parseVerdict("FAIL\nIgnored the deploy question.")).toEqual({
      passed: false,
      reasoning: "Ignored the deploy question.",
    });
  });

  it("is case-insensitive and falls back to the line as its own reasoning", () => {
    expect(parseVerdict("pass")).toEqual({ passed: true, reasoning: "pass" });
    expect(parseVerdict("Fail")).toEqual({ passed: false, reasoning: "Fail" });
  });

  it("lets FAIL win an ambiguous verdict line (conservative default)", () => {
    // A line naming both must not read as a pass.
    expect(parseVerdict("FAIL, though it could PASS on retry").passed).toBe(false);
    expect(parseVerdict("PASS — does not FAIL any check").passed).toBe(false);
  });

  it("does not treat PASS embedded in a word as a verdict", () => {
    // \b word boundary: "PASSABLE" / "COMPASS" are not PASS.
    expect(parseVerdict("PASSABLE effort but off-topic").passed).toBe(false);
  });

  it("joins multi-line reasoning and trims leading whitespace", () => {
    expect(parseVerdict("  PASS\nline one\nline two")).toEqual({
      passed: true,
      reasoning: "line one line two",
    });
  });

  it("caps reasoning so a runaway judge can't bloat the row", () => {
    const v = parseVerdict(`FAIL\n${"x".repeat(900)}`);
    expect(v.passed).toBe(false);
    expect(v.reasoning.length).toBe(500);
  });

  it("empty input is a fail with empty reasoning", () => {
    expect(parseVerdict("   ")).toEqual({ passed: false, reasoning: "" });
  });
});
