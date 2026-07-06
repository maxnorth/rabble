import pg from "pg";
import { e2eDatabaseUrl } from "../global-setup";

let pool: pg.Pool | undefined;

/** Query the e2e database directly to assert on persisted state. */
export async function dbQuery<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  pool ??= new pg.Pool({ connectionString: e2eDatabaseUrl, max: 2 });
  const result = await pool.query<T>(text, params);
  return result.rows;
}

/** Poll until the agent message matching `contentLike` is persisted with
 *  tool calls, then return the first tool call. Streams render before the
 *  insert commits, so UI-then-DB assertions must wait. */
export async function pollFirstToolCall(
  contentLike: string,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await dbQuery<{ tool_calls: Array<Record<string, unknown>> }>(
      `SELECT tool_calls FROM messages
       WHERE role = 'agent' AND content LIKE $1
         AND jsonb_array_length(tool_calls) > 0`,
      [contentLike],
    );
    if (rows[0]?.tool_calls?.[0]) return rows[0].tool_calls[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No persisted tool call for message like: ${contentLike}`);
}
