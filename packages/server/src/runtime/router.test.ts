import { describe, expect, it } from "vitest";
import {
  buildRouterPrompt,
  matchAgentReply,
  orderAutoRoster,
  type RouteCandidate,
} from "./router.js";

const candidates: RouteCandidate[] = [
  { id: "1", slug: "eng-on-call", name: "Eng On-Call", description: "CI triage" },
  { id: "2", slug: "hr-assist", name: "HR Assist", description: "People questions" },
  { id: "3", slug: "deploy-gate", name: "Deploy Gate", description: "Rollouts" },
];

describe("matchAgentReply", () => {
  it("matches a bare slug", () => {
    expect(matchAgentReply("eng-on-call", candidates)?.id).toBe("1");
  });

  it("matches a slug embedded in prose and punctuation", () => {
    expect(matchAgentReply("The best fit is `hr-assist`.", candidates)?.id).toBe("2");
  });

  it("does not match a slug inside a longer hyphenated token", () => {
    expect(
      matchAgentReply("try eng-on-call-backup", candidates.slice(0, 1)),
    ).toBeNull();
  });

  it("falls back to display-name matching", () => {
    expect(matchAgentReply("I'd pick Deploy Gate for this.", candidates)?.id).toBe("3");
  });

  it("returns null when nothing matches", () => {
    expect(matchAgentReply("no idea", candidates)).toBeNull();
  });

  it("prefers slug matches over earlier name mentions", () => {
    expect(
      matchAgentReply("Not HR Assist — route to deploy-gate", candidates)?.id,
    ).toBe("3");
  });
});

describe("buildRouterPrompt", () => {
  it("lists every candidate with slug, name, and description", () => {
    const prompt = buildRouterPrompt("prod is down", candidates);
    expect(prompt).toContain("prod is down");
    for (const c of candidates) {
      expect(prompt).toContain(c.slug);
      expect(prompt).toContain(c.description);
    }
    expect(prompt).toMatch(/exactly one agent slug/);
  });

  it("truncates very long intents", () => {
    const prompt = buildRouterPrompt("x".repeat(5000), candidates);
    expect(prompt.length).toBeLessThan(4000);
  });
});

describe("orderAutoRoster", () => {
  const rows = [
    { slug: "builder", builtin: "builder" as string | null },
    { slug: "email-reader", builtin: null as string | null },
    { slug: "deploy-gate", builtin: null as string | null },
  ];

  it("keeps regular agents first (the no-intent fallback) and the Builder last", () => {
    expect(orderAutoRoster(rows).map((r) => r.slug)).toEqual([
      "email-reader",
      "deploy-gate",
      "builder",
    ]);
  });

  it("with only the Builder usable, the Builder still answers", () => {
    expect(orderAutoRoster([rows[0]!]).map((r) => r.slug)).toEqual(["builder"]);
  });
});

describe("router system guidance", () => {
  it("the prompt tells the model build/configure requests belong to the builder", () => {
    // The instruction lives in the system message, exercised via routeByIntent;
    // pin the roster line format here so the builder is identifiable by slug.
    const prompt = buildRouterPrompt("build me an agent for standups", [
      { id: "1", slug: "builder", name: "Builder", description: "Creates and configures agents conversationally." },
      { id: "2", slug: "email-reader", name: "Email Reader", description: "Reads email." },
    ]);
    expect(prompt).toContain("builder — Builder");
    expect(prompt).toContain("Creates and configures agents");
  });
});
