import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  delegableChildIds,
  subAgentToolName,
} from "./agentTurn.js";
import type { agents } from "../db/schema.js";

const baseAgent = {
  name: "Eng On-Call",
  description: "CI triage and deploy questions",
  instructions: "Prefer runbook links over speculation.",
  tone: "Concise. Surface options before any write action.",
} as typeof agents.$inferSelect;

describe("buildSystemPrompt", () => {
  it("folds identity, role, instructions, and tone into the prompt", () => {
    const prompt = buildSystemPrompt(baseAgent, {
      responseStyle: "concise",
      suggestNextSteps: true,
    });
    expect(prompt).toContain("You are Eng On-Call");
    expect(prompt).toContain("Your role: CI triage and deploy questions");
    expect(prompt).toContain("Prefer runbook links over speculation.");
    expect(prompt).toContain("Tone & style: Concise.");
    expect(prompt).toContain("concise, direct replies");
  });

  it("honors the detailed response style", () => {
    const prompt = buildSystemPrompt(baseAgent, {
      responseStyle: "detailed",
      suggestNextSteps: true,
    });
    expect(prompt).toContain("detailed replies with full reasoning");
    expect(prompt).not.toContain("concise, direct replies");
  });

  it("suppresses follow-up suggestions when the user opted out", () => {
    const prompt = buildSystemPrompt(baseAgent, {
      responseStyle: "concise",
      suggestNextSteps: false,
    });
    expect(prompt).toContain("Do not propose follow-up actions");
  });

  it("omits empty sections instead of leaving stubs", () => {
    const prompt = buildSystemPrompt(
      { ...baseAgent, description: "", instructions: "", tone: "" },
      { responseStyle: "concise", suggestNextSteps: true },
    );
    expect(prompt).not.toContain("Your role:");
    expect(prompt).not.toContain("Tone & style:");
  });
});

describe("subAgentToolName", () => {
  it("prefixes and sanitizes a slug into a valid tool name", () => {
    expect(subAgentToolName("docs-helper")).toBe("ask_docs_helper");
    expect(subAgentToolName("release.notes bot")).toBe("ask_release_notes_bot");
  });
  it("caps length so a long slug can't blow the tool-name limit", () => {
    expect(subAgentToolName("a".repeat(200)).length).toBe(64);
  });
});

describe("delegableChildIds", () => {
  it("offers every linked child at the top level", () => {
    expect(delegableChildIds(["a", "b"], [])).toEqual(["a", "b"]);
  });
  it("drops a child already on the call stack (cycle guard)", () => {
    // Parent p delegated to a, which links back to p and also to c.
    expect(delegableChildIds(["p", "c"], ["p"])).toEqual(["c"]);
  });
  it("offers nothing once the depth cap is reached", () => {
    expect(delegableChildIds(["x"], ["r", "s", "t"], 3)).toEqual([]);
    expect(delegableChildIds(["x"], ["r", "s"], 3)).toEqual(["x"]);
  });
});
