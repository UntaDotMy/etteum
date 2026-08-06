/**
 * Backup merge import: append accounts, no duplicates by (provider, email).
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
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  accountIdentityKey,
  chooseMergeTokens,
  encryptionKeyFromEnvText,
  mergeAccountsFromPack,
  oauthExpiresAtSec,
  BACKUP_FORMAT,
  BACKUP_VERSION,
} from "../../src/lib/backup";
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  isGcm,
  reencryptSecret,
} from "../../src/utils/crypto";
import { client as liveSqlite } from "../../src/db/index";

const LIVE_KEY =
  process.env.ENCRYPTION_KEY ||
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
const PACK_KEY = "pack-side-encryption-key-value-abcdef0123456789";

const markerEmail = `merge-test-${Date.now()}@example.com`;
const markerProvider = "grok";
let packDir = "";
const createdIds: number[] = [];

function readEncryptedTokens(stored: string): Record<string, unknown> {
  expect(isGcm(stored)).toBe(true);
  return JSON.parse(decryptWithPassphrase(stored, LIVE_KEY)) as Record<string, unknown>;
}

function ensureAccountsTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      enabled INTEGER NOT NULL DEFAULT 1,
      tokens TEXT,
      quota_limit REAL DEFAULT 0,
      quota_remaining REAL DEFAULT 0,
      free_limit REAL DEFAULT 0,
      free_remaining REAL DEFAULT 0,
      last_login_at INTEGER,
      metadata TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
}

function writePack(dir: string, rows: Array<Record<string, unknown>>, encKey: string) {
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "poolprox3.db");
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new Database(dbPath);
  try {
    ensureAccountsTable(db);
    const ins = db.prepare(
      `INSERT INTO accounts (provider, email, password, status, enabled, tokens, priority, created_at, updated_at)
       VALUES ($provider, $email, $password, $status, $enabled, $tokens, $priority, $now, $now)`,
    );
    const now = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      ins.run({
        // bun:sqlite types named-parameter objects loosely; the shape is correct.
        $provider: r.provider,
        $email: r.email,
        $password: r.password,
        $status: r.status ?? "active",
        $enabled: r.enabled ?? 1,
        $tokens: r.tokens ?? null,
        $priority: r.priority ?? 0,
        $now: now,
      } as any);
    }
  } finally {
    db.close();
  }
  writeFileSync(path.join(dir, "env"), `ENCRYPTION_KEY=${encKey}\nAPI_KEY=pack-key\n`, "utf8");
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      mode: "essential",
      createdAt: new Date().toISOString(),
      meta: {
        platform: process.platform,
        databaseBytes: 1,
        envBytes: 1,
        counts: { accounts: rows.length },
      },
      files: { database: "poolprox3.db", env: "env" },
    }),
    "utf8",
  );
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = LIVE_KEY;
  packDir = mkdtempSync(path.join(tmpdir(), "etteum-merge-pack-"));
});

afterAll(() => {
  for (const id of createdIds) {
    try {
      liveSqlite.run(`DELETE FROM accounts WHERE id = ?`, [id]);
    } catch {
      /* ignore */
    }
  }
  try {
    liveSqlite.run(
      `DELETE FROM accounts WHERE provider = ? AND email LIKE ?`,
      [markerProvider, "merge-test-%@example.com"],
    );
  } catch {
    /* ignore */
  }
  if (packDir && existsSync(packDir)) {
    try {
      rmSync(packDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("backup merge helpers", () => {
  test("accountIdentityKey is provider+email", () => {
    expect(accountIdentityKey("grok", "a@b.com")).toBe("grok\0a@b.com");
    expect(accountIdentityKey("grok", "a@b.com")).not.toBe(
      accountIdentityKey("codex", "a@b.com"),
    );
  });

  test("encryptionKeyFromEnvText parses quoted and plain keys", () => {
    expect(encryptionKeyFromEnvText("ENCRYPTION_KEY=abc\n")).toBe("abc");
    expect(encryptionKeyFromEnvText('ENCRYPTION_KEY="quoted-key"\n')).toBe("quoted-key");
  });

  test("reencryptSecret rotates GCM ciphertext across passphrases", () => {
    const ct = encryptWithPassphrase("secret-password", PACK_KEY);
    const rotated = reencryptSecret(ct, PACK_KEY, LIVE_KEY);
    expect(rotated).not.toBe(ct);
    expect(decryptWithPassphrase(rotated, LIVE_KEY)).toBe("secret-password");
  });

  test("reencryptSecret is no-op when keys match", () => {
    const ct = encryptWithPassphrase("same", LIVE_KEY);
    expect(reencryptSecret(ct, LIVE_KEY, LIVE_KEY)).toBe(ct);
  });

  test("oauthExpiresAtSec accepts seconds, ms, and ISO", () => {
    expect(oauthExpiresAtSec({ expires_at: 1_700_000_000 })).toBe(1_700_000_000);
    expect(oauthExpiresAtSec({ expires_at: 1_700_000_000_000 })).toBe(1_700_000_000);
    expect(oauthExpiresAtSec({ expires_at: "2020-01-01T00:00:00.000Z" })).toBe(
      Math.floor(Date.parse("2020-01-01T00:00:00.000Z") / 1000),
    );
    expect(oauthExpiresAtSec(null)).toBe(0);
  });

  test("chooseMergeTokens keeps live when live access token is fresher", () => {
    const live = JSON.stringify({
      auth_method: "oauth",
      refresh_token: "live-rotated-rt",
      expires_at: 2_000_000_000,
    });
    const pack = JSON.stringify({
      auth_method: "oauth",
      refresh_token: "stale-pack-rt",
      expires_at: 1_500_000_000,
    });
    const chosen = chooseMergeTokens(live, pack);
    expect(JSON.parse(chosen!).refresh_token).toBe("live-rotated-rt");
  });

  test("chooseMergeTokens takes pack when pack is fresher or expiry missing", () => {
    const live = JSON.stringify({ refresh_token: "old-rt", auth_method: "oauth" });
    const pack = JSON.stringify({
      refresh_token: "new-rt-from-pack",
      auth_method: "oauth",
      expires_at: 2_000_000_000,
    });
    expect(JSON.parse(chooseMergeTokens(live, pack)!).refresh_token).toBe(
      "new-rt-from-pack",
    );
    // Both missing expiry → pack wins (intentional transfer)
    expect(
      JSON.parse(
        chooseMergeTokens(
          JSON.stringify({ refresh_token: "a" }),
          JSON.stringify({ refresh_token: "b" }),
        )!,
      ).refresh_token,
    ).toBe("b");
  });
});

describe("mergeAccountsFromPack", () => {
  test("inserts new account and updates existing without duplicating", () => {
    process.env.ENCRYPTION_KEY = LIVE_KEY;

    const emailA = markerEmail;
    const emailB = `merge-test-b-${Date.now()}@example.com`;
    const packPwA = encryptWithPassphrase("pack-pw-a", PACK_KEY);
    const packPwB = encryptWithPassphrase("pack-pw-b", PACK_KEY);

    // Seed live with emailA already present
    const seed = liveSqlite
      .query(
        `INSERT INTO accounts (provider, email, password, status, enabled, tokens, priority, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, ?, 0, ?, ?) RETURNING id`,
      )
      .get(
        markerProvider,
        emailA,
        encryptWithPassphrase("old-live-pw", LIVE_KEY),
        JSON.stringify({ refresh_token: "old-rt", auth_method: "oauth" }),
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      ) as { id: number };
    createdIds.push(seed.id);

    writePack(
      packDir,
      [
        {
          provider: markerProvider,
          email: emailA,
          password: packPwA,
          tokens: JSON.stringify({
            refresh_token: "new-rt-from-pack",
            auth_method: "oauth",
            sub: "sub-a",
          }),
        },
        {
          provider: markerProvider,
          email: emailB,
          password: packPwB,
          // Current-format backup: the raw token column is encrypted with the
          // pack key and must be opened before dedup, then re-keyed for live.
          tokens: encryptWithPassphrase(JSON.stringify({
              refresh_token: "rt-b",
              auth_method: "oauth",
              sub: "sub-b",
            }), PACK_KEY),
        },
        // duplicate row in pack — should be skipped after first
        {
          provider: markerProvider,
          email: emailB,
          password: packPwB,
          tokens: JSON.stringify({ refresh_token: "rt-b-dup", auth_method: "oauth" }),
        },
      ],
      PACK_KEY,
    );

    const beforeCount = (
      liveSqlite
        .query(`SELECT COUNT(*) AS n FROM accounts WHERE provider = ? AND email IN (?, ?)`)
        .get(markerProvider, emailA, emailB) as { n: number }
    ).n;
    expect(beforeCount).toBe(1);

    const result = mergeAccountsFromPack(packDir);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("merge");
    expect(result.needsRestart).toBe(false);
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.inserted).toBeGreaterThanOrEqual(1);
    // pack had 3 rows; one within-pack skip for emailB dup
    expect(result.inserted + result.updated + result.skipped).toBe(3);

    const rows = liveSqlite
      .query(
        `SELECT id, email, tokens, password FROM accounts WHERE provider = ? AND email IN (?, ?)`,
      )
      .all(markerProvider, emailA, emailB) as Array<{
      id: number;
      email: string;
      tokens: string;
      password: string;
    }>;
    expect(rows.length).toBe(2);
    for (const r of rows) createdIds.push(r.id);

    const a = rows.find((r) => r.email === emailA)!;
    const b = rows.find((r) => r.email === emailB)!;
    expect(readEncryptedTokens(a.tokens).refresh_token).toBe("new-rt-from-pack");
    expect(readEncryptedTokens(b.tokens).refresh_token).toBe("rt-b");
    // password re-keyed to live ENCRYPTION_KEY
    expect(decryptWithPassphrase(a.password, LIVE_KEY)).toBe("pack-pw-a");
    expect(decryptWithPassphrase(b.password, LIVE_KEY)).toBe("pack-pw-b");

    // Second merge of same pack: only updates, no new rows
    const again = mergeAccountsFromPack(packDir);
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(2);
    const after = (
      liveSqlite
        .query(`SELECT COUNT(*) AS n FROM accounts WHERE provider = ? AND email IN (?, ?)`)
        .get(markerProvider, emailA, emailB) as { n: number }
    ).n;
    expect(after).toBe(2);
  });

  test("merge keeps live Grok tokens when live access token is fresher than pack", () => {
    process.env.ENCRYPTION_KEY = LIVE_KEY;
    const email = `merge-test-fresher-${Date.now()}@example.com`;
    const packDir2 = mkdtempSync(path.join(tmpdir(), "etteum-merge-fresh-"));

    const seed = liveSqlite
      .query(
        `INSERT INTO accounts (provider, email, password, status, enabled, tokens, priority, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, ?, 0, ?, ?) RETURNING id`,
      )
      .get(
        markerProvider,
        email,
        encryptWithPassphrase("live-pw", LIVE_KEY),
        JSON.stringify({
          auth_method: "oauth",
          refresh_token: "live-rotated-rt",
          access_token: "live-at",
          expires_at: 2_100_000_000,
          sub: "sub-fresher",
        }),
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      ) as { id: number };
    createdIds.push(seed.id);

    writePack(
      packDir2,
      [
        {
          provider: markerProvider,
          email,
          password: encryptWithPassphrase("pack-pw", PACK_KEY),
          tokens: JSON.stringify({
            auth_method: "oauth",
            refresh_token: "stale-pack-rt",
            access_token: "stale-at",
            expires_at: 1_500_000_000,
            sub: "sub-fresher",
          }),
        },
      ],
      PACK_KEY,
    );

    try {
      const result = mergeAccountsFromPack(packDir2);
      expect(result.updated).toBe(1);
      expect(result.inserted).toBe(0);
      const row = liveSqlite
        .query(`SELECT tokens FROM accounts WHERE id = ?`)
        .get(seed.id) as { tokens: string };
      const tok = readEncryptedTokens(row.tokens);
      // Must NOT install the pack's already-rotated refresh token.
      expect(tok.refresh_token).toBe("live-rotated-rt");
      expect(tok.expires_at).toBe(2_100_000_000);
    } finally {
      try {
        rmSync(packDir2, { recursive: true, force: true });
      } catch {
        /* Windows may still hold a handle briefly */
      }
    }
  });

  test("merge dedups Grok by OIDC sub when emails differ (no dual-row RT race)", () => {
    process.env.ENCRYPTION_KEY = LIVE_KEY;
    const liveEmail = `merge-test-sub-live-${Date.now()}@example.com`;
    const packEmail = `merge-test-sub-pack-${Date.now()}@oauth`;
    const packDir2 = mkdtempSync(path.join(tmpdir(), "etteum-merge-sub-"));

    const seed = liveSqlite
      .query(
        `INSERT INTO accounts (provider, email, password, status, enabled, tokens, priority, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, ?, 0, ?, ?) RETURNING id`,
      )
      .get(
        markerProvider,
        liveEmail,
        encryptWithPassphrase("live-pw", LIVE_KEY),
        JSON.stringify({
          auth_method: "oauth",
          refresh_token: "same-rt",
          expires_at: 1_600_000_000,
          sub: "sub-shared-identity",
        }),
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      ) as { id: number };
    createdIds.push(seed.id);

    writePack(
      packDir2,
      [
        {
          provider: markerProvider,
          email: packEmail,
          password: encryptWithPassphrase("pack-pw", PACK_KEY),
          tokens: JSON.stringify({
            auth_method: "oauth",
            refresh_token: "same-rt-rotated",
            expires_at: 2_000_000_000,
            sub: "sub-shared-identity",
          }),
        },
      ],
      PACK_KEY,
    );

    try {
      const result = mergeAccountsFromPack(packDir2);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(1);
      const count = (
        liveSqlite
          .query(
            `SELECT COUNT(*) AS n FROM accounts WHERE provider = ? AND (
              email = ? OR email = ? OR tokens LIKE '%sub-shared-identity%'
            )`,
          )
          .get(markerProvider, liveEmail, packEmail) as { n: number }
      ).n;
      expect(count).toBe(1);
      const row = liveSqlite
        .query(`SELECT email, tokens FROM accounts WHERE id = ?`)
        .get(seed.id) as { email: string; tokens: string };
      // Keep live email; take fresher pack tokens (higher expires_at).
      expect(row.email).toBe(liveEmail);
      expect(readEncryptedTokens(row.tokens).refresh_token).toBe("same-rt-rotated");
    } finally {
      try {
        rmSync(packDir2, { recursive: true, force: true });
      } catch {
        /* Windows may still hold a handle briefly */
      }
    }
  });

  test("merge skips live rows whose tokens are sealed under a different key", () => {
    process.env.ENCRYPTION_KEY = LIVE_KEY;
    const OTHER_KEY = "some-other-install-encryption-key-0123456789";
    const badEmail = `merge-badkey-${Date.now()}@example.com`;
    const goodEmail = `merge-goodkey-${Date.now()}@example.com`;
    const packDir3 = mkdtempSync(path.join(tmpdir(), "etteum-merge-badkey-"));

    // Live row sealed under a DIFFERENT key (as a re-keyed farm install leaves
    // behind). openStoredTokens must skip it, not abort the whole merge.
    const badSeed = liveSqlite
      .query(
        `INSERT INTO accounts (provider, email, password, status, enabled, tokens, priority, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, ?, 0, ?, ?) RETURNING id`,
      )
      .get(
        markerProvider,
        badEmail,
        encryptWithPassphrase("pw", LIVE_KEY),
        encryptWithPassphrase(JSON.stringify({ refresh_token: "foreign-rt", auth_method: "oauth" }), OTHER_KEY),
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      ) as { id: number };
    createdIds.push(badSeed.id);

    writePack(
      packDir3,
      [
        {
          provider: markerProvider,
          email: goodEmail,
          password: encryptWithPassphrase("pack-pw", PACK_KEY),
          tokens: JSON.stringify({ refresh_token: "good-rt", auth_method: "oauth" }),
        },
      ],
      PACK_KEY,
    );

    try {
      const result = mergeAccountsFromPack(packDir3);
      expect(result.ok).toBe(true);
      // The good pack row still merges despite the undecryptable live row.
      expect(result.inserted).toBe(1);
      const row = liveSqlite
        .query(`SELECT tokens FROM accounts WHERE provider = ? AND email = ?`)
        .get(markerProvider, goodEmail) as { tokens: string };
      createdIds.push(
        (liveSqlite.query(`SELECT id FROM accounts WHERE email = ?`).get(goodEmail) as { id: number }).id,
      );
      expect(readEncryptedTokens(row.tokens).refresh_token).toBe("good-rt");
    } finally {
      try {
        rmSync(packDir3, { recursive: true, force: true });
      } catch {
        /* Windows may still hold a handle briefly */
      }
    }
  });
});
