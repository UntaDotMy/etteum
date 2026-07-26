import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

const DRY_RUN = !process.argv.includes("--commit");

// Load ENCRYPTION_KEY from .env (project root)
const envPath = resolve(import.meta.dir, "..", ".env");
const envText = readFileSync(envPath, "utf8");
const m = envText.match(/^ENCRYPTION_KEY=(.+)$/m);
const ENCRYPTION_KEY = (m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "") || process.env.ENCRYPTION_KEY || "";

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 16) {
  console.error("ENCRYPTION_KEY missing or too short");
  process.exit(1);
}

const crypto = await import("../src/utils/crypto.ts");
const dbPath = resolve(import.meta.dir, "..", "data", "poolprox3.db");
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 10000");

const PROVIDERS = ["byok", "alibaba", "codebuddy-china", "youmind", "antigravity"];

let totalDeleted = 0;
const report: Record<string, { total: number; dupGroups: number; deleted: number; kept: number; decryptFail: number }> = {};

for (const provider of PROVIDERS) {
  const rows = db.query("SELECT id, email, password FROM accounts WHERE provider = ? ORDER BY id ASC").all(provider) as Array<{ id: number; email: string; password: string }>;
  if (rows.length === 0) { report[provider] = { total: 0, dupGroups: 0, deleted: 0, kept: 0, decryptFail: 0 }; continue; }

  const byKey = new Map<string, number[]>();
  let decryptFail = 0;
  for (const r of rows) {
    let pt: string;
    try { pt = crypto.decrypt(r.password); } catch { decryptFail++; continue; }
    const arr = byKey.get(pt) || [];
    arr.push(r.id);
    byKey.set(pt, arr);
  }

  let deleted = 0;
  let dupGroups = 0;
  let kept = 0;
  const toDelete: number[] = [];
  for (const [pt, ids] of byKey) {
    if (ids.length > 1) {
      dupGroups++;
      kept++;
      const remove = ids.slice(1);
      toDelete.push(...remove);
      deleted += remove.length;
      if (DRY_RUN) {
        console.log(`[${provider}] dup key "${pt.slice(0, 16)}..." x${ids.length}: keep id=${ids[0]}, delete ids=[${remove.join(",")}]`);
      }
    } else {
      kept++;
    }
  }

  if (!DRY_RUN && toDelete.length > 0) {
    const placeholders = toDelete.map(() => "?").join(",");
    db.transaction(() => {
      db.run(`DELETE FROM accounts WHERE id IN (${placeholders})`, toDelete as number[]);
    })();
  }

  totalDeleted += deleted;
  report[provider] = { total: rows.length, dupGroups, deleted, kept, decryptFail };
  if (decryptFail > 0) console.log(`[${provider}] WARNING: ${decryptFail} rows failed to decrypt (skipped)`);
}

console.log("\n=== SUMMARY (" + (DRY_RUN ? "DRY RUN" : "COMMITTED") + ") ===");
console.table(report);
console.log(`Total duplicate accounts ${DRY_RUN ? "would be" : "removed"}: ${totalDeleted}`);
db.close();
