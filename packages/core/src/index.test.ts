import { describe, expect, it } from "vitest";
import {
  agentCapabilitiesSchema,
  createAutomationSchema,
  createGrantSchema,
  cronMatches,
  isValidCron,
  slugify,
  streamEventSchema,
  toolCallSchema,
  userPreferencesSchema,
} from "./index.js";

describe("cronMatches", () => {
  // UTC reference dates with known weekdays: 2021-01-01 = Friday.
  const at = (m: number, d: number, hh: number, mm: number) =>
    new Date(Date.UTC(2021, m, d, hh, mm));
  const fri1 = at(0, 1, 9, 0); // Fri Jan 1
  const sun3 = at(0, 3, 9, 0); // Sun Jan 3
  const mon4 = at(0, 4, 9, 0); // Mon Jan 4
  const tue5 = at(0, 5, 0, 0); // Tue Jan 5 midnight

  it("matches minute/hour fields, including step", () => {
    expect(cronMatches("0 9 * * *", mon4)).toBe(true);
    expect(cronMatches("0 9 * * *", at(0, 4, 9, 1))).toBe(false); // minute off
    expect(cronMatches("0 9 * * *", at(0, 4, 10, 0))).toBe(false); // hour off
    expect(cronMatches("*/15 * * * *", at(0, 4, 3, 30))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(0, 4, 3, 7))).toBe(false);
  });

  it("matches weekday ranges, treating Sunday as 0 or 7", () => {
    expect(cronMatches("0 9 * * 1-5", mon4)).toBe(true); // Mon in 1-5
    expect(cronMatches("0 9 * * 1-5", sun3)).toBe(false); // Sun excluded
    expect(cronMatches("0 9 * * 0", sun3)).toBe(true);
    expect(cronMatches("0 9 * * 7", sun3)).toBe(true);
  });

  it("applies the day-of-month / day-of-week OR rule when both are set", () => {
    // "1st of month OR Monday", at midnight.
    const expr = "0 0 1 * 1";
    expect(cronMatches(expr, at(0, 4, 0, 0))).toBe(true); // Mon (dow match)
    expect(cronMatches(expr, at(0, 1, 0, 0))).toBe(true); // 1st (dom match)
    expect(cronMatches(expr, tue5)).toBe(false); // neither
  });

  it("ANDs the day fields when one is a wildcard", () => {
    expect(cronMatches("0 0 1 * *", at(0, 1, 0, 0))).toBe(true); // 1st
    expect(cronMatches("0 0 1 * *", at(0, 2, 0, 0))).toBe(false); // 2nd
  });

  it("is false for an invalid expression", () => {
    expect(cronMatches("not a cron", fri1)).toBe(false);
    expect(cronMatches("0 9 * *", fri1)).toBe(false);
  });
});

describe("isValidCron", () => {
  it("accepts standard 5-field expressions", () => {
    expect(isValidCron("0 9 * * 1-5")).toBe(true); // weekdays at 9am
    expect(isValidCron("*/15 * * * *")).toBe(true); // every 15 min
    expect(isValidCron("0 0,12 1 */2 *")).toBe(true); // lists + steps
    expect(isValidCron("30 6 * * 0")).toBe(true); // Sunday
  });
  it("rejects malformed or out-of-range expressions", () => {
    expect(isValidCron("0 9 * *")).toBe(false); // 4 fields
    expect(isValidCron("60 9 * * 1-5")).toBe(false); // minute > 59
    expect(isValidCron("0 24 * * *")).toBe(false); // hour > 23
    expect(isValidCron("0 9 * * 8")).toBe(false); // weekday > 7
    expect(isValidCron("0 9 * * mon")).toBe(false); // names unsupported
    expect(isValidCron("0 9 5-1 * *")).toBe(false); // inverted range
    expect(isValidCron("every day")).toBe(false);
  });
  it("gates createAutomationSchema", () => {
    expect(() =>
      createAutomationSchema.parse({ name: "x", schedule: "nope", prompt: "" }),
    ).toThrow();
    expect(
      createAutomationSchema.parse({ name: "x", schedule: "0 9 * * 1-5", prompt: "" })
        .schedule,
    ).toBe("0 9 * * 1-5");
  });
});

describe("slugify", () => {
  it("derives internal slugs from natural-cased names", () => {
    expect(slugify("Eng On-Call")).toBe("eng-on-call");
    expect(slugify("  Deploy Gate!  ")).toBe("deploy-gate");
    expect(slugify("PR Summarizer 2.0")).toBe("pr-summarizer-2-0");
  });

  it("handles degenerate input", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("a".repeat(100)).length).toBe(60);
  });
});

describe("schema defaults", () => {
  it("capabilities default to everything off", () => {
    expect(agentCapabilitiesSchema.parse({})).toEqual({
      codeSandbox: false,
      codeExecution: false,
      pullRequestAccess: false,
      outboundWebAccess: false,
      networkAllowlist: "",
    });
  });

  it("preferences default to session + concise", () => {
    expect(userPreferencesSchema.parse({})).toEqual({
      approvalPosture: "session",
      responseStyle: "concise",
      suggestNextSteps: true,
      inlineToolCalls: true,
      notifyOnBackground: false,
    });
  });

  it("preferences accept legacy stored values", () => {
    const prefs = userPreferencesSchema.parse({
      approvalPosture: "auto",
      responseStyle: "balanced",
    });
    expect(prefs.approvalPosture).toBe("trust");
    expect(prefs.responseStyle).toBe("concise");
  });
});

describe("wire contracts", () => {
  it("grant requests validate subject and right enums", () => {
    expect(() =>
      createGrantSchema.parse({
        subjectType: "group",
        subjectId: "11111111-1111-4111-8111-111111111111",
        accessRight: "use",
        targetType: "agent",
        targetId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow();
  });

  it("tool calls accept approval outcomes and stream events discriminate", () => {
    const toolCall = toolCallSchema.parse({
      id: "t1",
      name: "create_issue",
      serverName: "GitHub",
      input: { title: "x" },
      output: "ok",
      authType: "user",
      approval: { status: "approved", decidedByName: "Alex" },
    });
    const event = streamEventSchema.parse({ type: "tool-end", toolCall });
    expect(event.type).toBe("tool-end");
    expect(() => streamEventSchema.parse({ type: "bogus" })).toThrow();
  });
});
