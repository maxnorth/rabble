import { describe, expect, it } from "vitest";
import {
  agentCapabilitiesSchema,
  createAutomationSchema,
  createGrantSchema,
  isValidCron,
  slugify,
  streamEventSchema,
  toolCallSchema,
  userPreferencesSchema,
} from "./index.js";

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
