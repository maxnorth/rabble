import { describe, expect, it } from "vitest";
import {
  agentCapabilitiesSchema,
  createGrantSchema,
  slugify,
  streamEventSchema,
  toolCallSchema,
  userPreferencesSchema,
} from "./index.js";

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

  it("preferences default to ask + balanced", () => {
    expect(userPreferencesSchema.parse({})).toEqual({
      approvalPosture: "ask",
      responseStyle: "balanced",
    });
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
