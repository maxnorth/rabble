/**
 * Minimal forward-only migration runner: applies the .sql files in
 * ./migrations in filename order, recording each in _migrations.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../env.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const CONNECT_RETRY_MS = 30_000;

/** Postgres may still be starting (fresh `docker compose up`) — retry. */
async function connectWithRetry(connectionString: string): Promise<pg.Client> {
  const deadline = Date.now() + CONNECT_RETRY_MS;
  for (;;) {
    const client = new pg.Client({
      connectionString,
      ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      const code = (err as { code?: string }).code;
      const retryable =
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "57P03" || // cannot_connect_now: server is starting up
        /starting up|Connection terminated/i.test(String(err));
      if (!retryable || Date.now() >= deadline) throw err;
      console.log("waiting for Postgres…");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

export async function migrate(connectionString = env.databaseUrl) {
  const client = await connectWithRetry(connectionString);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await client.query("SELECT name FROM _migrations")).rows.map(
        (r: { name: string }) => r.name,
      ),
    );
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => {
      console.log("migrations up to date");
      process.exit(0);
    })
    .catch((err) => {
      console.error("migration failed:", err instanceof Error ? err.message : err);
      const code = (err as { code?: string }).code;
      if (code === "ECONNREFUSED") {
        console.error(
          "Postgres isn't reachable. Start it first: docker compose up -d --wait postgres\n" +
            `(connection string: ${env.databaseUrl.replace(/:[^:@/]+@/, ":***@")})`,
        );
      } else if (code === "28000" || code === "3D000") {
        console.error(
          "Connected to a Postgres server, but the role/database doesn't exist.\n" +
            "You may be talking to a different Postgres than the compose container\n" +
            "(e.g. Homebrew on the same port). Rabble's container listens on\n" +
            "localhost:55432 — check DATABASE_URL in your .env, then:\n" +
            "  docker compose up -d --wait postgres && mise run migrate",
        );
      }
      console.error(err);
      process.exit(1);
    });
}
