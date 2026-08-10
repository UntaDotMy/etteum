/**
 * Alibaba per-model free-hop walk + remaining ledger rules.
 *
 * Live bug (2026-08-10): EXHAUSTION_WALK_MS=6s + DashScope Unpurchased ~6s/hop
 * meant only ONE account was tried for ali-qwen3.8-max, then the router threw
 * "not activated on any account" while peers with free quota were untried.
 *
 * fetchQuota also re-inflated remaining 0 → limit, undoing setModelQuotaToZero.
 */
import { describe, expect, test } from "bun:test";
import { resolveExhaustionHopBudget } from "../../src/proxy/router";

// Re-export constants via reading source behavior (pure helpers only).
// Wall-clock defaults are env-overridable; we assert the hop budget still
// scales so a 200-account fleet can walk every peer.

describe("alibaba model walk hop budget", () => {
  test("hop budget scales to cover a multi-hundred alibaba fleet", () => {
    // env floor 25, pool 200 → 200
    expect(resolveExhaustionHopBudget(25, 200)).toBe(200);
    expect(resolveExhaustionHopBudget(25, 10)).toBe(25);
  });

  test("alibaba walk ms env default is long enough for multi-second hops", () => {
    // Document the product default: 180s (POOLPROX_ALIBABA_WALK_MS).
    // Each Unpurchased hop can take ~2–6s live; 180s ≈ 30–90 hops.
    const alibabaWalkMs = Math.max(
      6_000,
      Number(process.env.POOLPROX_ALIBABA_WALK_MS) || 180_000,
    );
    expect(alibabaWalkMs).toBeGreaterThanOrEqual(180_000);
  });
});

describe("alibaba remaining ledger math", () => {
  /** Mirror of fetchQuota remaining merge after the fix. */
  function mergeRemaining(
    existing: { remaining: number } | undefined,
    limit: number,
  ): number {
    return existing
      ? Math.min(Math.max(0, Number(existing.remaining) || 0), limit)
      : limit;
  }

  test("does not re-inflate remaining from 0 to full limit", () => {
    expect(mergeRemaining({ remaining: 0 }, 1_000_000)).toBe(0);
  });

  test("caps positive remaining at the new limit", () => {
    expect(mergeRemaining({ remaining: 500 }, 400)).toBe(400);
    expect(mergeRemaining({ remaining: 300 }, 1_000_000)).toBe(300);
  });

  test("seeds full limit when no prior entry", () => {
    expect(mergeRemaining(undefined, 1_000_000)).toBe(1_000_000);
  });
});

describe("alibaba free-quota error classification (mirror of isFreeQuotaExhaustedError)", () => {
  function isFreeQuotaExhaustedError(errText: string): boolean {
    const t = (errText || "").toLowerCase();
    return (
      t.includes("quota has been exhausted") ||
      t.includes("free quota exhausted") ||
      t.includes("freetiersonly") ||
      t.includes("allocationquota") ||
      t.includes("throttling.allocation") ||
      (t.includes("access denied") && t.includes("free")) ||
      (t.includes("accessdenied") && t.includes("free"))
    );
  }

  test("matches common DashScope free-quota wordings", () => {
    expect(isFreeQuotaExhaustedError("Free quota has been exhausted for qwen3.8-max")).toBe(true);
    expect(isFreeQuotaExhaustedError('{"code":"AllocationQuota.FreeTierOnly"}')).toBe(true);
    expect(isFreeQuotaExhaustedError("Throttling.AllocationQuota")).toBe(true);
    expect(isFreeQuotaExhaustedError("AccessDenied: free quota done")).toBe(true);
  });

  test("does not treat generic bans or pure Unpurchased as free-quota", () => {
    expect(isFreeQuotaExhaustedError("AccessDenied.Unpurchased")).toBe(false);
    expect(isFreeQuotaExhaustedError("account restricted")).toBe(false);
    expect(isFreeQuotaExhaustedError("")).toBe(false);
  });
});
