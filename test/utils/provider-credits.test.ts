import { describe, expect, test } from "bun:test";
import { sumProviderFleetCredits } from "../../dashboard/src/lib/provider-credits";

describe("sumProviderFleetCredits", () => {
  test("remaining is active-only; total is all enabled package (30 active + 211 error)", () => {
    const rows = [
      ...Array.from({ length: 30 }, () => ({
        enabled: true,
        status: "active",
        quotaLimit: 2_000_000,
        quotaRemaining: 2_000_000,
      })),
      ...Array.from({ length: 211 }, () => ({
        enabled: true,
        status: "error",
        quotaLimit: 2_000_000,
        quotaRemaining: 2_000_000,
      })),
    ];
    const t = sumProviderFleetCredits(rows);
    // remaining / all-total  →  60M / 482M  (not 60/60 and not 482/482)
    expect(t.remaining).toBe(30 * 2_000_000);
    expect(t.limit).toBe(241 * 2_000_000);
    expect(t.used).toBe(211 * 2_000_000);
    expect(t.weeklyPercentScale).toBe(false);
  });

  test("weekly percent fleet flags weeklyPercentScale for Grok CLI pool display", () => {
    const rows = [
      ...Array.from({ length: 30 }, () => ({
        enabled: true,
        status: "active",
        quotaLimit: 100,
        quotaRemaining: 96,
      })),
      ...Array.from({ length: 10 }, () => ({
        enabled: true,
        status: "error",
        quotaLimit: 100,
        quotaRemaining: 100,
      })),
    ];
    const t = sumProviderFleetCredits(rows);
    expect(t.weeklyPercentScale).toBe(true);
    expect(t.remaining).toBe(30 * 96);
    expect(t.limit).toBe(40 * 100);
  });

  test("partial burn on active still uses all-enabled package as total", () => {
    const t = sumProviderFleetCredits([
      {
        enabled: true,
        status: "active",
        quotaLimit: 2_000_000,
        quotaRemaining: 500_000,
      },
      {
        enabled: true,
        status: "exhausted",
        quotaLimit: 2_000_000,
        quotaRemaining: 0,
      },
      {
        enabled: true,
        status: "error",
        quotaLimit: 2_000_000,
        quotaRemaining: 2_000_000,
      },
    ]);
    expect(t.limit).toBe(6_000_000);
    expect(t.remaining).toBe(500_000);
    expect(t.used).toBe(5_500_000);
  });

  test("disabled accounts are ignored for both sides", () => {
    const t = sumProviderFleetCredits([
      {
        enabled: false,
        status: "active",
        quotaLimit: 2_000_000,
        quotaRemaining: 2_000_000,
      },
      {
        enabled: true,
        status: "active",
        quotaLimit: 1_000_000,
        quotaRemaining: 250_000,
      },
    ]);
    expect(t.limit).toBe(1_000_000);
    expect(t.remaining).toBe(250_000);
  });
});
