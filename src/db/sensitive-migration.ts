import type { Database } from "bun:sqlite";
import { encrypt, isGcm } from "../utils/crypto";

type SensitiveColumn = {
  table: "accounts" | "provider_nodes" | "kv";
  column: "tokens" | "data" | "value";
};

const SENSITIVE_COLUMNS: SensitiveColumn[] = [
  { table: "accounts", column: "tokens" },
  { table: "provider_nodes", column: "data" },
  { table: "kv", column: "value" },
];

function tableExists(sqlite: Database, table: SensitiveColumn["table"]): boolean {
  const row = sqlite
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { present: number } | null;
  return row?.present === 1;
}

/**
 * Upgrade legacy plaintext sensitive columns to the current AES-GCM envelope.
 * Static table/column names keep the raw SQL free of user-controlled input.
 */
export function migrateSensitiveColumnEncryption(sqlite: Database): number {
  let migrated = 0;
  const run = sqlite.transaction(() => {
    for (const { table, column } of SENSITIVE_COLUMNS) {
      if (!tableExists(sqlite, table)) continue;
      const rows = sqlite
        .query(`SELECT rowid AS row_id, ${column} AS stored_value FROM ${table} WHERE ${column} IS NOT NULL`)
        .all() as Array<{ row_id: number; stored_value: string }>;
      const update = sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        if (typeof row.stored_value !== "string" || isGcm(row.stored_value)) continue;
        update.run(encrypt(row.stored_value), row.row_id);
        migrated++;
      }
    }
  });
  run();
  return migrated;
}
