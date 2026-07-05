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

export async function migrate(connectionString = env.databaseUrl) {
  const client = new pg.Client({ connectionString });
  await client.connect();
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
      console.error(err);
      process.exit(1);
    });
}
