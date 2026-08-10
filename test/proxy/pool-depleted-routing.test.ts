/**
 * Depleted / exhausted accounts must not stall round-robin:
 *  - active + remaining<=0 + limit>0 → not selected when a healthy peer exists
 *  - status=exhausted already excluded by fetchActiveAccounts
 *  - excludeAccountIds prevents re-picking the same id on the next attempt
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db/index";
import { accounts } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";
import {
  pool,
  isAccountEligibleForDispatch,
  filterDispatchEligibleAccounts,
} from "../../src/proxy/pool";
import type { Account } from "../../src/db/schema";

const TEST_PROVIDER = "depletedtest" as any;

function fakeAccount(partial: Partial<Account> & { id: number }): Account {
  return {
    provider: "grok",
    email: "x@test",
    password: "",
    status: "active",
    enabled: true,
    tokens: null,
    quotaLimit: 100,
    quotaRemaining: 50,
    quotaResetAt: null,
    freeLimit: null,
    freeRemaining: null,
    freeResetAt: null,
    lastUsed: null,
    lastUsedAt: null,
    errorMessage: null,
    metadata: null,
    consecutiveUseCount: 0,
    consecutiveTransientFailures: 0,
    consecutiveAuthErrors: 0,
    nextBackoffMs: 0,
    cooldownUntil: null,
    priority: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as Account;
}

async function insertRow(opts: {
  email: string;
  status?: string;
  quotaLimit?: number;
  quotaRemaining?: number;
  priority?: number;
  consecutiveUseCount?: number;
}): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: TEST_PROVIDER,
      email: opts.email,
      password: encrypt("irrelevant"),
      status: opts.status ?? "active",
      enabled: true,
      priority: opts.priority ?? 0,
      quotaLimit: opts.quotaLimit ?? 100,
      quotaRemaining: opts.quotaRemaining ?? 50,
      consecutiveUseCount: opts.consecutiveUseCount ?? 0,
    })
    .returning({ id: accounts.id });
  return row!.id;
}

describe("isAccountEligibleForDispatch", () => {
  it("allows unknown budget (limit 0 / missing)", () => {
    expect(isAccountEligibleForDispatch(fakeAccount({ id: 1, quotaLimit: 0, quotaRemaining: 0 }))).toBe(
      true,
    );
    expect(
      isAccountEligibleForDispatch(fakeAccount({ id: 2, quotaLimit: null as any, quotaRemaining: 0 })),
    ).toBe(true);
  });

  it("rejects known-depleted package (limit>0 remaining<=0)", () => {
    expect(
      isAccountEligibleForDispatch(fakeAccount({ id: 3, quotaLimit: 100, quotaRemaining: 0 })),
    ).toBe(false);
    expect(
      isAccountEligibleForDispatch(fakeAccount({ id: 4, quotaLimit: 2_000_000, quotaRemaining: 0 })),
    ).toBe(false);
  });

  it("allows positive remaining", () => {
    expect(
      isAccountEligibleForDispatch(fakeAccount({ id: 5, quotaLimit: 100, quotaRemaining: 1 })),
    ).toBe(true);
  });
});

describe("filterDispatchEligibleAccounts", () => {
  it("drops depleted and excluded ids", () => {
    const healthy = fakeAccount({ id: 10, quotaLimit: 100, quotaRemaining: 40 });
    const depleted = fakeAccount({ id: 11, quotaLimit: 100, quotaRemaining: 0 });
    const other = fakeAccount({ id: 12, quotaLimit: 100, quotaRemaining: 10 });
    const out = filterDispatchEligibleAccounts([healthy, depleted, other], new Set([12]));
    expect(out.map((a) => a.id)).toEqual([10]);
  });
});

describe("pool.getNextAccount depleted skip + exclude", () => {
  beforeEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, TEST_PROVIDER));
    pool.invalidate(TEST_PROVIDER);
  });

  afterEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, TEST_PROVIDER));
    pool.invalidate(TEST_PROVIDER);
  });

  it("prefers healthy peer over active depleted (remaining=0 limit>0)", async () => {
    // Depleted sticky candidate: high consecutive count would not matter —
    // depleted must never win when a peer has remaining.
    await insertRow({
      email: "dead@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 0,
      priority: 0,
      consecutiveUseCount: 0,
    });
    const healthyId = await insertRow({
      email: "live@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 80,
      priority: 1,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick).not.toBeNull();
    expect(pick!.id).toBe(healthyId);
    expect(pick!.email).toBe("live@depleted.test");
  });

  it("excludes status=exhausted from selection", async () => {
    await insertRow({
      email: "exh@depleted.test",
      status: "exhausted",
      quotaLimit: 100,
      quotaRemaining: 0,
    });
    const healthyId = await insertRow({
      email: "ok@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 50,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick?.id).toBe(healthyId);
  });

  it("excludeAccountIds prevents re-picking the same id (retry loop)", async () => {
    const a = await insertRow({
      email: "a@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 50,
      priority: 0,
    });
    const b = await insertRow({
      email: "b@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 50,
      priority: 1,
    });
    pool.invalidate(TEST_PROVIDER);

    const first = await pool.getNextAccount(TEST_PROVIDER);
    expect(first).not.toBeNull();
    // Simulate in-loop exclusion after first attempt failed (e.g. markExhausted)
    const second = await pool.getNextAccount(TEST_PROVIDER, {
      excludeAccountIds: new Set([first!.id]),
    });
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect([a, b]).toContain(second!.id);
  });

  it("returns null when all active rows are known-depleted (fail fast)", async () => {
    await insertRow({
      email: "d1@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 0,
    });
    await insertRow({
      email: "d2@depleted.test",
      quotaLimit: 50,
      quotaRemaining: 0,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick).toBeNull();
  });

  it("getNextAccountForModel honors exclude + depleted filter", async () => {
    const dead = await insertRow({
      email: "dead-m@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 0,
    });
    const live = await insertRow({
      email: "live-m@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 20,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccountForModel(TEST_PROVIDER, "any-model", {
      excludeAccountIds: new Set([dead]),
    });
    expect(pick?.id).toBe(live);

    const afterExcludeLive = await pool.getNextAccountForModel(TEST_PROVIDER, "any-model", {
      excludeAccountIds: new Set([live]),
    });
    // live excluded; dead is depleted → null (not re-hit dead)
    expect(afterExcludeLive).toBeNull();
  });

  it("preferred depleted account is ignored when healthy peer exists", async () => {
    const depletedId = await insertRow({
      email: "pref-dead@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 0,
      priority: 0,
    });
    const healthyId = await insertRow({
      email: "pref-live@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 99,
      priority: 5,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER, {
      preferredAccountId: depletedId,
    });
    expect(pick?.id).toBe(healthyId);
  });

  it("falls back to an active row parked in cooldown when nothing else exists (no lockout)", async () => {
    // Single-account pool that just got rate-limited: cooldownUntil in the
    // future. Without the fallback, the account is invisible to dispatch and
    // the pool returns null → "No active accounts available" lockout.
    const [row] = await db
      .insert(accounts)
      .values({
        provider: TEST_PROVIDER,
        email: "only-cooling@depleted.test",
        password: encrypt("irrelevant"),
        status: "active",
        enabled: true,
        quotaLimit: 100,
        quotaRemaining: 50,
        cooldownUntil: new Date(Date.now() + 60_000),
      })
      .returning({ id: accounts.id });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick?.id).toBe(row!.id);
  });

  it("prefers a healthy peer over a cooling-down row", async () => {
    const [cooling] = await db
      .insert(accounts)
      .values({
        provider: TEST_PROVIDER,
        email: "cooling@depleted.test",
        password: encrypt("irrelevant"),
        status: "active",
        enabled: true,
        quotaLimit: 100,
        quotaRemaining: 50,
        priority: 0,
        cooldownUntil: new Date(Date.now() + 60_000),
      })
      .returning({ id: accounts.id });
    const healthyId = await insertRow({
      email: "healthy@depleted.test",
      quotaLimit: 100,
      quotaRemaining: 50,
      priority: 5,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick?.id).toBe(healthyId);
    expect(pick?.id).not.toBe(cooling!.id);
  });
});

// ── Alibaba per-model drain drop (quota-403 evidence) ───────────────────────

describe("alibaba getNextAccountForModel drops per-model drained accounts", () => {
  const MODEL = "qwen3.8-max";
  const ALI_PROVIDER = "alibaba" as any;

  async function insertAliRow(email: string, tokens: unknown): Promise<number> {
    const [row] = await db
      .insert(accounts)
      .values({
        provider: ALI_PROVIDER,
        email,
        password: encrypt("sk-test"),
        status: "active",
        enabled: true,
        quotaLimit: 0,
        quotaRemaining: 0,
        tokens: tokens as never,
      })
      .returning({ id: accounts.id });
    return row!.id;
  }

  beforeEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, ALI_PROVIDER));
    pool.invalidate(ALI_PROVIDER);
  });

  afterEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, ALI_PROVIDER));
    pool.invalidate(ALI_PROVIDER);
  });

  it("never re-dispatches an account proven drained for the requested model", async () => {
    // Drained FOR THIS MODEL (ledger remaining=0) but healthy everywhere else.
    await insertAliRow("drained-model@ali.test", {
      modelQuotas: { [MODEL]: { limit: 1000, remaining: 0, periodDays: 60, resetAt: null } },
      queryableModels: [MODEL],
      updatedAt: new Date().toISOString(),
    });
    const funded = await insertAliRow("funded@ali.test", {
      modelQuotas: { [MODEL]: { limit: 1000, remaining: 500, periodDays: 60, resetAt: null } },
      queryableModels: [MODEL],
      updatedAt: new Date().toISOString(),
    });
    pool.invalidate(ALI_PROVIDER);

    // Repeat picks: the drained account must NEVER appear, even with sticky
    // re-selection preferring index 0.
    for (let i = 0; i < 5; i++) {
      const pick = await pool.getNextAccountForModel(ALI_PROVIDER, `ali-${MODEL}`);
      expect(pick?.id).toBe(funded);
    }
  });

  it("returns null when every account is drained for the model (fail fast, no 403 walk)", async () => {
    await insertAliRow("d1@ali.test", {
      modelQuotas: { [MODEL]: { limit: 1000, remaining: 0, periodDays: 60, resetAt: null } },
      queryableModels: [MODEL],
      updatedAt: new Date().toISOString(),
    });
    await insertAliRow("d2@ali.test", {
      modelQuotas: { [MODEL]: { limit: 1000, remaining: 0, periodDays: 60, resetAt: null } },
      queryableModels: [MODEL],
      updatedAt: new Date().toISOString(),
    });
    pool.invalidate(ALI_PROVIDER);

    const pick = await pool.getNextAccountForModel(ALI_PROVIDER, `ali-${MODEL}`);
    expect(pick).toBeNull();
  });

  it("un-probed accounts (no ledger entry) stay dispatchable", async () => {
    const fresh = await insertAliRow("fresh@ali.test", {
      modelQuotas: {},
      queryableModels: [],
      updatedAt: new Date().toISOString(),
    });
    pool.invalidate(ALI_PROVIDER);

    const pick = await pool.getNextAccountForModel(ALI_PROVIDER, `ali-${MODEL}`);
    expect(pick?.id).toBe(fresh);
  });

  it("drain on one model does not block the account for other models", async () => {
    const acct = await insertAliRow("partial@ali.test", {
      modelQuotas: {
        [MODEL]: { limit: 1000, remaining: 0, periodDays: 60, resetAt: null },
        "glm-5.2": { limit: 2000, remaining: 900, periodDays: 60, resetAt: null },
      },
      queryableModels: [MODEL, "glm-5.2"],
      updatedAt: new Date().toISOString(),
    });
    pool.invalidate(ALI_PROVIDER);

    expect((await pool.getNextAccountForModel(ALI_PROVIDER, `ali-${MODEL}`))?.id).toBeUndefined();
    expect((await pool.getNextAccountForModel(ALI_PROVIDER, "ali-glm-5.2"))?.id).toBe(acct);
  });

  it("prefers probe-confirmed + funded over quotas-API ghost remaining only", async () => {
    // Ghost: quotas API says 1M left but warmup never proved the model works.
    await insertAliRow("ghost@ali.test", {
      modelQuotas: { [MODEL]: { limit: 1_000_000, remaining: 1_000_000, periodDays: 60, resetAt: null } },
      queryableModels: [],
      updatedAt: new Date().toISOString(),
    });
    const probed = await insertAliRow("probed@ali.test", {
      modelQuotas: { [MODEL]: { limit: 1_000_000, remaining: 500_000, periodDays: 60, resetAt: null } },
      queryableModels: [MODEL],
      updatedAt: new Date().toISOString(),
    });
    pool.invalidate(ALI_PROVIDER);

    for (let i = 0; i < 5; i++) {
      const pick = await pool.getNextAccountForModel(ALI_PROVIDER, `ali-${MODEL}`);
      expect(pick?.id).toBe(probed);
    }
  });
});
