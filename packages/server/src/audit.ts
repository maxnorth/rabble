/**
 * Control-plane audit log. Every mutation of platform state (agents, grants,
 * teams, domains, models, keys, connections, settings) records an event.
 * Deliberately NOT a session log — transcripts live on sessions.
 */
import { db } from "./db/client.js";
import { auditEvents } from "./db/schema.js";

export async function recordAudit(input: {
  orgId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      summary: input.summary,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    // Audit must never take down the mutation it describes.
    console.error("audit write failed", err);
  }
}

export const AUDIT_CSV_HEADER =
  "timestamp,actor,action,target_type,target_id,summary,metadata";

export interface AuditCsvRow {
  actorName: string | null;
  event: {
    createdAt: Date;
    action: string;
    targetType: string;
    targetId: string | null;
    summary: string;
    metadata: unknown;
  };
}

/**
 * CSV-quote one cell: always wrap in quotes (so commas/newlines/quotes in a
 * summary can't break row structure), double any embedded quote, and prefix a
 * leading formula character (= + - @) with an apostrophe so an audit export
 * opened in a spreadsheet can't be turned into a running formula (CSV
 * injection). The apostrophe is the OWASP-recommended, reversible mitigation.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/**
 * Serialize audit rows to CSV. Every column is quoted uniformly — the inline
 * version only escaped the free-text columns, leaving action/target unquoted
 * on the assumption they never contain a delimiter. Kept pure so the escaping
 * is unit-tested rather than only exercised through the export route.
 */
export function toAuditCsv(rows: AuditCsvRow[]): string {
  return [
    AUDIT_CSV_HEADER,
    ...rows.map((r) => {
      const meta = r.event.metadata as Record<string, unknown> | null;
      return [
        r.event.createdAt.toISOString(),
        r.actorName ?? "system",
        r.event.action,
        r.event.targetType,
        r.event.targetId ?? "",
        r.event.summary,
        meta && Object.keys(meta).length ? JSON.stringify(meta) : "",
      ]
        .map(csvCell)
        .join(",");
    }),
  ].join("\n");
}
