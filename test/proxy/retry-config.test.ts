/**
 * retry-config unit tests — getRetryBudget / isRetrySettingKey /
 * invalidateRetryConfigCache.
 *
 * getRetryBudget resolves per key: settings table → env var → hardcoded
 * default, clamps to [1,10] / [0,5], and caches for 5s. These tests run
 * against an isolated real SQLite DB (DATABASE_PATH set BEFORE any import so
 * src/db/index opens the throwaway file, never the dev database) and clean up
 * the two retry_* settings rows after each test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "retry-config-test-"));
process.env.DATABASE_PATH = join(tmpDir, "retry-config.db");
// Keep config/crypto happy at import time (mirrors test/utils/crypto.test.ts).
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  getRetryBudget,
  invalidateRetryConfigCache,
  isRetrySettingKey,
} from "../../src/proxy/retry-config";
import { runMigrations } from "../../src/db/migrate";
import { db } from "../../src/db/index";
import { settings } from "../../src/db/schema";

const KEY_ATTEMPTS = "retry_max_account_attempts";
const KEY_INNER = "retry_max_inner_retries";
const ENV_ATTEMPTS = "POOLPROX_MAX_ACCOUNT_ATTEMPTS";
const ENV_INNER = "POOLPROX_MAX_INNER_RETRIES";

const savedEnv: Record<string, string | undefined> = {
  [ENV_ATTEMPTS]: process.env[ENV_ATTEMPTS],
  [ENV_INNER]: process.env[ENV_INNER],
};

async function clearRetrySettings(): Promise<void> {
  await db.delete(settings).where(eq(settings.key, KEY_ATTEMPTS));
  await db.delete(settings).where(eq(settings.key, KEY_INNER));
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settings).values({ key, value });
}

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  // Deterministic starting point: no settings rows, no env overrides, no cache.
  delete process.env[ENV_ATTEMPTS];
  delete process.env[ENV_INNER];
  invalidateRetryConfigCache();
  await clearRetrySettings();
});

afterAll(async () => {
  invalidateRetryConfigCache();
  await clearRetrySettings();
  if (savedEnv[ENV_ATTEMPTS] === undefined) delete process.env[ENV_ATTEMPTS];
  else process.env[ENV_ATTEMPTS] = savedEnv[ENV_ATTEMPTS]!;
  if (savedEnv[ENV_INNER] === undefined) delete process.env[ENV_INNER];
  else process.env[ENV_INNER] = savedEnv[ENV_INNER]!;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("isRetrySettingKey", () => {
  test("true only for the two retry_* keys", () => {
    expect(isRetrySettingKey(KEY_ATTEMPTS)).toBe(true);
    expect(isRetrySettingKey(KEY_INNER)).toBe(true);
  });

  test("false for lookalikes and unrelated keys", () => {
    expect(isRetrySettingKey("retry_max_account_attempts_extra")).toBe(false);
    expect(isRetrySettingKey("RETRY_MAX_ACCOUNT_ATTEMPTS")).toBe(false);
    expect(isRetrySettingKey("retry_max_inner_retries ")).toBe(false);
    expect(isRetrySettingKey("api_key")).toBe(false);
    expect(isRetrySettingKey("")).toBe(false);
  });
});

describe("getRetryBudget — defaults and env fallback", () => {
  test("no settings rows and no env → hardcoded 3/3", async () => {
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 3, innerRetries: 3 });
  });

  test("env vars override the hardcoded defaults", async () => {
    process.env[ENV_ATTEMPTS] = "5";
    process.env[ENV_INNER] = "1";
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 5, innerRetries: 1 });
  });

  test("env values are clamped into range (attempts > 10, inner > 5)", async () => {
    process.env[ENV_ATTEMPTS] = "999";
    process.env[ENV_INNER] = "42";
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 10, innerRetries: 5 });
  });

  test("inner retries env of 0 is honored (not treated as missing)", async () => {
    process.env[ENV_INNER] = "0";
    const b = await getRetryBudget();
    expect(b.innerRetries).toBe(0);
  });

  test("non-numeric / out-of-range env values fall back to defaults", async () => {
    process.env[ENV_ATTEMPTS] = "not-a-number";
    process.env[ENV_INNER] = "-1";
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 3, innerRetries: 3 });
  });

  test("attempts env of 0 is rejected (must be > 0), inner 0 still applies", async () => {
    process.env[ENV_ATTEMPTS] = "0";
    process.env[ENV_INNER] = "0";
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 3, innerRetries: 0 });
  });
});

describe("getRetryBudget — settings table wins over env", () => {
  test("settings row overrides both env and default", async () => {
    process.env[ENV_ATTEMPTS] = "2";
    process.env[ENV_INNER] = "2";
    await setSetting(KEY_ATTEMPTS, "7");
    await setSetting(KEY_INNER, "4");
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 7, innerRetries: 4 });
  });

  test("only one settings row present → other side falls back to env/default", async () => {
    process.env[ENV_INNER] = "1";
    await setSetting(KEY_ATTEMPTS, "8");
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 8, innerRetries: 1 });
  });

  test("settings values are clamped into range", async () => {
    await setSetting(KEY_ATTEMPTS, "1000");
    await setSetting(KEY_INNER, "99");
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 10, innerRetries: 5 });
  });

  test("fractional settings values are floored", async () => {
    await setSetting(KEY_ATTEMPTS, "4.9");
    await setSetting(KEY_INNER, "2.7");
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 4, innerRetries: 2 });
  });

  test("invalid settings values fall through to env/default", async () => {
    process.env[ENV_ATTEMPTS] = "6";
    await setSetting(KEY_ATTEMPTS, "garbage");
    await setSetting(KEY_INNER, "-3");
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 6, innerRetries: 3 });
  });

  test("settings value of 0 attempts is rejected, inner 0 honored", async () => {
    await setSetting(KEY_ATTEMPTS, "0");
    await setSetting(KEY_INNER, "0");
    const b = await getRetryBudget();
    expect(b).toEqual({ accountAttempts: 3, innerRetries: 0 });
  });
});

describe("getRetryBudget — 5s cache and invalidation", () => {
  test("second call within TTL returns the cached value (settings change invisible)", async () => {
    await setSetting(KEY_ATTEMPTS, "5");
    const first = await getRetryBudget();
    expect(first.accountAttempts).toBe(5);

    // Rewrite the row after the cache filled — WITHOUT invalidating.
    await db.update(settings).set({ value: "9" }).where(eq(settings.key, KEY_ATTEMPTS));
    const second = await getRetryBudget();
    expect(second.accountAttempts).toBe(5); // still the cached read
  });

  test("invalidateRetryConfigCache forces a fresh read", async () => {
    await setSetting(KEY_ATTEMPTS, "5");
    const first = await getRetryBudget();
    expect(first.accountAttempts).toBe(5);

    await db.update(settings).set({ value: "9" }).where(eq(settings.key, KEY_ATTEMPTS));
    invalidateRetryConfigCache();
    const second = await getRetryBudget();
    expect(second.accountAttempts).toBe(9);
  });

  test("deleting a settings row + invalidate restores the default", async () => {
    await setSetting(KEY_ATTEMPTS, "8");
    expect((await getRetryBudget()).accountAttempts).toBe(8);

    await clearRetrySettings();
    invalidateRetryConfigCache();
    expect((await getRetryBudget()).accountAttempts).toBe(3);
  });
});
