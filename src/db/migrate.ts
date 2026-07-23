import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db, client } from "./index";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";

/**
 * Idempotent column-add migrations.
 *
 * Dual strategy (intentional):
 * 1. Journaled SQL under drizzle/ — applied once via drizzle-orm migrator.
 * 2. This list — ADD COLUMN if missing, safe on every boot for deploys that
 *    already had the column via (1) or an older path.
 *
 * Do not remove journal entries. Append-only here. Prefer a journaled SQL file
 * for new columns when possible, and keep a matching idempotent entry for
 * partial deploys.
 */
const IDEMPOTENT_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // 2026-06-13 — compression_stats (token-saver telemetry, see src/proxy/compression/)
  { table: "request_logs", column: "compression_stats", ddl: "ALTER TABLE request_logs ADD COLUMN compression_stats TEXT" },
  // 2026-06-14 — Qoder Free counter (mirrors /activity qmodel_latest promo).
  // Decremented per-request when the model maps to qmodel_latest. Synced (and
  // overridden) from Qoder by warmup. See src/auth/warmup-runner.ts.
  { table: "accounts", column: "free_limit",     ddl: "ALTER TABLE accounts ADD COLUMN free_limit REAL DEFAULT 0" },
  { table: "accounts", column: "free_remaining", ddl: "ALTER TABLE accounts ADD COLUMN free_remaining REAL DEFAULT 0" },
  { table: "accounts", column: "free_reset_at",  ddl: "ALTER TABLE accounts ADD COLUMN free_reset_at INTEGER" },
  // 2026-07-06 — request detail storage (compressed body + per-technique savings)
  { table: "request_logs", column: "compressed_request_body", ddl: "ALTER TABLE request_logs ADD COLUMN compressed_request_body TEXT" },
  { table: "request_logs", column: "savings_by_technique",    ddl: "ALTER TABLE request_logs ADD COLUMN savings_by_technique TEXT" },
  // 2026-07-07 — sticky response-id pinning (previous_response_id → account)
  { table: "request_logs", column: "response_id", ddl: "ALTER TABLE request_logs ADD COLUMN response_id TEXT" },
  // 2026-07-09 — sticky round-robin persisted pick counter
  { table: "accounts", column: "consecutive_use_count", ddl: "ALTER TABLE accounts ADD COLUMN consecutive_use_count INTEGER NOT NULL DEFAULT 0" },
  // 2026-07-18 — friend-key limits (model allowlist, token quota, rate cap, expiry).
  { table: "api_keys", column: "allowed_models", ddl: "ALTER TABLE api_keys ADD COLUMN allowed_models TEXT" },
  { table: "api_keys", column: "token_quota",    ddl: "ALTER TABLE api_keys ADD COLUMN token_quota INTEGER" },
  { table: "api_keys", column: "tokens_used",    ddl: "ALTER TABLE api_keys ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0" },
  { table: "api_keys", column: "rate_limit",     ddl: "ALTER TABLE api_keys ADD COLUMN rate_limit INTEGER" },
  { table: "api_keys", column: "expires_at",     ddl: "ALTER TABLE api_keys ADD COLUMN expires_at INTEGER" },
  // 2026-07-19 — stream time-to-first-token for share board speed stats
  { table: "request_logs", column: "ttft_ms", ddl: "ALTER TABLE request_logs ADD COLUMN ttft_ms INTEGER" },
];

function tableHasColumn(table: string, column: string): boolean {
  try {
    const rows = client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function runIdempotentColumns() {
  for (const m of IDEMPOTENT_COLUMNS) {
    if (tableHasColumn(m.table, m.column)) continue;
    try {
      await db.run(sql.raw(m.ddl));
      console.log(`[DB] Added column ${m.table}.${m.column}`);
    } catch (err) {
      // Re-check: another process may have added it concurrently.
      if (!tableHasColumn(m.table, m.column)) {
        console.error(`[DB] Failed to add ${m.table}.${m.column}:`, err);
      }
    }
  }
}

export async function runMigrations() {
  const migrationsFolder = "./drizzle";

  // Only run file-based migrations if the folder exists.
  // CI runs `drizzle-kit push` before tests, which creates tables without
  // writing the drizzle journal. Re-running 0000 CREATE TABLE then fails with
  // "table already exists". Treat that as "schema already present" and continue
  // with the idempotent column/table steps below — never leave tests half-boot.
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    console.log("[DB] Running migrations...");
    try {
      await migrate(db, { migrationsFolder });
      console.log("[DB] Migrations complete.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err && typeof err === "object" && "cause" in err
        ? String((err as { cause?: unknown }).cause ?? "")
        : "";
      const combined = `${msg}\n${cause}`;
      if (/already exists/i.test(combined)) {
        console.warn(
          "[DB] Journaled migrations skipped — schema already present " +
            "(e.g. drizzle-kit push without journal). Continuing with idempotent steps.",
        );
      } else {
        throw err;
      }
    }
  } else {
    console.log("[DB] No migrations found, skipping. Use 'bun run db:push' to sync schema.");
  }

  // Always run idempotent column-add migrations (works on fresh deploys without drizzle/).
  await runIdempotentColumns();

  // ensure the provider_nodes table exists (dynamic compatible-node providers).
  try {
    await db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS provider_nodes (
        id text PRIMARY KEY NOT NULL,
        type text NOT NULL,
        name text NOT NULL,
        data text NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `));
  } catch (err) {
    console.error("[DB] provider_nodes table creation skipped:", err);
  }

  // 2026-07-20 — friend-key tripwire: banned IPs + security audit trail.
  try {
    await db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS ip_bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `));
    await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS ip_bans_expires_idx ON ip_bans (expires_at)`));
    await db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        ip TEXT,
        surface TEXT NOT NULL,
        path TEXT,
        key_preview TEXT,
        action TEXT NOT NULL,
        detail TEXT
      )
    `));
    await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at)`));
  } catch (err) {
    console.error("[DB] ip_bans/security_events table creation skipped:", err);
  }

  // 2026-07-11 — encrypt legacy plaintext VCC card rows at rest (AES-256-GCM).
  // Skips rows already encrypted. PCI DSS Req 3.4. Safe & idempotent.
  try {
    const { migrateVccEncryption } = await import("../api/vcc");
    const n = await migrateVccEncryption();
    if (n > 0) console.log(`[DB] Re-encrypted ${n} VCC card(s) at rest.`);
  } catch (err) {
    console.error("[DB] VCC encryption migration skipped:", err);
  }
}

// Run if called directly
if (import.meta.main) {
  await runMigrations();
  console.log("[DB] Database migrated successfully");
  process.exit(0);
}
