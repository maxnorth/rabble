import { describe, expect, it } from "vitest";
import { snapshotSystemPrompt } from "./suiteRunner.js";

describe("snapshotSystemPrompt", () => {
  const base = {
    name: "Eng On-Call",
    description: "Answers deploy questions.",
    instructions: "Be precise.",
  };

  it("includes the tone so gating a tone change actually exercises it", () => {
    const prompt = snapshotSystemPrompt({
      ...base,
      tone: "Terse. Never use exclamation marks.",
    });
    expect(prompt).toContain("Tone & style: Terse. Never use exclamation marks.");
    expect(prompt).toContain("Answers deploy questions.");
    expect(prompt).toContain("Be precise.");
  });

  it("omits the tone line entirely when there is no tone", () => {
    const prompt = snapshotSystemPrompt({ ...base, tone: null });
    expect(prompt).not.toContain("Tone & style:");
  });
});
