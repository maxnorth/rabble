import { describe, expect, it } from "vitest";
import { sessionToMarkdown, exportFilename } from "./sessionExport";

const session = { title: "Why is the build red?", agentName: "Eng On-Call", surface: "Web" };

describe("sessionToMarkdown", () => {
  it("renders the header, turns, and a tool call with auth + approval", () => {
    const md = sessionToMarkdown(
      session,
      [
        { role: "user", content: "Why is the build red?", toolCalls: [] },
        {
          role: "agent",
          content: "The integration stage timed out.",
          toolCalls: [
            { name: "search_ci_runs", authType: "service", approval: null },
            { name: "create_issue", authType: "user", approval: { status: "approved" } },
          ],
        },
      ],
      [],
      "2026-07-07 10:00",
    );
    expect(md).toContain("# Why is the build red?");
    expect(md).toContain("Agent: Eng On-Call · Surface: Web · Exported 2026-07-07 10:00");
    expect(md).toContain("## User");
    expect(md).toContain("## Eng On-Call");
    expect(md).toContain("> tool: `search_ci_runs` (service auth)");
    expect(md).toContain("> tool: `create_issue` (user auth, approved)");
    expect(md).toContain("The integration stage timed out.");
    // No evals section when there are none.
    expect(md).not.toContain("## Evals");
  });

  it("defaults a missing authType to service", () => {
    const md = sessionToMarkdown(
      session,
      [{ role: "agent", content: "ok", toolCalls: [{ name: "ls" }] }],
      [],
      "t",
    );
    expect(md).toContain("> tool: `ls` (service auth)");
  });

  it("appends the eval verdicts with a pass count", () => {
    const md = sessionToMarkdown(
      session,
      [{ role: "agent", content: "done", toolCalls: [] }],
      [
        { passed: true, criterionName: "Stays on topic", reasoning: "Answered the question." },
        { passed: false, criterionName: "Cites a runbook", reasoning: "No link provided." },
      ],
      "t",
    );
    expect(md).toContain("## Evals — 1/2 criteria passed");
    expect(md).toContain("- **PASS** Stays on topic: Answered the question.");
    expect(md).toContain("- **FAIL** Cites a runbook: No link provided.");
  });

  it("keeps a failed turn in the record", () => {
    const md = sessionToMarkdown(
      session,
      [
        { role: "user", content: "Will this survive an outage?", toolCalls: [] },
        { role: "agent", content: "", error: "upstream rejected the request", toolCalls: [] },
      ],
      [],
      "t",
    );
    expect(md).toContain("> ⚠ turn failed: upstream rejected the request");
  });

  it("falls back to 'Session' for an empty title", () => {
    expect(sessionToMarkdown({ ...session, title: "" }, [], [], "t")).toContain("# Session");
  });
});

describe("exportFilename", () => {
  it("slugs the title and appends .md", () => {
    expect(exportFilename("Why is the build red?")).toBe("why-is-the-build-red-.md");
    expect(exportFilename("")).toBe("session.md");
  });
});
