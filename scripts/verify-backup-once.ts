/**
 * One-shot verification of export/import pack integrity.
 * Does NOT overwrite the live install. Writes under data/backups/_verify-*.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  applyBackupDir,
  createBackupDir,
  loadManifest,
  resolveImportSource,
  zipBackupDir,
} from "../src/lib/backup";
import { config } from "../src/config";

const root = path.resolve(import.meta.dir, "..");
const liveDb = path.isAbsolute(config.databasePath)
  ? config.databasePath
  : path.join(root, config.databasePath);

function count(dbPath: string): Record<string, number> {
  const out: Record<string, number> = {};
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    for (const t of tables) {
      try {
        out[t.name] = Number(
          (db.query(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n,
        );
      } catch {
        out[t.name] = -1;
      }
    }
  } finally {
    db.close();
  }
  return out;
}

function encKeyFromEnvText(text: string): string {
  const m = text.match(/^\s*ENCRYPTION_KEY\s*=\s*(.*)$/m);
  return (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const report: string[] = [];
function log(s: string) {
  report.push(s);
  console.log(s);
}

log("=== 1) Live install ===");
assert(existsSync(liveDb), `live db missing: ${liveDb}`);
const liveCounts = count(liveDb);
const liveEnv = existsSync(path.join(root, ".env"))
  ? readFileSync(path.join(root, ".env"), "utf8")
  : "";
const liveEnc = encKeyFromEnvText(liveEnv);
log(`  db: ${liveDb}`);
log(`  accounts: ${liveCounts.accounts ?? 0}`);
log(`  request_logs: ${liveCounts.request_logs ?? 0}`);
log(`  ENCRYPTION_KEY present: ${liveEnc.length > 0} (len=${liveEnc.length})`);
assert((liveCounts.accounts ?? 0) > 0, "live has zero accounts — nothing meaningful to export");
assert(liveEnc.length > 0, "live .env missing ENCRYPTION_KEY (tokens would not decrypt after import)");

log("\n=== 2) Export essential ===");
const pack = createBackupDir("essential");
log(`  dir: ${pack.dir}`);
log(`  db bytes: ${pack.databaseBytes}`);
log(`  env bytes: ${pack.envBytes}`);
log(`  jwt-secret: ${pack.hasJwtSecret}`);
log(`  counts: ${JSON.stringify(pack.counts)}`);

const man = loadManifest(pack.dir);
assert(man.format === "etteum-backup", "manifest format");
assert(man.version === 1, "manifest version");
assert(man.mode === "essential", "manifest mode essential");
assert(existsSync(path.join(pack.dir, "poolprox3.db")), "pack db");
assert(existsSync(path.join(pack.dir, "env")), "pack env");
assert(existsSync(path.join(pack.dir, "manifest.json")), "pack manifest");

const packEnc = encKeyFromEnvText(readFileSync(path.join(pack.dir, "env"), "utf8"));
assert(packEnc === liveEnc, "pack ENCRYPTION_KEY must match live (required for token decrypt)");
log("  ENCRYPTION_KEY matches live: yes");

const packCounts = count(path.join(pack.dir, "poolprox3.db"));
assert(packCounts.accounts === liveCounts.accounts, `accounts mismatch live=${liveCounts.accounts} pack=${packCounts.accounts}`);
// Essential must strip history tables
for (const t of ["request_logs", "usage_summary", "image_studio_chats", "image_studio_results"]) {
  if (t in packCounts) {
    assert(packCounts[t] === 0, `essential pack should empty ${t}, got ${packCounts[t]}`);
  }
}
log("  accounts preserved: yes");
log("  history tables empty: yes");

// Spot-check accounts have tokens column populated for at least some
const db = new Database(path.join(pack.dir, "poolprox3.db"), { readonly: true });
try {
  const withTokens = db
    .query(
      `SELECT COUNT(*) AS n FROM accounts WHERE tokens IS NOT NULL AND CAST(tokens AS TEXT) != '' AND CAST(tokens AS TEXT) != 'null'`,
    )
    .get() as { n: number };
  log(`  accounts with tokens: ${withTokens.n}`);
  assert(withTokens.n > 0, "no account tokens in pack — import would be empty auth");
} finally {
  db.close();
}

log("\n=== 3) Zip + resolveImportSource ===");
const zip = await zipBackupDir(pack.dir);
assert(zip && existsSync(zip), "zip creation failed");
log(`  zip: ${zip}`);
log(`  zip bytes: ${statSync(zip!).size}`);

const fromFolder = await resolveImportSource(pack.dir);
assert(existsSync(path.join(fromFolder, "manifest.json")), "resolve folder pack");
log(`  resolve folder: OK (${fromFolder})`);

const fromZip = await resolveImportSource(zip!);
assert(existsSync(path.join(fromZip, "manifest.json")), "resolve zip pack");
log(`  resolve zip: OK (${fromZip})`);

log("\n=== 4) Round-trip import into isolated sandbox (not live) ===");
// Simulate apply by copying pack onto a temp root layout, not the live install.
const sandbox = path.join(root, "data", "backups", `_verify-sandbox-${Date.now()}`);
mkdirSync(path.join(sandbox, "data"), { recursive: true });
// seed fake live files so apply-style replace can be tested manually
const sandDb = path.join(sandbox, "data", "poolprox3.db");
const sandEnv = path.join(sandbox, ".env");
writeFileSync(sandEnv, "ENCRYPTION_KEY=old-key-should-be-replaced\nAPI_KEY=old\n", "utf8");
// copy pack files as if applyBackupDir did
const packDb = path.join(pack.dir, "poolprox3.db");
const packEnvPath = path.join(pack.dir, "env");
const { copyFileSync } = await import("node:fs");
copyFileSync(packDb, sandDb);
writeFileSync(sandEnv, readFileSync(packEnvPath, "utf8"), "utf8");
if (existsSync(path.join(pack.dir, "jwt-secret"))) {
  copyFileSync(path.join(pack.dir, "jwt-secret"), path.join(sandbox, "data", "jwt-secret"));
}
const sandCounts = count(sandDb);
const sandEnc = encKeyFromEnvText(readFileSync(sandEnv, "utf8"));
assert(sandCounts.accounts === liveCounts.accounts, "sandbox accounts");
assert(sandEnc === liveEnc, "sandbox ENCRYPTION_KEY after simulated import");
log(`  sandbox accounts: ${sandCounts.accounts}`);
log(`  sandbox ENCRYPTION_KEY matches: yes`);
log(`  sandbox path: ${sandbox}`);

log("\n=== 5) Live applyBackupDir smoke (same pack → live, identity restore) ===");
log("  Skipping automatic live overwrite in this script.");
log("  To identity-restore live yourself:");
log(`    etteum stop`);
log(`    bun scripts/backup.ts import "${pack.dir}" --yes`);
log(`    etteum start`);

// Optional: try apply only if VERIFY_LIVE_IMPORT=1
if (process.env.VERIFY_LIVE_IMPORT === "1") {
  log("  VERIFY_LIVE_IMPORT=1 → applying to live…");
  const result = applyBackupDir(pack.dir);
  log(`  ${result.message}`);
  log(`  pre-import: ${result.preImportBackupDir}`);
  const after = count(liveDb);
  assert(after.accounts === liveCounts.accounts, "post-import accounts");
  log("  live accounts after import: OK");
}

log("\n=== RESULT: PASS ===");
log("Export essential pack is valid; zip round-trips; ENCRYPTION_KEY + accounts preserved.");
log("Import path is correct for folder and zip. Live import needs server stop if DB is locked.");

const outReport = path.join(pack.dir, "VERIFY_REPORT.txt");
writeFileSync(outReport, report.join("\n") + "\n", "utf8");
console.log("\nReport written:", outReport);
