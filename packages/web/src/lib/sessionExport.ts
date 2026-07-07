/**
 * Render a session as a Markdown record: the transcript with each turn's
 * tool calls (auth type + approval outcome), then the eval verdicts — how
 * the session graded is half the record on a platform built around measured
 * behavior. Pure so the formatting is testable; the caller passes the
 * export timestamp (kept out so tests are deterministic).
 */
export interface ExportSession {
  title: string;
  agentName: string;
  surface: string;
}
export interface ExportMessage {
  role: string;
  content: string;
  toolCalls: Array<{
    name: string;
    authType?: string | null;
    approval?: { status: string } | null;
  }>;
}
export interface ExportEval {
  passed: boolean;
  criterionName: string;
  reasoning: string;
}

export function sessionToMarkdown(
  session: ExportSession,
  messages: ExportMessage[],
  evalResults: ExportEval[],
  exportedAt: string,
): string {
  const passedCount = evalResults.filter((r) => r.passed).length;
  const lines = [
    `# ${session.title || "Session"}`,
    "",
    `Agent: ${session.agentName} · Surface: ${session.surface} · Exported ${exportedAt}`,
    "",
    ...messages.flatMap((m) => [
      `## ${m.role === "user" ? "User" : session.agentName}`,
      ...m.toolCalls.map(
        (tc) =>
          `> tool: \`${tc.name}\` (${tc.authType ?? "service"} auth${
            tc.approval ? `, ${tc.approval.status}` : ""
          })`,
      ),
      m.content,
      "",
    ]),
    ...(evalResults.length > 0
      ? [
          `## Evals — ${passedCount}/${evalResults.length} criteria passed`,
          "",
          ...evalResults.map(
            (r) => `- **${r.passed ? "PASS" : "FAIL"}** ${r.criterionName}: ${r.reasoning}`,
          ),
          "",
        ]
      : []),
  ];
  return lines.join("\n");
}

/** File-safe slug for the downloaded .md name. */
export function exportFilename(title: string): string {
  return `${(title || "session").replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}.md`;
}
