import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index";
import { apiKeys } from "../../src/db/schema";
import { checkKeyAccess, isExpired } from "../../src/proxy/friend-keys";

/**
 * Regression: friend-key token quota must deny access once tokens_used >= token_quota.
 * handleChatCompletion calls checkKeyAccess via assertFriendKeyLimits on every
 * completion path (/v1/chat/completions, /v1/messages, /v1/responses).
 */
describe("friend-key token quota", () => {
  const createdIds: number[] = [];

  afterAll(async () => {
    for (const id of createdIds) {
      try {
        await db.delete(apiKeys).where(eq(apiKeys.id, id));
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  async function insertKey(partial: {
    tokenQuota?: number | null;
    tokensUsed?: number;
    isActive?: boolean;
    expiresAt?: Date | null;
  }) {
    const key = `sk-pool-test-quota-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [row] = await db
      .insert(apiKeys)
      .values({
        key,
        name: "quota-unit-test",
        isActive: partial.isActive ?? true,
        tokenQuota: partial.tokenQuota === undefined ? null : partial.tokenQuota,
        tokensUsed: partial.tokensUsed ?? 0,
        expiresAt: partial.expiresAt ?? null,
      })
      .returning();
    createdIds.push(row!.id);
    return row;
  }

  test("isExpired is false without expiry and true when past", () => {
    expect(isExpired(null)).toBe(false);
    expect(isExpired(undefined)).toBe(false);
    expect(isExpired(new Date(Date.now() + 60_000))).toBe(false);
    expect(isExpired(new Date(Date.now() - 1000))).toBe(true);
  });

  test("null tokenQuota never exhausts (unlimited)", async () => {
    const row = await insertKey({ tokenQuota: null, tokensUsed: 9_999_999 });
    const access = await checkKeyAccess(row!.id);
    expect(access.allowed).toBe(true);
  });

  test("tokensUsed below quota is allowed", async () => {
    const row = await insertKey({ tokenQuota: 1000, tokensUsed: 999 });
    const access = await checkKeyAccess(row!.id);
    expect(access.allowed).toBe(true);
  });

  test("tokensUsed equal to quota is exhausted", async () => {
    const row = await insertKey({ tokenQuota: 1000, tokensUsed: 1000 });
    const access = await checkKeyAccess(row!.id);
    expect(access).toEqual({ allowed: false, reason: "quota_exhausted" });
  });

  test("tokensUsed above quota is exhausted", async () => {
    const row = await insertKey({ tokenQuota: 100, tokensUsed: 150 });
    const access = await checkKeyAccess(row!.id);
    expect(access).toEqual({ allowed: false, reason: "quota_exhausted" });
  });

  test("inactive outranks quota", async () => {
    const row = await insertKey({ tokenQuota: 100, tokensUsed: 0, isActive: false });
    const access = await checkKeyAccess(row!.id);
    expect(access).toEqual({ allowed: false, reason: "inactive" });
  });

  test("missing key is not_found", async () => {
    const access = await checkKeyAccess(2_147_483_647);
    expect(access).toEqual({ allowed: false, reason: "not_found" });
  });
});
