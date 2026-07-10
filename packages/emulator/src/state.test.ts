import { afterEach, describe, expect, it } from "vitest";
import { state, reset, nextLlmReply, seedDefaults } from "./state.js";

// The whole e2e suite leans on these scripting conventions (see CLAUDE.md);
// lock them down so a harness change can't silently rewrite test behavior.

afterEach(() => {
  state.llmQueue = [];
});

describe("nextLlmReply", () => {
  it("returns queued scripted replies in order, then falls through", () => {
    state.llmQueue.push(
      { type: "text", text: "first" },
      { type: "tool_call", toolName: "create_issue", toolArgs: { title: "x" } },
    );
    expect(nextLlmReply("hi", "hi")).toEqual({ type: "text", text: "first" });
    expect(nextLlmReply("hi", "hi")).toEqual({
      type: "tool_call",
      toolName: "create_issue",
      toolArgs: { title: "x" },
    });
    // Queue drained → default echo.
    expect(nextLlmReply("hello there", "prompt")).toEqual({
      type: "text",
      text: "Mock reply to: hello there",
    });
  });

  it("auto-passes judge prompts when nothing is scripted", () => {
    expect(
      nextLlmReply("n/a", "…Respond with exactly PASS or FAIL on the first line…"),
    ).toEqual({ type: "text", text: "PASS" });
  });

  it("a scripted reply wins even over a judge prompt", () => {
    state.llmQueue.push({ type: "text", text: "FAIL\nregressed" });
    expect(nextLlmReply("n/a", "Respond with exactly PASS or FAIL")).toEqual({
      type: "text",
      text: "FAIL\nregressed",
    });
  });
});

describe("reset / seedDefaults", () => {
  it("seeds the default MCP catalog and clears scripted state", () => {
    state.llmQueue.push({ type: "text", text: "leftover" });
    reset();
    expect(state.llmQueue).toEqual([]);
    expect(state.mcpServers.has("github")).toBe(true);
    expect(state.mcpServers.has("datadog")).toBe(true);
  });

  it("seedDefaults gives the github server its canned tools", () => {
    seedDefaults();
    const tools = state.mcpServers.get("github")!.map((t) => t.name);
    expect(tools).toContain("search_repos");
    expect(tools).toContain("create_issue");
  });
});
