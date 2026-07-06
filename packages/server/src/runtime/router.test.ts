import { describe, expect, it } from "vitest";
import { buildRouterPrompt, matchAgentReply, type RouteCandidate } from "./router.js";

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
