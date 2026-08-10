/**
 * Local quota-debit policy: CommandCode / Grok weekly must not local-debit.
 */
import { describe, expect, test } from "bun:test";
import {
  ignoresLocalRemainingForDispatch,
  shouldSkipLocalQuotaDebit,
} from "../../src/proxy/quota-debit-policy";
import { isAccountEligibleForDispatch } from "../../src/proxy/pool";
import type { Account } from "../../src/db/schema";

function fakeAccount(partial: Partial<Account> & { provider: string }): Account {
  return {
    id: 1,
    email: "t@t",
    password: "x",
    status: "active",
    enabled: true,
    quotaLimit: 3,
    quotaRemaining: 0,
    ...partial,
  } as Account;
}

describe("shouldSkipLocalQuotaDebit", () => {
  test("commandcode always skips (upstream USD windows)", () => {
    expect(shouldSkipLocalQuotaDebit("commandcode")).toBe(true);
    expect(shouldSkipLocalQuotaDebit("commandcode", 3)).toBe(true);
    expect(shouldSkipLocalQuotaDebit("commandcode", 2_000_000)).toBe(true);
  });

  test("grok weekly percent (limit 0–100) skips", () => {
    expect(shouldSkipLocalQuotaDebit("grok", 100)).toBe(true);
    expect(shouldSkipLocalQuotaDebit("grok", 50)).toBe(true);
    expect(shouldSkipLocalQuotaDebit("grok", 1)).toBe(true);
  });

  test("grok free-build absolute tokens still debit", () => {
    expect(shouldSkipLocalQuotaDebit("grok", 2_000_000)).toBe(false);
    expect(shouldSkipLocalQuotaDebit("grok", 0)).toBe(false);
    expect(shouldSkipLocalQuotaDebit("grok", null)).toBe(false);
  });

  test("other providers still local-debit", () => {
    expect(shouldSkipLocalQuotaDebit("codex", 100)).toBe(false);
    expect(shouldSkipLocalQuotaDebit("alibaba", 500)).toBe(false);
    expect(shouldSkipLocalQuotaDebit("kiro", 10)).toBe(false);
  });
});

describe("ignoresLocalRemainingForDispatch / isAccountEligibleForDispatch", () => {
  test("commandcode with remaining 0 and positive limit stays dispatch-eligible", () => {
    expect(ignoresLocalRemainingForDispatch("commandcode")).toBe(true);
    const a = fakeAccount({ provider: "commandcode", quotaLimit: 3, quotaRemaining: 0 });
    expect(isAccountEligibleForDispatch(a)).toBe(true);
  });

  test("non-commandcode with remaining 0 and positive limit is ineligible", () => {
    expect(ignoresLocalRemainingForDispatch("codex")).toBe(false);
    const a = fakeAccount({ provider: "codex", quotaLimit: 100, quotaRemaining: 0 });
    expect(isAccountEligibleForDispatch(a)).toBe(false);
  });

  test("non-commandcode with remaining > 0 is eligible", () => {
    const a = fakeAccount({ provider: "codex", quotaLimit: 100, quotaRemaining: 10 });
    expect(isAccountEligibleForDispatch(a)).toBe(true);
  });
});
