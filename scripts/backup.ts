#!/usr/bin/env bun
/**
 * CLI backup tool — migrate Etteum between PCs.
 *
 *   bun scripts/backup.ts export [outdir] [--full]
 *   bun scripts/backup.ts import <dir-or-zip> [--merge|--replace] [--yes]
 *
 * essential (default): accounts, settings, keys, proxies, .env — no request history
 * full: entire SQLite DB (can be multi‑GB if request_logs are large)
 *
 * Import modes:
 *   --merge   (default) append accounts by (provider,email); update if present;
 *             safe while server is running; no DB wipe
 *   --replace full DB + .env swap; stop server first; requires --yes
 *
 * Prefer stopping the server before --replace on Windows if the DB is locked:
 *   etteum stop
 *   bun scripts/backup.ts import ./etteum-backup-essential-.... --replace --yes
 *   etteum start
 */
import {
  applyBackupDir,
  createBackupDir,
  defaultExportDir,
  mergeAccountsFromPack,
  resolveImportSource,
  zipBackupDir,
  type BackupMode,
} from "../src/lib/backup";

const args = process.argv.slice(2);
const cmd = (args[0] || "").toLowerCase();
const full = args.includes("--full");
const yes = args.includes("--yes") || args.includes("-y");
const replace = args.includes("--replace");
const merge = args.includes("--merge") || !replace;

function usage(): never {
  console.log(`Usage:
  bun scripts/backup.ts export [outdir] [--full]
  bun scripts/backup.ts import <folder-or.zip> [--merge|--replace] [--yes]

  --full     include request_logs / history (can be multi-GB)
  --merge    append accounts only (default; no duplicates by provider+email)
  --replace  overwrite entire DB + .env (requires --yes; restart after)
  default export: essential pack (accounts + config only)

After export, copy the folder (or .zip) to the other PC and import there.
Pack includes ENCRYPTION_KEY so passwords re-key correctly on merge/replace.
`);
  process.exit(1);
}

if (cmd === "export") {
  const mode: BackupMode = full ? "full" : "essential";
  const outArg = args.find((a, i) => i > 0 && !a.startsWith("-"));
  const out = outArg || defaultExportDir(mode);
  console.log(`Creating ${mode} backup…`);
  const summary = createBackupDir(mode, out);
  console.log("OK  pack folder:", summary.dir);
  console.log("    mode:", summary.mode);
  console.log("    created:", summary.createdAt);
  console.log("    db bytes:", summary.databaseBytes);
  console.log("    env bytes:", summary.envBytes);
  console.log("    jwt-secret:", summary.hasJwtSecret ? "yes" : "no");
  console.log("    counts:", JSON.stringify(summary.counts));
  const zip = await zipBackupDir(summary.dir);
  if (zip) {
    console.log("    zip:", zip);
  } else {
    console.log("    zip: (skipped — copy the folder instead)");
  }
  console.log("\nOn the other PC:");
  console.log("  1. Install etteum (or copy the project)");
  console.log("  2. etteum stop   # if already running");
  console.log(`  3. bun scripts/backup.ts import ${zip || summary.dir} --yes`);
  console.log("  4. etteum start");
  process.exit(0);
}

if (cmd === "import") {
  const file = args.find((a, i) => i > 0 && !a.startsWith("-"));
  if (!file) usage();
  console.log("Resolving", file);
  const packDir = await resolveImportSource(file!);

  if (merge && !replace) {
    console.log("Merging accounts from pack (append, no duplicates)…", packDir);
    const result = mergeAccountsFromPack(packDir);
    console.log("OK ", result.message);
    console.log(
      `    inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped} pack=${result.totalInPack}`,
    );
    if (result.errors?.length) {
      console.log("    errors:", result.errors.slice(0, 10).join(" | "));
    }
    process.exit(0);
  }

  if (!yes) {
    console.error("Refusing full replace without --yes (overwrites DB + .env).");
    console.error("Tip: use --merge (default) to append accounts without wiping.");
    process.exit(1);
  }
  console.log("Full replace from pack", packDir);
  const result = applyBackupDir(packDir);
  console.log("OK ", result.message);
  console.log("    pre-import snapshot:", result.preImportBackupDir);
  console.log("    counts:", JSON.stringify(result.counts));
  if (result.needsRestart) {
    console.log("\nRestart now:  etteum restart");
  }
  process.exit(0);
}

usage();
