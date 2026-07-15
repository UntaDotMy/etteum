import { describe, expect, test } from "bun:test";
import {
  sumProviderFleetCredits,
  weeklyAverageRemaining,
} from "../../dashboard/src/lib/provider-credits";

describe("sumProviderFleetCredits", () => {
  test("exhausted remaining=0 lowers weekly average (not active-only 100/100)", () => {
    const rows = [
      ...Array.from({ length: 26 }, () => ({
        enabled: true,
        status: "active",
        quotaLimit: 100,
        quotaRemaining: 100,
      })),
      ...Array.from({ length: 4 }, () => ({
        enabled: true,
        status: "exhausted",
        quotaLimit: 100,
        quotaRemaining: 0,
      })),
    ];
    const t = sumProviderFleetCredits(rows);
    expect(t.weeklyPercentScale).toBe(true);
    expect(t.fleetCount).toBe(30);
    expect(t.remaining).toBe(26 * 100);
    expect(t.limit).toBe(30 * 100);
    // 2600/3000 → 86.67 average on 0–100 scale
    expect(weeklyAverageRemaining(t)).toBeCloseTo(86.666, 2);
  });

  test("error rows do not inflate remaining or limit", () => {
    const t = sumProviderFleetCredits([
      {
        enabled: true,
        status: "active",
        quotaLimit: 100,
        quotaRemaining: 100,
      },
      {
        enabled: true,
        status: "error",
        quotaLimit: 100,
        quotaRemaining: 100,
      },
    ]);
    expect(t.fleetCount).toBe(1);
    expect(t.remaining).toBe(100);
    expect(t.limit).toBe(100);
    expect(weeklyAverageRemaining(t)).toBe(100);
  });

  test("disabled accounts are ignored", () => {
    const t = sumProviderFleetCredits([
      {
        enabled: false,
        status: "active",
        quotaLimit: 100,
        quotaRemaining: 100,
      },
      {
        enabled: true,
        status: "active",
        quotaLimit: 100,
        quotaRemaining: 50,
      },
    ]);
    expect(t.remaining).toBe(50);
    expect(t.limit).toBe(100);
  });

  test("absolute token packages still sum correctly", () => {
    const rows = [
      ...Array.from({ length: 30 }, () => ({
        enabled: true,
        status: "active",
        quotaLimit: 2_000_000,
        quotaRemaining: 2_000_000,
      })),
      ...Array.from({ length: 4 }, () => ({
        enabled: true,
        status: "exhausted",
        quotaLimit: 2_000_000,
        quotaRemaining: 0,
      })),
    ];
    const t = sumProviderFleetCredits(rows);
    expect(t.weeklyPercentScale).toBe(false);
    expect(t.remaining).toBe(30 * 2_000_000);
    expect(t.limit).toBe(34 * 2_000_000);
  });
});
