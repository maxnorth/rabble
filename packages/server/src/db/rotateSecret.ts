/**
 * Re-encrypt every stored credential under the CURRENT encryption secret.
 *
 * Use when rotating ENCRYPTION_SECRET (or when splitting it off a shared
 * COOKIE_SECRET): set the NEW secret in the environment, pass the OLD one
 * as OLD_ENCRYPTION_SECRET, and run:
 *
 *   OLD_ENCRYPTION_SECRET=<old> pnpm --filter @rabblehq/server rotate:secret
 *
 * Idempotent per run: values that already decrypt under the current secret
 * are left untouched; values that decrypt under neither are reported and
 * skipped (never destroyed).
 */
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, pool } from "./client.js";
import {
  connections,
  mcpServers,
  models,
  providerKeys,
  userConnectedAccounts,
} from "./schema.js";
import { decryptSecret, deriveEncryptionKey, encryptSecret } from "../crypto.js";

interface Target {
  table: string;
  rows: () => Promise<Array<{ id: string; value: string | null; column: string }>>;
  update: (id: string, column: string, value: string) => Promise<void>;
}

export async function rotateSecret(oldSecret: string): Promise<{
  rotated: number;
  alreadyCurrent: number;
  unreadable: number;
}> {
  const oldKey = deriveEncryptionKey(oldSecret);
  const stats = { rotated: 0, alreadyCurrent: 0, unreadable: 0 };

  const targets: Target[] = [
    {
      table: "models.encrypted_key",
      rows: async () =>
        (await db.select().from(models)).map((r) => ({
          id: r.id,
          value: r.encryptedKey,
          column: "encryptedKey",
        })),
      update: async (id, _c, value) =>
        void (await db.update(models).set({ encryptedKey: value }).where(eq(models.id, id))),
    },
    {
      table: "provider_keys.encrypted_key",
      rows: async () =>
        (await db.select().from(providerKeys)).map((r) => ({
          id: r.id,
          value: r.encryptedKey,
          column: "encryptedKey",
        })),
      update: async (id, _c, value) =>
        void (await db
          .update(providerKeys)
          .set({ encryptedKey: value })
          .where(eq(providerKeys.id, id))),
    },
    {
      table: "mcp_servers.encrypted_token",
      rows: async () =>
        (await db.select().from(mcpServers)).map((r) => ({
          id: r.id,
          value: r.encryptedToken,
          column: "encryptedToken",
        })),
      update: async (id, _c, value) =>
        void (await db
          .update(mcpServers)
          .set({ encryptedToken: value })
          .where(eq(mcpServers.id, id))),
    },
    {
      table: "connections.encrypted_token",
      rows: async () =>
        (await db.select().from(connections)).flatMap((r) => [
          { id: r.id, value: r.encryptedToken, column: "encryptedToken" },
          { id: r.id, value: r.encryptedSigningSecret, column: "encryptedSigningSecret" },
        ]),
      update: async (id, column, value) =>
        void (await db
          .update(connections)
          .set({ [column]: value })
          .where(eq(connections.id, id))),
    },
    {
      table: "user_connected_accounts.encrypted_token",
      rows: async () =>
        (await db.select().from(userConnectedAccounts)).map((r) => ({
          id: r.id,
          value: r.encryptedToken,
          column: "encryptedToken",
        })),
      update: async (id, _c, value) =>
        void (await db
          .update(userConnectedAccounts)
          .set({ encryptedToken: value })
          .where(eq(userConnectedAccounts.id, id))),
    },
  ];

  for (const target of targets) {
    for (const row of await target.rows()) {
      if (!row.value) continue;
      try {
        decryptSecret(row.value); // current key works — nothing to do
        stats.alreadyCurrent += 1;
        continue;
      } catch {
        /* fall through to the old key */
      }
      try {
        const plaintext = decryptSecret(row.value, oldKey);
        await target.update(row.id, row.column, encryptSecret(plaintext));
        stats.rotated += 1;
      } catch {
        console.error(`unreadable under both secrets: ${target.table} id=${row.id}`);
        stats.unreadable += 1;
      }
    }
  }
  return stats;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const oldSecret = process.env.OLD_ENCRYPTION_SECRET;
  if (!oldSecret) {
    console.error("Set OLD_ENCRYPTION_SECRET to the secret being rotated away from.");
    process.exit(1);
  }
  rotateSecret(oldSecret)
    .then(async (stats) => {
      console.log(
        `rotated ${stats.rotated}, already current ${stats.alreadyCurrent}, unreadable ${stats.unreadable}`,
      );
      await pool.end();
      process.exit(stats.unreadable > 0 ? 2 : 0);
    })
    .catch(async (err) => {
      console.error("rotation failed:", err);
      await pool.end();
      process.exit(1);
    });
}
