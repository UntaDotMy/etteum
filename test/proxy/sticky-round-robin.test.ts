import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import { pool } from "../../src/proxy/pool";

/**
 * Sticky round-robin characterization test.
 *
 * Locks the contract: an account is re-used for up to STICKY_MAX_CONSECUTIVE
 * consecutive requests before the selector rotates to the next eligible
 * account, and the consecutiveUseCount column tracks that. Mirrors the
 * reference proxy consecutiveUseCount rotation.
 *
 * Uses a throwaway provider tag ("stickytest") so it never collides with real
 * accounts; the pool's fetchActiveAccounts filters by provider+status=active,
 * so inserting active accounts for this tag is enough to drive getNextAccount.
 */
const TEST_PROVIDER = "stickytest" as any;

async function insertActive(email: string, priority = 0): Promise<void> {
  await db.insert(accounts).values({
    provider: TEST_PROVIDER,
    email,
    password: encrypt("irrelevant"),
    status: "active",
    enabled: true,
    priority,
    consecutiveUseCount: 0,
  });
}

async function allEmailsOrdered(): Promise<{ email: string; count: number }[]> {
  const rows = await db
    .select({ email: accounts.email, count: accounts.consecutiveUseCount })
    .from(accounts)
    .where(eq(accounts.provider, TEST_PROVIDER))
    .orderBy(accounts.priority, accounts.lastUsedAt);
  return rows.map((r) => ({ email: r.email, count: Number(r.count || 0) }));
}

describe("Sticky round-robin (consecutiveUseCount)", () => {
  beforeEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, TEST_PROVIDER));
    pool.invalidate(TEST_PROVIDER);
  });

  afterEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, TEST_PROVIDER));
    pool.invalidate(TEST_PROVIDER);
  });

  it("re-uses the same account until the stickiness threshold, then rotates", async () => {
    await insertActive("a@sticky.test");
    await insertActive("b@sticky.test");
    pool.invalidate(TEST_PROVIDER);

    // First pick seeds the sticky session.
    const first = await pool.getNextAccount(TEST_PROVIDER);
    expect(first).not.toBeNull();
    const firstEmail = first!.email;
    await pool.markUsed(first!.id);
    pool.invalidate(TEST_PROVIDER);

    // Subsequent picks within the threshold MUST stick to the same account.
    // STICKY_MAX_CONSECUTIVE is 3 in pool.ts; the first use above counts as 1,
    // so picks 2 and 3 should still return the same account (count 1 < 3, 2 < 3).
    let prevEmail = firstEmail;
    for (let i = 0; i < 2; i++) {
      const pick = await pool.getNextAccount(TEST_PROVIDER);
      expect(pick).not.toBeNull();
      expect(pick!.email).toBe(prevEmail);
      await pool.markUsed(pick!.id);
      pool.invalidate(TEST_PROVIDER);
      prevEmail = pick!.email;
    }

    // After STICKY_MAX_CONSECUTIVE uses, the next pick should rotate to a
    // different account (the sticky account's count has hit the threshold).
    const afterThreshold = await pool.getNextAccount(TEST_PROVIDER);
    expect(afterThreshold).not.toBeNull();
    expect(afterThreshold!.email).not.toBe(firstEmail);

    // The rotated-to account starts a fresh sticky session (count begins at 0
    // because markUsed reset siblings, then increments to 1 on its first use).
    await pool.markUsed(afterThreshold!.id);
    pool.invalidate(TEST_PROVIDER);
    const state = await allEmailsOrdered();
    const rotated = state.find((s) => s.email === afterThreshold!.email);
    expect(rotated?.count).toBe(1);
    // The previously-sticky account's count was reset by markUsed.
    const previous = state.find((s) => s.email === firstEmail);
    expect(previous?.count).toBe(0);
  });

  it("respects provider priority when picking the sticky candidate", async () => {
    // Lower priority = tried first. The higher-priority (lower number) account
    // should be the one that sticks.
    await insertActive("low-prio@sticky.test", 5);
    await insertActive("high-prio@sticky.test", 1);
    pool.invalidate(TEST_PROVIDER);

    const first = await pool.getNextAccount(TEST_PROVIDER);
    expect(first).not.toBeNull();
    expect(first!.email).toBe("high-prio@sticky.test");
  });
});
