/**
 * Unit tests for AccountPool quota arithmetic:
 *   - applyQuotaSnapshot   (clamp/floor, no-op fast path, drain→exhausted, limit/resetAt patching)
 *   - decrementQuota       (clamped SQL debit, invalid-input read-only path, tokens sync)
 *   - syncTokenCreditsRemaining (private; verified through the two public callers)
 *
 * Env is set BEFORE imports because config reads ENCRYPTION_KEY / DATABASE_PATH
 * at import time. DATABASE_PATH points at a temp file so these tests never
 * touch the operator's real data/poolprox3.db.
 *
 * All three units touch ONLY the accounts table in a throwaway SQLite DB.
 * No network, no live upstreams, no real provider accounts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "pool-quota-"));

process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
process.env.DATABASE_PATH = join(tmpHome, "pool-quota-test.db");

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runMigrations } from "../../src/db/migrate";
import { db } from "../../src/db/index";
import { accounts } from "../../src/db/schema";
import { eq, like } from "drizzle-orm";
import { pool } from "../../src/proxy/pool";

// Unique provider so our rows never collide with another suite's fixtures.
const PROVIDER = "poolquotatest" as any;

async function insertAccount(opts: {
  email: string;
  status?: string;
  quotaLimit?: number;
  quotaRemaining?: number;
  tokens?: unknown;
}): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: PROVIDER,
      email: opts.email,
      password: "irrelevant",
      status: opts.status ?? "active",
      enabled: true,
      quotaLimit: opts.quotaLimit ?? 0,
      quotaRemaining: opts.quotaRemaining ?? 0,
      tokens: opts.tokens === undefined ? null : (opts.tokens as any),
    })
    .returning({ id: accounts.id });
  return row!.id;
}

async function getAccount(id: number) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return row;
}

beforeAll(async () => {
  await runMigrations();
  await db.delete(accounts).where(eq(accounts.provider, PROVIDER));
});

afterAll(async () => {
  try {
    await db.delete(accounts).where(eq(accounts.provider, PROVIDER));
  } catch { /* best-effort */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// applyQuotaSnapshot
// ---------------------------------------------------------------------------
describe("applyQuotaSnapshot", () => {
  test("writes remaining/limit and persists them", async () => {
    const id = await insertAccount({ email: "snap-1@pq.test", quotaLimit: 100, quotaRemaining: 80 });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 42, quotaLimit: 100 });
    const row = await getAccount(id);
    expect(Number(row?.quotaRemaining)).toBe(42);
    expect(Number(row?.quotaLimit)).toBe(100);
  });

  test("floors fractional remaining and clamps negative to 0", async () => {
    const id = await insertAccount({ email: "snap-2@pq.test", quotaLimit: 100, quotaRemaining: 50 });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 7.9 });
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(7);

    await pool.applyQuotaSnapshot(id, { quotaRemaining: -3 });
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(0);
  });

  test("no-op when nothing changed (row untouched, still same values)", async () => {
    const id = await insertAccount({ email: "snap-3@pq.test", quotaLimit: 100, quotaRemaining: 33 });
    // Identical snapshot → early return; values must be exactly as inserted.
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 33, quotaLimit: 100 });
    const row = await getAccount(id);
    expect(Number(row?.quotaRemaining)).toBe(33);
    expect(Number(row?.quotaLimit)).toBe(100);
    expect(row?.status).toBe("active");
  });

  test("drain to 0 with positive limit flips active → exhausted", async () => {
    const id = await insertAccount({ email: "snap-4@pq.test", quotaLimit: 100, quotaRemaining: 10 });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 0 });
    const row = await getAccount(id);
    expect(Number(row?.quotaRemaining)).toBe(0);
    expect(row?.status).toBe("exhausted");
  });

  test("does NOT flip to exhausted when limit is 0 (unknown budget)", async () => {
    const id = await insertAccount({ email: "snap-5@pq.test", quotaLimit: 0, quotaRemaining: 5 });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 0 });
    const row = await getAccount(id);
    expect(Number(row?.quotaRemaining)).toBe(0);
    expect(row?.status).toBe("active"); // limit<=0 → treated as unknown, stays active
  });

  test("never re-activates an error/pending row even when remaining recovers", async () => {
    const id = await insertAccount({ email: "snap-6@pq.test", status: "error", quotaLimit: 100, quotaRemaining: 0 });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 55 });
    const row = await getAccount(id);
    expect(Number(row?.quotaRemaining)).toBe(55);
    expect(row?.status).toBe("error"); // status preserved
  });

  test("patches quotaResetAt when provided", async () => {
    const id = await insertAccount({ email: "snap-7@pq.test", quotaLimit: 100, quotaRemaining: 50 });
    const resetAt = new Date("2026-09-01T00:00:00Z");
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 50, quotaResetAt: resetAt });
    const row = await getAccount(id);
    expect(row?.quotaResetAt?.getTime()).toBe(resetAt.getTime());
  });

  test("ignores non-finite remaining (NaN/Infinity) and leaves row alone", async () => {
    const id = await insertAccount({ email: "snap-8@pq.test", quotaLimit: 100, quotaRemaining: 61 });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: Number.NaN });
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(61);
    await pool.applyQuotaSnapshot(id, { quotaRemaining: Number.POSITIVE_INFINITY });
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(61);
  });

  test("returns without touching a missing account id", async () => {
    // Must not throw.
    await pool.applyQuotaSnapshot(9_999_999, { quotaRemaining: 10 });
  });

  test("keeps existing limit when snapshot omits quotaLimit", async () => {
    const id = await insertAccount({ email: "snap-9@pq.test", quotaLimit: 250, quotaRemaining: 200 });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 120 });
    const row = await getAccount(id);
    expect(Number(row?.quotaRemaining)).toBe(120);
    expect(Number(row?.quotaLimit)).toBe(250); // unchanged
  });
});

// ---------------------------------------------------------------------------
// decrementQuota
// ---------------------------------------------------------------------------
describe("decrementQuota", () => {
  test("debits remaining and returns the new value", async () => {
    const id = await insertAccount({ email: "dec-1@pq.test", quotaLimit: 100, quotaRemaining: 50 });
    const remaining = await pool.decrementQuota(id, 20);
    expect(remaining).toBe(30);
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(30);
  });

  test("clamps at 0 when debit exceeds remaining (no negative)", async () => {
    const id = await insertAccount({ email: "dec-2@pq.test", quotaLimit: 100, quotaRemaining: 5 });
    const remaining = await pool.decrementQuota(id, 999);
    expect(remaining).toBe(0);
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(0);
  });

  test("NULL remaining is treated as 0 (COALESCE) and clamps to 0", async () => {
    const id = await insertAccount({ email: "dec-3@pq.test", quotaLimit: 100 });
    // Force quota_remaining to NULL directly.
    await db.update(accounts).set({ quotaRemaining: null as any }).where(eq(accounts.id, id));
    const remaining = await pool.decrementQuota(id, 10);
    expect(remaining).toBe(0);
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(0);
  });

  test("non-positive / non-finite creditsUsed is a read-only no-op that returns current remaining", async () => {
    const id = await insertAccount({ email: "dec-4@pq.test", quotaLimit: 100, quotaRemaining: 77 });
    expect(await pool.decrementQuota(id, 0)).toBe(77);
    expect(await pool.decrementQuota(id, -5)).toBe(77);
    expect(await pool.decrementQuota(id, Number.NaN)).toBe(77);
    expect(await pool.decrementQuota(id, Number.POSITIVE_INFINITY)).toBe(77);
    // Row must be untouched.
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(77);
  });

  test("returns 0 for a missing account id on the invalid-input path", async () => {
    expect(await pool.decrementQuota(9_999_998, 0)).toBe(0);
  });

  test("accumulates successive debits correctly", async () => {
    const id = await insertAccount({ email: "dec-5@pq.test", quotaLimit: 100, quotaRemaining: 100 });
    expect(await pool.decrementQuota(id, 30)).toBe(70);
    expect(await pool.decrementQuota(id, 25)).toBe(45);
    expect(await pool.decrementQuota(id, 45)).toBe(0);
    expect(await pool.decrementQuota(id, 1)).toBe(0); // already at floor
  });
});

// ---------------------------------------------------------------------------
// syncTokenCreditsRemaining (private — exercised via the public callers)
// ---------------------------------------------------------------------------
describe("syncTokenCreditsRemaining (via public callers)", () => {
  test("decrementQuota pins tokens.credits_remaining to the new remaining", async () => {
    const id = await insertAccount({
      email: "sync-1@pq.test",
      quotaLimit: 2_000_000,
      quotaRemaining: 2_000_000,
      tokens: { access_token: "x", credits_remaining: 2_000_000, credits_limit: 2_000_000 },
    });
    const remaining = await pool.decrementQuota(id, 500_000);
    expect(remaining).toBe(1_500_000);
    const tokens = (await getAccount(id))?.tokens as Record<string, unknown>;
    expect(tokens.credits_remaining).toBe(1_500_000);
    // Other token fields are preserved.
    expect(tokens.access_token).toBe("x");
    expect(tokens.credits_limit).toBe(2_000_000);
  });

  test("decrementQuota floors fractional sync values to an integer", async () => {
    const id = await insertAccount({
      email: "sync-2@pq.test",
      quotaLimit: 100,
      quotaRemaining: 10.6,
      tokens: { credits_remaining: 10 },
    });
    // remaining after debit = MAX(0, 10.6 - 0.4) = 10.2 → sync floor → 10
    await pool.decrementQuota(id, 0.4);
    const tokens = (await getAccount(id))?.tokens as Record<string, unknown>;
    expect(Number.isInteger(tokens.credits_remaining)).toBe(true);
    expect(tokens.credits_remaining).toBe(10);
  });

  test("is a no-op when tokens blob has no numeric credits_remaining", async () => {
    const id = await insertAccount({
      email: "sync-3@pq.test",
      quotaLimit: 100,
      quotaRemaining: 50,
      tokens: { access_token: "tok" }, // no credits_remaining
    });
    await pool.decrementQuota(id, 10);
    const tokens = (await getAccount(id))?.tokens as Record<string, unknown>;
    expect(tokens.credits_remaining).toBeUndefined();
    expect(tokens.access_token).toBe("tok");
  });

  test("is a no-op when tokens is null", async () => {
    const id = await insertAccount({
      email: "sync-4@pq.test",
      quotaLimit: 100,
      quotaRemaining: 50,
      tokens: null,
    });
    await pool.decrementQuota(id, 10);
    expect(Number((await getAccount(id))?.quotaRemaining)).toBe(40);
    expect((await getAccount(id))?.tokens).toBeNull();
  });

  test("does not rewrite tokens when credits_remaining already matches (floor-equal)", async () => {
    // credits_remaining 20.4 → floor 20. Debit 50→40 then sync target 40 ≠ 20,
    // so it WILL update. Instead verify the *skip* path: set credits_remaining
    // already equal to the post-debit floor so no write happens.
    const id = await insertAccount({
      email: "sync-5@pq.test",
      quotaLimit: 100,
      quotaRemaining: 60,
      tokens: { access_token: "keep", credits_remaining: 40.9 }, // floor 40
    });
    await pool.decrementQuota(id, 20); // remaining 60→40, floor(40)=40 === floor(40.9)
    const tokens = (await getAccount(id))?.tokens as Record<string, unknown>;
    // Unchanged because floor values matched — still the original fractional value.
    expect(tokens.credits_remaining).toBe(40.9);
    expect(tokens.access_token).toBe("keep");
  });

  test("applyQuotaSnapshot also syncs tokens.credits_remaining", async () => {
    const id = await insertAccount({
      email: "sync-6@pq.test",
      quotaLimit: 1000,
      quotaRemaining: 800,
      tokens: { credits_remaining: 800, note: "preserve-me" },
    });
    await pool.applyQuotaSnapshot(id, { quotaRemaining: 123 });
    const tokens = (await getAccount(id))?.tokens as Record<string, unknown>;
    expect(tokens.credits_remaining).toBe(123);
    expect(tokens.note).toBe("preserve-me");
  });

  test("clamps a negative sync target to 0 and never writes negative credits_remaining", async () => {
    const id = await insertAccount({
      email: "sync-7@pq.test",
      quotaLimit: 100,
      quotaRemaining: 3,
      tokens: { credits_remaining: 3 },
    });
    // Debit past zero → remaining clamps to 0 → sync target floor(0)=0.
    await pool.decrementQuota(id, 50);
    const tokens = (await getAccount(id))?.tokens as Record<string, unknown>;
    expect(tokens.credits_remaining).toBe(0);
  });
});
