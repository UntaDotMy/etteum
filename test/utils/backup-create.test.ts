/**
 * Backup create-path: createBackupDir / snapshotDatabase / zipBackupDir.
 *
 * snapshotDatabase is module-private, so it is exercised through
 * createBackupDir. The live DB handle (src/db/index) opens
 * config.databasePath at import time, and config reads DATABASE_PATH at
 * import time — so DATABASE_PATH is pointed at a temp DB BEFORE the imports
 * below resolve. The real data/poolprox3.db is never touched.
 *
 * createBackupDir is always given an absolute temp outDir, so backupsRoot()
 * (repo data/backups) is never written. The repo .env is only READ (copied
 * into the temp pack), never mutated.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

// Redirect the live DB to a throwaway file before src/config + src/db/index
// (imported transitively by src/lib/backup) read DATABASE_PATH at import time.
// bun test shares one module cache per process, so when this file runs in the
// same process as another DB test, those modules may already be cached with a
// DIFFERENT databasePath. Evict them from the require cache so the dynamic
// imports below re-load them against THIS file's temp DB. This keeps the test
// isolated (fresh empty schema, exact row counts hold) regardless of grouping.
const tempRoot = mkdtempSync(path.join(tmpdir(), "backup-create-test-"));
const tempDbPath = path.join(tempRoot, "live.db");
process.env.DATABASE_PATH = tempDbPath;
const cache = (require as unknown as { cache: Record<string, unknown> }).cache;
for (const key of Object.keys(cache)) {
  if (/[\\/](src[\\/]db|src[\\/]config|src[\\/]lib[\\/]backup)/.test(key)) {
    delete cache[key];
  }
}

const {
  createBackupDir,
  zipBackupDir,
  loadManifest,
  BACKUP_FORMAT,
  BACKUP_VERSION,
} = await import("../../src/lib/backup");
const { client: liveSqlite } = await import("../../src/db/index");
const { runMigrations } = await import("../../src/db/migrate");

// Unique marker so this file's rows are distinguishable and cleanup is exact,
// no matter which underlying DB the (grouped) module cache points at.
const SEED_TAG = `backup-create-${Date.now()}`;
let baseAccounts = 0;
let baseRequestLogs = 0;
let baseUsageSummary = 0;

const ESSENTIAL_DROP_TABLES = [
  "request_logs",
  "usage_summary",
  "image_studio_chats",
  "image_studio_results",
];

function countRows(table: string): number {
  const row = liveSqlite
    .query(`SELECT COUNT(*) AS n FROM "${table}"`)
    .get() as { n: number } | null;
  return Number(row?.n ?? 0);
}

function seedLiveDb() {
  // Use the REAL schema so this file is compatible with any DB it is grouped
  // with (e.g. backup-merge), then record baselines and add tagged rows.
  runMigrations();
  baseAccounts = countRows("accounts");
  baseRequestLogs = countRows("request_logs");
  baseUsageSummary = countRows("usage_summary");
  const now = Math.floor(Date.now() / 1000);
  const ins = liveSqlite.prepare(
    "INSERT INTO accounts (provider, email, password, status, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, 0, ?, ?)",
  );
  for (const e of [`${SEED_TAG}-a@example.com`, `${SEED_TAG}-b@example.com`, `${SEED_TAG}-c@example.com`]) {
    ins.run("grok", e, "x", now, now);
  }
  liveSqlite.run(
    "INSERT INTO request_logs (provider, model, status, created_at) VALUES ('grok', ?, 'success', ?), ('grok', ?, 'success', ?)",
    [`${SEED_TAG}-1`, now, `${SEED_TAG}-2`, now],
  );
  liveSqlite.run(
    "INSERT INTO usage_summary (bucket, provider, model, total_tokens) VALUES (?, 'grok', ?, 1.5)",
    [new Date().toISOString(), `${SEED_TAG}-m`],
  );
}

function openSnapshot(dir: string): Database {
  const p = path.join(dir, "poolprox3.db");
  expect(existsSync(p)).toBe(true);
  return new Database(p, { readonly: true });
}

function rowCount(db: Database, table: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM "${table}"`)
    .get() as { n: number } | null;
  return Number(row?.n ?? -1);
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    )
    .get(table) as { name: string } | null;
  return row?.name === table;
}

beforeAll(() => {
  seedLiveDb();
});

afterAll(() => {
  // Do NOT close liveSqlite here: when this file shares a `bun test` process
  // with other test files, liveSqlite is the shared src/db/index connection.
  // Closing it would break those files with "Cannot use a closed database".
  try {
    liveSqlite.run("DELETE FROM accounts WHERE email LIKE ?", [`${SEED_TAG}-%`]);
    liveSqlite.run("DELETE FROM request_logs WHERE model LIKE ?", [`${SEED_TAG}-%`]);
    liveSqlite.run("DELETE FROM usage_summary WHERE model LIKE ?", [`${SEED_TAG}-%`]);
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("createBackupDir + snapshotDatabase", () => {
  test("essential mode: snapshot keeps accounts, empties history tables", () => {
    const outDir = path.join(tempRoot, "pack-essential");
    const summary = createBackupDir("essential", outDir);

    expect(summary.dir).toBe(outDir);
    expect(summary.mode).toBe("essential");
    expect(summary.databaseBytes).toBeGreaterThan(100);
    expect(statSync(path.join(outDir, "poolprox3.db")).size).toBe(
      summary.databaseBytes,
    );

    const snap = openSnapshot(outDir);
    try {
      // Non-history data survives (baseline + the 3 rows this file seeded).
      expect(rowCount(snap, "accounts")).toBe(baseAccounts + 3);
      // History tables exist but were emptied by essential mode.
      expect(tableExists(snap, "request_logs")).toBe(true);
      expect(rowCount(snap, "request_logs")).toBe(0);
      expect(rowCount(snap, "usage_summary")).toBe(0);
    } finally {
      snap.close();
    }

    // Counts in the summary/manifest reflect the SNAPSHOT, not the live DB.
    expect(summary.counts.accounts).toBe(baseAccounts + 3);
    expect(summary.counts.request_logs).toBe(0);
    expect(summary.counts.usage_summary).toBe(0);

    // Live DB is untouched by the snapshot's essential-mode deletes.
    expect(
      rowCount(liveSqlite as unknown as Database, "request_logs"),
    ).toBe(baseRequestLogs + 2);
  });

  test("full mode: snapshot retains history rows", () => {
    const outDir = path.join(tempRoot, "pack-full");
    const summary = createBackupDir("full", outDir);

    expect(summary.mode).toBe("full");
    const snap = openSnapshot(outDir);
    try {
      expect(rowCount(snap, "accounts")).toBe(baseAccounts + 3);
      expect(rowCount(snap, "request_logs")).toBe(baseRequestLogs + 2);
      expect(rowCount(snap, "usage_summary")).toBe(baseUsageSummary + 1);
    } finally {
      snap.close();
    }
    expect(summary.counts.request_logs).toBe(baseRequestLogs + 2);
  });

  test("pack layout: manifest.json, env file, correct manifest fields", () => {
    const outDir = path.join(tempRoot, "pack-layout");
    const summary = createBackupDir("essential", outDir);

    for (const name of ["manifest.json", "poolprox3.db", "env"]) {
      expect(existsSync(path.join(outDir, name))).toBe(true);
    }

    const manifest = JSON.parse(
      readFileSync(path.join(outDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.version).toBe(BACKUP_VERSION);
    expect(manifest.mode).toBe("essential");
    expect(typeof manifest.createdAt).toBe("string");
    expect(manifest.createdAt).toBe(summary.createdAt);

    const files = manifest.files as Record<string, string>;
    expect(files.database).toBe("poolprox3.db");
    expect(files.env).toBe("env");
    // The repo has a real data/jwt-secret; createBackupDir copies it into
    // the pack and declares it in the manifest.
    expect(summary.hasJwtSecret).toBe(true);
    expect(files.jwtSecret).toBe("jwt-secret");
    const packedSecret = path.join(outDir, "jwt-secret");
    expect(existsSync(packedSecret)).toBe(true);
    expect(readFileSync(packedSecret, "utf8")).toBe(
      readFileSync(
        path.resolve(import.meta.dir, "../../data/jwt-secret"),
        "utf8",
      ),
    );

    const meta = manifest.meta as Record<string, unknown>;
    expect(meta.databaseBytes).toBe(summary.databaseBytes);
    expect(meta.envBytes).toBe(summary.envBytes);
    expect(typeof meta.platform).toBe("string");
    const counts = meta.counts as Record<string, number>;
    expect(counts.accounts).toBe(baseAccounts + 3);

    // loadManifest round-trips what createBackupDir wrote.
    const loaded = loadManifest(outDir);
    expect(loaded.format).toBe(BACKUP_FORMAT);
    expect(loaded.mode).toBe("essential");
  });

  test("env file: copies repo .env bytes verbatim into the pack", () => {
    const outDir = path.join(tempRoot, "pack-env");
    const summary = createBackupDir("essential", outDir);

    const packed = readFileSync(path.join(outDir, "env"), "utf8");
    // The repo .env exists (read-only source); envBytes matches its length.
    const sourceEnv = readFileSync(
      path.resolve(import.meta.dir, "../../.env"),
      "utf8",
    );
    expect(packed).toBe(sourceEnv);
    expect(summary.envBytes).toBe(Buffer.byteLength(sourceEnv, "utf8"));
  });

  test("relative outDir resolves under the project root", () => {
    // Use a unique relative name and clean it up immediately; this is the one
    // path that writes inside the repo tree (by design of createBackupDir).
    const rel = `data/backups/test-rel-${Date.now()}`;
    const summary = createBackupDir("essential", rel);
    try {
      expect(path.isAbsolute(summary.dir)).toBe(true);
      // path.join normalizes to platform separators; compare normalized.
      const norm = (p: string) => p.replace(/[\\/]/g, "/");
      expect(norm(summary.dir).endsWith(norm(rel))).toBe(true);
      expect(existsSync(path.join(summary.dir, "manifest.json"))).toBe(true);
    } finally {
      rmSync(summary.dir, { recursive: true, force: true });
    }
  });

  test("snapshotDatabase error path: live DB missing -> createBackupDir throws", () => {
    // Point config's databasePath at a nonexistent file for this call only.
    // config is a live binding object, so mutate then restore.
    const { config } = require("../../src/config") as typeof import("../../src/config");
    const original = config.databasePath;
    const bogus = path.join(tempRoot, "does-not-exist.db");
    try {
      // existsSync(bogus) is false, so snapshotDatabase must throw before
      // attempting VACUUM INTO.
      (config as { databasePath: string }).databasePath = bogus;
      expect(() =>
        createBackupDir("essential", path.join(tempRoot, "pack-missing-db")),
      ).toThrow(/Database not found/);
    } finally {
      (config as { databasePath: string }).databasePath = original;
    }
  });
});

describe("zipBackupDir", () => {
  test("zips a real backup dir and returns the .zip path", async () => {
    const outDir = path.join(tempRoot, "pack-to-zip");
    createBackupDir("essential", outDir);

    const zipPath = await zipBackupDir(outDir);
    // On Windows PowerShell Compress-Archive is available; on CI unix `zip`
    // may be absent (returns null). Assert the real outcome either way.
    if (zipPath === null) {
      expect(existsSync(`${outDir}.zip`)).toBe(false);
    } else {
      expect(zipPath).toBe(`${outDir}.zip`);
      expect(existsSync(zipPath)).toBe(true);
      expect(statSync(zipPath).size).toBeGreaterThan(0);
      // A second call replaces the existing zip (unlink-then-recreate path).
      const again = await zipBackupDir(outDir);
      expect(again).toBe(zipPath);
    }
  });

  test("trailing slash on dir still yields sibling .zip path", async () => {
    const outDir = path.join(tempRoot, "pack-trailing");
    createBackupDir("essential", outDir);
    const zipPath = await zipBackupDir(outDir + path.sep);
    if (zipPath !== null) {
      expect(zipPath).toBe(`${outDir}.zip`);
    }
  });

  test("returns null for a directory that does not exist", async () => {
    const bogus = path.join(tempRoot, "no-such-dir");
    const zipPath = await zipBackupDir(bogus);
    expect(zipPath).toBeNull();
    expect(existsSync(`${bogus}.zip`)).toBe(false);
  });
});
