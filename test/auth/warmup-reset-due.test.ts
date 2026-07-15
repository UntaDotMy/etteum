/**
 * Reset-window warmup selection: past quotaResetAt must not re-queue forever.
 */
import { describe, expect, test } from "bun:test";
import { isAccountDueForResetWarmup } from "../../src/auth/warmup-queue";

describe("isAccountDueForResetWarmup", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const leadMs = 5 * 60 * 1000;

  test("null / missing reset → not due", () => {
    expect(isAccountDueForResetWarmup(null, null, now, leadMs)).toBe(false);
    expect(isAccountDueForResetWarmup(undefined, {}, now, leadMs)).toBe(false);
  });

  test("reset far in the future → not due", () => {
    const far = new Date(now + 60 * 60 * 1000);
    expect(isAccountDueForResetWarmup(far, null, now, leadMs)).toBe(false);
  });

  test("reset inside lead window → due when never pinged", () => {
    const soon = new Date(now + 2 * 60 * 1000);
    expect(isAccountDueForResetWarmup(soon, null, now, leadMs)).toBe(true);
  });

  test("reset already past → due when never pinged (needs re-probe)", () => {
    const past = new Date(now - 60 * 60 * 1000);
    expect(isAccountDueForResetWarmup(past, {}, now, leadMs)).toBe(true);
  });

  test("already pinged for this reset boundary → not due (stops infinite re-queue)", () => {
    const past = new Date(now - 60 * 60 * 1000);
    const meta = {
      warmup: {
        lastPingedResetAt: past.toISOString(),
        lastCheckedAt: new Date(now - 1000).toISOString(),
      },
    };
    expect(isAccountDueForResetWarmup(past, meta, now, leadMs)).toBe(false);
    // JSON string form (as stored in sqlite sometimes)
    expect(
      isAccountDueForResetWarmup(past, JSON.stringify(meta), now, leadMs),
    ).toBe(false);
  });

  test("new future reset boundary after prior ping → due again when window arrives", () => {
    const oldReset = new Date(now - 24 * 60 * 60 * 1000);
    const newReset = new Date(now + 60 * 1000); // inside lead
    const meta = {
      warmup: { lastPingedResetAt: oldReset.toISOString() },
    };
    expect(isAccountDueForResetWarmup(newReset, meta, now, leadMs)).toBe(true);
  });
});
