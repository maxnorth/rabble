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
