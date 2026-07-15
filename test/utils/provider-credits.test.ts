import { describe, expect, test } from "bun:test";
import { sumProviderFleetCredits } from "../../dashboard/src/lib/provider-credits";

describe("sumProviderFleetCredits", () => {
  test("excludes error rows so remaining/total is not 241×2M with 30 active", () => {
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
    expect(t.limit).toBe(30 * 2_000_000);
    expect(t.remaining).toBe(30 * 2_000_000);
    expect(t.used).toBe(0);
  });

  test("exhausted keep package in total and zero remaining contribution", () => {
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
    ]);
    expect(t.limit).toBe(4_000_000);
    expect(t.remaining).toBe(500_000);
    expect(t.used).toBe(3_500_000);
  });

  test("disabled accounts are ignored", () => {
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
