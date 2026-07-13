#!/usr/bin/env bun
/**
 * One-shot: shrink request_logs + reclaim disk (for existing multi-GB DBs).
 *
 *   bun scripts/prune-request-logs.ts
 *   bun scripts/prune-request-logs.ts --keep 200
 *   bun scripts/prune-request-logs.ts --vacuum-only
 *
 * Prefer stopping the server first on Windows if VACUUM fails with "database is locked":
 *   etteum stop
 *   bun scripts/prune-request-logs.ts
 *   etteum start
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const envPath = path.join(root, ".env");
if (existsSync(envPath)) {
  for (const line of (await Bun.file(envPath).text()).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

const dbRel = process.env.DATABASE_PATH || "./data/poolprox3.db";
const dbPath = path.isAbsolute(dbRel) ? dbRel : path.join(root, dbRel);
const keepArg = process.argv.find((a) => a.startsWith("--keep="));
const keep = keepArg
  ? Math.max(0, Number(keepArg.split("=")[1]) || 500)
  : Number(process.env.POOLPROX_MAX_REQUEST_LOGS) || 500;
const vacuumOnly = process.argv.includes("--vacuum-only");

if (!existsSync(dbPath)) {
  console.error("DB not found:", dbPath);
  process.exit(1);
}

const before = statSync(dbPath).size;
console.log("DB:", dbPath);
console.log("Size before:", (before / 1024 / 1024).toFixed(1), "MB");

const db = new Database(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 60000;");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  if (!vacuumOnly) {
    const nBefore = (db.query("SELECT COUNT(*) AS n FROM request_logs").get() as { n: number }).n;
    console.log("request_logs rows before:", nBefore);
    db.run(`
      DELETE FROM request_logs WHERE id NOT IN (
        SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ${keep}
      )
    `);
    db.run(`
      UPDATE request_logs
      SET request_body = NULL,
          response_body = NULL,
          compressed_request_body = NULL
      WHERE request_body IS NOT NULL
         OR response_body IS NOT NULL
         OR compressed_request_body IS NOT NULL
    `);
    const nAfter = (db.query("SELECT COUNT(*) AS n FROM request_logs").get() as { n: number }).n;
    console.log("request_logs rows after:", nAfter, `(kept ${keep})`);
  }
  // VACUUM INTO a new file is more reliable than in-place VACUUM when the DB
  // is multi-GB or another process briefly touched WAL.
  const compactPath = dbPath + ".compact";
  console.log("VACUUM INTO compact file… (may take a while on large files)");
  const escaped = compactPath.replace(/\\/g, "/").replace(/'/g, "''");
  db.run(`VACUUM INTO '${escaped}'`);
  db.close();

  // Replace main DB with compact copy
  const { renameSync, unlinkSync, copyFileSync, existsSync: ex } = await import("node:fs");
  const bak = dbPath + ".pre-prune.bak";
  try {
    if (ex(bak)) unlinkSync(bak);
  } catch {
    /* ignore */
  }
  try {
    renameSync(dbPath, bak);
  } catch {
    copyFileSync(dbPath, bak);
  }
  try {
    renameSync(compactPath, dbPath);
  } catch {
    copyFileSync(compactPath, dbPath);
    try {
      unlinkSync(compactPath);
    } catch {
      /* ignore */
    }
  }
  // Drop WAL/SHM so we don't reopen old free pages
  for (const s of ["-wal", "-shm"]) {
    try {
      if (ex(dbPath + s)) unlinkSync(dbPath + s);
    } catch {
      /* ignore */
    }
  }
  console.log("Previous file kept as:", bak, "(delete manually when happy)");
} catch (e) {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  console.error("Prune failed:", e instanceof Error ? e.message : e);
  console.error("Stop the server first:  etteum stop");
  process.exit(1);
}

const after = statSync(dbPath).size;
console.log("Size after:", (after / 1024 / 1024).toFixed(1), "MB");
console.log(
  "Freed:",
  ((before - after) / 1024 / 1024).toFixed(1),
  "MB",
);
console.log("Done. Restart the server if it was stopped.");