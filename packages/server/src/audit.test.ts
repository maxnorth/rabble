import { describe, expect, it } from "vitest";
import { AUDIT_CSV_HEADER, toAuditCsv, type AuditCsvRow } from "./audit.js";

const row = (o: Partial<AuditCsvRow["event"]> & { actorName?: string | null }): AuditCsvRow => ({
  actorName: "actorName" in o ? (o.actorName ?? null) : "Alex Lin",
  event: {
    createdAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    action: "agent.update",
    targetType: "agent",
    targetId: "abc-123",
    summary: "Updated the agent",
    metadata: {},
    ...o,
  },
});

describe("toAuditCsv", () => {
  it("emits the header and one quoted row per event", () => {
    const csv = toAuditCsv([row({})]);
    const [header, line] = csv.split("\n");
    expect(header).toBe(AUDIT_CSV_HEADER);
    expect(line).toBe(
      '"2026-01-02T03:04:05.000Z","Alex Lin","agent.update","agent","abc-123","Updated the agent",""',
    );
  });

  it("quotes every column so a comma or newline can't break structure", () => {
    const csv = toAuditCsv([
      row({ summary: "Renamed to A, B\nand C", actorName: 'Say "hi"' }),
    ]);
    const line = csv.split("\n").slice(1).join("\n");
    // Embedded quotes doubled, comma/newline stay inside the quoted cell.
    expect(line).toContain('"Say ""hi"""');
    expect(line).toContain('"Renamed to A, B\nand C"');
  });

  it("serializes metadata as JSON, empty string when there is none", () => {
    const withMeta = toAuditCsv([row({ metadata: { failures: ["x"] } })]);
    expect(withMeta).toContain('"{""failures"":[""x""]}"');
    const noMeta = toAuditCsv([row({ metadata: null })]);
    expect(noMeta.split("\n")[1]!.endsWith('""')).toBe(true);
  });

  it("neutralizes a leading formula character (CSV injection)", () => {
    const csv = toAuditCsv([row({ summary: "=1+2", actorName: "@ops" })]);
    const line = csv.split("\n")[1]!;
    expect(line).toContain('"\'=1+2"');
    expect(line).toContain('"\'@ops"');
  });

  it("falls back to 'system' for an actorless event", () => {
    const csv = toAuditCsv([row({ actorName: null })]);
    expect(csv.split("\n")[1]).toContain('"system"');
  });
});
