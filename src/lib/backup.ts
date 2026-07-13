/**
 * Etteum portable backup — migrate install state between PCs.
 *
 * Pack is a **folder** (or zip of that folder):
 *   manifest.json   — format/version/meta
 *   poolprox3.db    — SQLite snapshot
 *   env             — full .env text (includes ENCRYPTION_KEY)
 *   jwt-secret      — optional dashboard JWT secret
 *
 * Modes:
 *   essential (default) — drops request_logs + usage_summary so packs stay small
 *                         (accounts, tokens, settings, keys, proxies, combos, …)
 *   full                — entire database including request history
 *
 * Why not one giant JSON? Full DBs can be multi‑GB; base64 hits string limits.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { config } from "../config";
import { client as liveSqlite } from "../db/index";

export const BACKUP_FORMAT = "etteum-backup" as const;
export const BACKUP_VERSION = 1 as const;

export type BackupMode = "essential" | "full";

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  mode: BackupMode;
  createdAt: string;
  meta: {
    platform: string;
    hostname?: string;
    databaseBytes: number;
    envBytes: number;
    counts: Record<string, number>;
  };
  files: {
    database: "poolprox3.db";
    env: "env";
    jwtSecret?: "jwt-secret";
  };
}

export interface BackupSummary {
  dir: string;
  zipPath?: string;
  createdAt: string;
  mode: BackupMode;
  counts: Record<string, number>;
  databaseBytes: number;
  envBytes: number;
  hasJwtSecret: boolean;
}

export interface ImportResult {
  ok: true;
  preImportBackupDir: string;
  counts: Record<string, number>;
  needsRestart: boolean;
  message: string;
}

/** Tables dropped in essential mode (history only — not needed to run the same accounts). */
const ESSENTIAL_DROP_TABLES = ["request_logs", "usage_summary", "image_studio_chats", "image_studio_results"];

function projectRoot(): string {
  return path.resolve(import.meta.dir, "../..");
}

function envPath(): string {
  return path.join(projectRoot(), ".env");
}

function jwtSecretPath(): string {
  return path.join(projectRoot(), "data", "jwt-secret");
}

function databasePath(): string {
  const p = config.databasePath;
  return path.isAbsolute(p) ? p : path.join(projectRoot(), p);
}

function backupsRoot(): string {
  const dir = path.join(projectRoot(), "data", "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function checkpointLiveDatabase(): void {
  try {
    liveSqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* offline */
  }
}

function countTables(dbPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const tables = db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    for (const t of tables) {
      try {
        const row = db.query(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number };
        counts[t.name] = Number(row?.n ?? 0);
      } catch {
        counts[t.name] = -1;
      }
    }
  } catch {
    /* best-effort */
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  return counts;
}

function snapshotDatabase(destDb: string, mode: BackupMode): void {
  checkpointLiveDatabase();
  const dbPath = databasePath();
  if (!existsSync(dbPath)) throw new Error(`Database not found at ${dbPath}`);

  // Prefer VACUUM INTO for a compact self-contained file
  try {
    const escaped = destDb.replace(/\\/g, "/").replace(/'/g, "''");
    liveSqlite.exec(`VACUUM INTO '${escaped}'`);
  } catch {
    copyFileSync(dbPath, destDb);
  }
  if (!existsSync(destDb) || statSync(destDb).size < 100) {
    copyFileSync(dbPath, destDb);
  }

  if (mode === "essential") {
    const db = new Database(destDb);
    try {
      for (const t of ESSENTIAL_DROP_TABLES) {
        try {
          db.run(`DELETE FROM "${t}"`);
        } catch {
          /* table may not exist */
        }
      }
      db.run("VACUUM");
    } finally {
      db.close();
    }
  }
}

/**
 * Write a backup pack directory. Returns summary with absolute `dir`.
 */
export function createBackupDir(mode: BackupMode = "essential", outDir?: string): BackupSummary {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir =
    outDir && outDir.trim()
      ? path.isAbsolute(outDir)
        ? outDir
        : path.join(projectRoot(), outDir)
      : path.join(backupsRoot(), `etteum-backup-${mode}-${stamp}`);

  mkdirSync(dir, { recursive: true });

  const dbFile = path.join(dir, "poolprox3.db");
  snapshotDatabase(dbFile, mode);

  const envText = existsSync(envPath()) ? readFileSync(envPath(), "utf8") : "";
  writeFileSync(path.join(dir, "env"), envText, "utf8");

  let hasJwt = false;
  if (existsSync(jwtSecretPath())) {
    copyFileSync(jwtSecretPath(), path.join(dir, "jwt-secret"));
    hasJwt = true;
  }

  const counts = countTables(dbFile);
  const databaseBytes = statSync(dbFile).size;
  const envBytes = Buffer.byteLength(envText, "utf8");

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    mode,
    createdAt: new Date().toISOString(),
    meta: {
      platform: process.platform,
      hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || undefined,
      databaseBytes,
      envBytes,
      counts,
    },
    files: {
      database: "poolprox3.db",
      env: "env",
      ...(hasJwt ? { jwtSecret: "jwt-secret" as const } : {}),
    },
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return {
    dir,
    createdAt: manifest.createdAt,
    mode,
    counts,
    databaseBytes,
    envBytes,
    hasJwtSecret: hasJwt,
  };
}

/** Try to zip a backup directory (Windows Compress-Archive / zip). Best-effort. */
export async function zipBackupDir(dir: string): Promise<string | null> {
  const zipPath = dir.replace(/[/\\]$/, "") + ".zip";
  try {
    if (existsSync(zipPath)) unlinkSync(zipPath);
    if (process.platform === "win32") {
      const ps = `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
      const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", ps], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode !== 0 || !existsSync(zipPath)) return null;
      return zipPath;
    }
    // Unix: zip -r
    const proc = Bun.spawn(["zip", "-r", "-q", zipPath, "."], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0 || !existsSync(zipPath)) return null;
    return zipPath;
  } catch {
    return null;
  }
}

export function loadManifest(dir: string): BackupManifest {
  const mp = path.join(dir, "manifest.json");
  if (!existsSync(mp)) throw new Error(`Not a backup pack (missing manifest.json): ${dir}`);
  const m = JSON.parse(readFileSync(mp, "utf8")) as BackupManifest;
  if (m.format !== BACKUP_FORMAT) throw new Error(`Unsupported format: ${String(m.format)}`);
  if (m.version !== BACKUP_VERSION) throw new Error(`Unsupported version: ${String(m.version)}`);
  return m;
}

/**
 * Resolve import source: directory pack, or a .zip we extract first.
 */
export async function resolveImportSource(inputPath: string): Promise<string> {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot(), inputPath);
  if (!existsSync(abs)) throw new Error(`Path not found: ${abs}`);

  const st = statSync(abs);
  if (st.isDirectory()) {
    loadManifest(abs);
    return abs;
  }

  // Single-file zip
  if (abs.toLowerCase().endsWith(".zip")) {
    const extractDir = path.join(backupsRoot(), `import-extract-${Date.now()}`);
    mkdirSync(extractDir, { recursive: true });
    if (process.platform === "win32") {
      const ps = `Expand-Archive -Path '${abs.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`;
      const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", ps], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode !== 0) throw new Error("Failed to expand zip (Expand-Archive)");
    } else {
      const proc = Bun.spawn(["unzip", "-q", abs, "-d", extractDir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode !== 0) throw new Error("Failed to unzip backup");
    }
    // zip may nest one folder
    if (existsSync(path.join(extractDir, "manifest.json"))) return extractDir;
    const kids = readdirSync(extractDir);
    for (const k of kids) {
      const p = path.join(extractDir, k);
      if (statSync(p).isDirectory() && existsSync(path.join(p, "manifest.json"))) return p;
    }
    throw new Error("Zip did not contain a valid backup pack (no manifest.json)");
  }

  throw new Error(
    "Import path must be a backup folder (with manifest.json) or a .zip of that folder",
  );
}

/**
 * Apply a backup pack directory onto this install.
 * Stops short of restarting — caller should restart the server.
 */
export function applyBackupDir(packDir: string): ImportResult {
  const manifest = loadManifest(packDir);
  const dbSrc = path.join(packDir, manifest.files.database || "poolprox3.db");
  const envSrc = path.join(packDir, manifest.files.env || "env");
  if (!existsSync(dbSrc)) throw new Error(`Backup missing ${manifest.files.database}`);
  if (!existsSync(envSrc)) throw new Error(`Backup missing ${manifest.files.env}`);

  // Validate SQLite header
  const head = readFileSync(dbSrc).subarray(0, 16).toString("utf8");
  if (!head.startsWith("SQLite format 3")) {
    throw new Error("Backup database is not a valid SQLite file");
  }

  const root = projectRoot();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preDir = path.join(backupsRoot(), `pre-import-${stamp}`);
  mkdirSync(preDir, { recursive: true });

  const dbPath = databasePath();
  const ePath = envPath();
  const jPath = jwtSecretPath();

  try {
    checkpointLiveDatabase();
  } catch {
    /* offline */
  }
  if (existsSync(dbPath)) copyFileSync(dbPath, path.join(preDir, "poolprox3.db"));
  if (existsSync(ePath)) copyFileSync(ePath, path.join(preDir, ".env"));
  if (existsSync(jPath)) copyFileSync(jPath, path.join(preDir, "jwt-secret"));

  // Clear WAL so the new main file is authoritative
  for (const suffix of ["-wal", "-shm"]) {
    const p = dbPath + suffix;
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* locked */
    }
  }

  const tmpDb = dbPath + `.importing-${Date.now()}`;
  copyFileSync(dbSrc, tmpDb);
  try {
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      renameSync(tmpDb, dbPath);
    } catch {
      copyFileSync(tmpDb, dbPath);
      try {
        unlinkSync(tmpDb);
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    throw new Error(
      `Failed to replace database (file locked?): ${e instanceof Error ? e.message : String(e)}. ` +
        `Run: etteum stop → import → etteum start`,
    );
  }

  writeFileSync(ePath, readFileSync(envSrc, "utf8"), "utf8");

  const jwtName = manifest.files.jwtSecret || "jwt-secret";
  const jwtSrc = path.join(packDir, jwtName);
  if (existsSync(jwtSrc)) {
    mkdirSync(path.dirname(jPath), { recursive: true });
    copyFileSync(jwtSrc, jPath);
  }

  const counts = manifest.meta?.counts ?? countTables(dbPath);
  return {
    ok: true,
    preImportBackupDir: preDir,
    counts,
    needsRestart: true,
    message:
      `Import complete (${manifest.mode}). Restart the server to reload .env and the database. ` +
      `Previous files: ${preDir}`,
  };
}

export function defaultExportDir(mode: BackupMode = "essential"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(backupsRoot(), `etteum-backup-${mode}-${stamp}`);
}

/** Remove temp export artifacts older than a day under data/backups (optional GC). */
export function cleanupOldExportSnaps(): void {
  try {
    const root = backupsRoot();
    for (const name of readdirSync(root)) {
      if (!name.startsWith("export-snap-")) continue;
      const p = path.join(root, name);
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
