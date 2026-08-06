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
import {
  decryptWithPassphrase,
  encryptWithPassphrase,
  isGcm,
  reencryptSecret,
} from "../utils/crypto";

export const BACKUP_FORMAT = "etteum-backup" as const;
export const BACKUP_VERSION = 1 as const;

export type BackupMode = "essential" | "full";
/** replace = full DB swap (needs server restart). merge = append accounts, no dups. */
export type ImportMode = "merge" | "replace";

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
  mode?: ImportMode;
}

export interface MergeImportResult {
  ok: true;
  mode: "merge";
  inserted: number;
  updated: number;
  skipped: number;
  totalInPack: number;
  needsRestart: false;
  message: string;
  errors?: string[];
}

/** Parse ENCRYPTION_KEY from .env / pack env file text. */
export function encryptionKeyFromEnvText(text: string): string {
  const m = text.match(/^\s*ENCRYPTION_KEY\s*=\s*(.*)$/m);
  return (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
}

/** Stable identity for account dedup across packs. */
export function accountIdentityKey(provider: string, email: string): string {
  return `${provider}\0${email}`;
}

/**
 * Access-token expiry as unix seconds from a tokens JSON blob (string or object).
 * OAuth providers store expires_at as seconds (or ms / ISO). Used by merge to
 * prefer the fresher credential set and avoid installing an already-rotated
 * refresh_token from a stale backup.
 */
export function oauthExpiresAtSec(tokens: unknown): number {
  if (tokens == null) return 0;
  let obj: Record<string, unknown> | null = null;
  if (typeof tokens === "string") {
    const s = tokens.trim();
    if (!s) return 0;
    try {
      obj = JSON.parse(s) as Record<string, unknown>;
    } catch {
      return 0;
    }
  } else if (typeof tokens === "object") {
    obj = tokens as Record<string, unknown>;
  }
  if (!obj) return 0;
  const raw = obj.expires_at ?? obj.expiresAt ?? obj.expiresAtMs;
  if (raw == null) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 1_000_000_000) {
      return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
    }
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

/** Opaque refresh_token from a tokens JSON blob (empty if absent). */
export function oauthRefreshToken(tokens: unknown): string {
  if (tokens == null) return "";
  let obj: Record<string, unknown> | null = null;
  if (typeof tokens === "string") {
    try {
      obj = JSON.parse(tokens) as Record<string, unknown>;
    } catch {
      return "";
    }
  } else if (typeof tokens === "object") {
    obj = tokens as Record<string, unknown>;
  }
  if (!obj) return "";
  const rt = obj.refresh_token ?? obj.refreshToken;
  return typeof rt === "string" ? rt.trim() : "";
}

/** OIDC `sub` from a tokens JSON blob (empty if absent). */
export function oauthSub(tokens: unknown): string {
  if (tokens == null) return "";
  let obj: Record<string, unknown> | null = null;
  if (typeof tokens === "string") {
    try {
      obj = JSON.parse(tokens) as Record<string, unknown>;
    } catch {
      return "";
    }
  } else if (typeof tokens === "object") {
    obj = tokens as Record<string, unknown>;
  }
  if (!obj) return "";
  return typeof obj.sub === "string" ? obj.sub.trim() : "";
}

/**
 * Choose which token blob to keep on merge-update of an existing account.
 *
 * Grok (and other OAuth) refresh tokens **rotate**: using a refresh_token
 * invalidates the previous one. Blindly writing pack tokens over a live row
 * that already rotated installs a **revoked** refresh_token → next warmup /
 * auto-refresh fails with invalid_grant.
 *
 * Policy: keep the blob with the **greater** access-token expires_at.
 * Tie / both missing → pack wins (import is intentional source of truth).
 */
export function chooseMergeTokens(
  liveTokens: string | null | undefined,
  packTokens: string | null | undefined,
): string | null {
  const pack =
    packTokens == null
      ? null
      : typeof packTokens === "string"
        ? packTokens
        : JSON.stringify(packTokens);
  const live =
    liveTokens == null
      ? null
      : typeof liveTokens === "string"
        ? liveTokens
        : JSON.stringify(liveTokens);

  if (pack == null || pack === "") return live;
  if (live == null || live === "") return pack;

  const liveExp = oauthExpiresAtSec(live);
  const packExp = oauthExpiresAtSec(pack);
  if (liveExp > packExp) return live;
  return pack;
}

/** Read a token JSON blob from either a legacy plaintext or current GCM row. */
function openStoredTokens(value: string | null | undefined, passphrase: string): string | null {
  if (value == null) return null;
  const stored = typeof value === "string" ? value : JSON.stringify(value);
  if (!isGcm(stored)) return stored;
  // A row whose tokens were sealed under a different ENCRYPTION_KEY (e.g. a
  // farm install re-keyed them) cannot be opened here. Skip it instead of
  // throwing, or one undecryptable row aborts the whole merge — mirrors the
  // tolerate-and-continue convention in reencryptSecret.
  try {
    return decryptWithPassphrase(stored, passphrase);
  } catch {
    return null;
  }
}

/** Raw-SQL backup merge bypasses the ORM, so seal token JSON explicitly. */
function sealStoredTokens(value: string | null | undefined, passphrase: string): string | null {
  if (value == null) return null;
  const plain = typeof value === "string" ? value : JSON.stringify(value);
  return encryptWithPassphrase(plain, passphrase);
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

type PackAccountRow = {
  provider: string;
  email: string;
  password: string;
  status: string | null;
  enabled: number | null;
  tokens: string | null;
  quota_limit: number | null;
  quota_remaining: number | null;
  free_limit: number | null;
  free_remaining: number | null;
  last_login_at: number | null;
  metadata: string | null;
  priority: number | null;
};

/**
 * Merge accounts from a backup pack into the live database (append, no duplicates).
 *
 * Dedup keys (first match wins):
 *   1. (provider, email) — unique index accounts_provider_email_idx
 *   2. (provider, OIDC sub) — same Grok/Codex user under a different label
 *   3. (provider, refresh_token) — same credential under a different email
 *
 * Tokens on UPDATE: prefer the fresher OAuth blob (higher access-token
 * expires_at) so a stale pack cannot overwrite a live rotated refresh_token.
 * Pack wins on tie / missing expiry (intentional transfer).
 *
 * Passwords and encrypted token JSON are re-keyed for this installation.
 * Does NOT replace the DB file — safe while the server is running (no restart).
 */
export function mergeAccountsFromPack(packDir: string): MergeImportResult {
  const manifest = loadManifest(packDir);
  const dbSrc = path.join(packDir, manifest.files.database || "poolprox3.db");
  const envSrc = path.join(packDir, manifest.files.env || "env");
  if (!existsSync(dbSrc)) throw new Error(`Backup missing ${manifest.files.database}`);
  if (!existsSync(envSrc)) throw new Error(`Backup missing ${manifest.files.env}`);

  const head = readFileSync(dbSrc).subarray(0, 16).toString("utf8");
  if (!head.startsWith("SQLite format 3")) {
    throw new Error("Backup database is not a valid SQLite file");
  }

  const sourceKey = encryptionKeyFromEnvText(readFileSync(envSrc, "utf8"));
  const targetKey = process.env.ENCRYPTION_KEY || config.encryptionKey || "";
  if (!targetKey || targetKey.length < 16) {
    throw new Error(
      "This install has no ENCRYPTION_KEY — set it in .env before merge import.",
    );
  }
  if (!sourceKey || sourceKey.length < 16) {
    throw new Error(
      "Backup pack env is missing ENCRYPTION_KEY — cannot safely re-key credentials.",
    );
  }

  const src = new Database(dbSrc, { readonly: true });
  let packRows: PackAccountRow[] = [];
  try {
    packRows = src
      .query(
        `SELECT provider, email, password, status, enabled, tokens,
                quota_limit, quota_remaining, free_limit, free_remaining,
                last_login_at, metadata, priority
         FROM accounts`,
      )
      .all() as PackAccountRow[];
  } finally {
    src.close();
  }

  // Existing identities on live DB — email + OAuth secondary keys (sub / RT).
  const existing = liveSqlite
    .query(`SELECT id, provider, email, tokens FROM accounts`)
    .all() as Array<{
    id: number;
    provider: string;
    email: string;
    tokens: string | null;
  }>;
  const byKey = new Map<string, number>();
  const bySub = new Map<string, number>();
  const byRefresh = new Map<string, number>();
  const liveTokensById = new Map<number, string | null>();

  const indexOAuthKeys = (
    id: number,
    provider: string,
    tokens: string | null | undefined,
  ) => {
    const sub = oauthSub(tokens);
    const rt = oauthRefreshToken(tokens);
    if (sub) bySub.set(`${provider}\0${sub}`, id);
    if (rt) byRefresh.set(`${provider}\0${rt}`, id);
  };

  for (const row of existing) {
    const tokens = openStoredTokens(row.tokens, targetKey);
    byKey.set(accountIdentityKey(row.provider, row.email), row.id);
    liveTokensById.set(row.id, tokens);
    indexOAuthKeys(row.id, row.provider, tokens);
  }

  const insertStmt = liveSqlite.prepare(
    `INSERT INTO accounts (
       provider, email, password, status, enabled, tokens,
       quota_limit, quota_remaining, free_limit, free_remaining,
       last_login_at, metadata, priority, created_at, updated_at
     ) VALUES (
       $provider, $email, $password, $status, $enabled, $tokens,
       $quota_limit, $quota_remaining, $free_limit, $free_remaining,
       $last_login_at, $metadata, $priority, $now, $now
     )`,
  );
  const updateStmt = liveSqlite.prepare(
    `UPDATE accounts SET
       password = $password,
       status = $status,
       enabled = $enabled,
       tokens = $tokens,
       quota_limit = $quota_limit,
       quota_remaining = $quota_remaining,
       free_limit = $free_limit,
       free_remaining = $free_remaining,
       last_login_at = $last_login_at,
       metadata = $metadata,
       priority = $priority,
       error_message = NULL,
       updated_at = $now
     WHERE id = $id`,
  );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  const now = Date.now();
  // Within-pack dedup (same provider+email twice in export)
  const seenInPack = new Set<string>();
  const seenSubInPack = new Set<string>();
  const seenRtInPack = new Set<string>();

  const tx = liveSqlite.transaction(() => {
    for (const row of packRows) {
      const provider = String(row.provider || "").trim();
      const email = String(row.email || "").trim();
      if (!provider || !email) {
        skipped++;
        continue;
      }
      const key = accountIdentityKey(provider, email);
      if (seenInPack.has(key)) {
        skipped++;
        continue;
      }

      try {
        const password = reencryptSecret(String(row.password || ""), sourceKey, targetKey);
        const packTokens = openStoredTokens(row.tokens, sourceKey);
        const packSub = oauthSub(packTokens);
        const packRt = oauthRefreshToken(packTokens);

        // Within-pack OAuth dedup (same sub / same refresh under different emails)
        if (packSub) {
          const subKey = `${provider}\0${packSub}`;
          if (seenSubInPack.has(subKey)) {
            skipped++;
            continue;
          }
        }
        if (packRt) {
          const rtKey = `${provider}\0${packRt}`;
          if (seenRtInPack.has(rtKey)) {
            skipped++;
            continue;
          }
        }

        seenInPack.add(key);
        if (packSub) seenSubInPack.add(`${provider}\0${packSub}`);
        if (packRt) seenRtInPack.add(`${provider}\0${packRt}`);

        const metadata =
          row.metadata == null
            ? null
            : typeof row.metadata === "string"
              ? row.metadata
              : JSON.stringify(row.metadata);
        const status = row.status || "active";
        const enabled = row.enabled == null ? 1 : Number(row.enabled) ? 1 : 0;
        const priority = row.priority == null ? 0 : Number(row.priority);

        // Resolve existing row: email → sub → refresh_token (prevents dual rows
        // that race-refresh the same rotated credential).
        let existingId = byKey.get(key);
        if (existingId == null && packSub) {
          existingId = bySub.get(`${provider}\0${packSub}`);
        }
        if (existingId == null && packRt) {
          existingId = byRefresh.get(`${provider}\0${packRt}`);
        }

        if (existingId != null) {
          const liveTok = liveTokensById.get(existingId) ?? null;
          const tokens = chooseMergeTokens(liveTok, packTokens);
          updateStmt.run({
            $id: existingId,
            $password: password,
            $status: status,
            $enabled: enabled,
            $tokens: sealStoredTokens(tokens, targetKey),
            $quota_limit: row.quota_limit,
            $quota_remaining: row.quota_remaining,
            $free_limit: row.free_limit,
            $free_remaining: row.free_remaining,
            $last_login_at: row.last_login_at,
            $metadata: metadata,
            $priority: priority,
            $now: now,
          });
          liveTokensById.set(existingId, tokens);
          indexOAuthKeys(existingId, provider, tokens);
          byKey.set(key, existingId);
          updated++;
        } else {
          const info = insertStmt.run({
            $provider: provider,
            $email: email,
            $password: password,
            $status: status,
            $enabled: enabled,
            $tokens: sealStoredTokens(packTokens, targetKey),
            $quota_limit: row.quota_limit,
            $quota_remaining: row.quota_remaining,
            $free_limit: row.free_limit,
            $free_remaining: row.free_remaining,
            $last_login_at: row.last_login_at,
            $metadata: metadata,
            $priority: priority,
            $now: now,
          });
          const newId = Number(info.lastInsertRowid);
          byKey.set(key, newId);
          liveTokensById.set(newId, packTokens);
          indexOAuthKeys(newId, provider, packTokens);
          inserted++;
        }
      } catch (e) {
        skipped++;
        if (errors.length < 30) {
          errors.push(
            `${provider}/${email}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  });
  tx();

  return {
    ok: true,
    mode: "merge",
    inserted,
    updated,
    skipped,
    totalInPack: packRows.length,
    needsRestart: false,
    message:
      `Merged accounts from backup: ${inserted} added, ${updated} updated (already present), ` +
      `${skipped} skipped. Live accounts kept; no full DB replace.`,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Apply a backup pack directory onto this install (full replace of DB + .env).
 * Stops short of restarting — caller should restart the server.
 * Prefer {@link mergeAccountsFromPack} when you only need to append accounts.
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
    mode: "replace",
    preImportBackupDir: preDir,
    counts,
    needsRestart: true,
    message:
      `Full replace complete (${manifest.mode}). You MUST fully restart the server process ` +
      `(not just reload the page) so it opens the new database and ENCRYPTION_KEY. ` +
      `Run: etteum restart. Previous files: ${preDir}`,
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
