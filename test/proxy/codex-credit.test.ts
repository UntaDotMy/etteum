import { describe, expect, test } from "bun:test";
import { parseCodexUsage } from "../../src/proxy/providers/codex";

// Mirrors the real wham/usage response shape (verified against codex-lb /
// Soju06/codex-lb and the Codex CLI). Field names: rate_limit.primary_window /
// secondary_window (used_percent, reset_at epoch seconds), credits
// (has_credits, unlimited, balance), rate_limit_reset_credits.available_count,
// additional_rate_limits.<model>.

describe("parseCodexUsage", () => {
  test("healthy plan account: secondary has headroom -> not exhausted, no override", () => {
    const data = {
      plan_type: "chatgpt_pro",
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 30, reset_at: 1730000000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 40, reset_at: 1730500000, reset_after_seconds: 86400 },
      },
      credits: { has_credits: false, unlimited: false, balance: 0 },
    };
    const u = parseCodexUsage(data);
    expect(u.planType).toBe("chatgpt_pro");
    expect(u.secondaryUsedPercent).toBe(40);
    expect(u.remaining).toBe(60);
    expect(u.creditOverrideActive).toBe(false);
    expect(u.rateLimited).toBe(false);
    expect(u.resetAt).toBeInstanceOf(Date);
  });

  test("exhausted plan, no credits -> exhausted, no override", () => {
    const data = {
      plan_type: "chatgpt_free",
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100, reset_at: 1730000000 },
        secondary_window: { used_percent: 100, reset_at: 1730500000 },
      },
      credits: { has_credits: false, unlimited: false, balance: 0 },
    };
    const u = parseCodexUsage(data);
    expect(u.remaining).toBe(0);
    expect(u.creditOverrideActive).toBe(false);
  });

  test("secondary full BUT credits exist -> credit-override keeps it usable", () => {
    const data = {
      plan_type: "chatgpt_pro",
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100, reset_at: 1730000000 },
        secondary_window: { used_percent: 100, reset_at: 1730500000 },
      },
      credits: { has_credits: true, unlimited: false, balance: 12.5 },
    };
    const u = parseCodexUsage(data);
    expect(u.creditOverrideActive).toBe(true);
    expect(u.remaining).toBe(100); // override restores full headroom
    expect(u.credits.balance).toBe(12.5);
  });

  test("unlimited credits always override", () => {
    const data = {
      plan_type: "chatgpt_team",
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100 },
        secondary_window: { used_percent: 100 },
      },
      credits: { has_credits: true, unlimited: true, balance: 0 },
    };
    expect(parseCodexUsage(data).creditOverrideActive).toBe(true);
  });

  test("rate_limit_reset_credits also enable override", () => {
    const data = {
      plan_type: "chatgpt_pro",
      rate_limit: { limit_reached: true, primary_window: { used_percent: 100 }, secondary_window: { used_percent: 100 } },
      credits: { has_credits: false, unlimited: false, balance: 0 },
      rate_limit_reset_credits: { available_count: 3 },
    };
    expect(parseCodexUsage(data).creditOverrideActive).toBe(true);
    expect(parseCodexUsage(data).rateLimitResetCredits.availableCount).toBe(3);
  });

  test("parses additional_rate_limits per model", () => {
    const data = {
      plan_type: "chatgpt_pro",
      rate_limit: { primary_window: { used_percent: 10 }, secondary_window: { used_percent: 20 } },
      additional_rate_limits: {
        "codex-spark": { used_percent: 55, reset_at: 1730000000 },
      },
    };
    const u = parseCodexUsage(data);
    const spark = u.additionalRateLimits["codex-spark"];
    expect(spark?.usedPercent).toBe(55);
    expect(spark?.resetAt).toBeInstanceOf(Date);
  });

  test("degrades gracefully on empty/malformed payload", () => {
    const u = parseCodexUsage({});
    expect(u.planType).toBe("");
    expect(u.remaining).toBe(100); // nothing used -> full headroom
    expect(u.creditOverrideActive).toBe(false);
    expect(u.credits.balance).toBe(0);
  });

  test("primary full but secondary has headroom -> NOT exhausted (secondary is the ceiling)", () => {
    const data = {
      rate_limit: {
        primary_window: { used_percent: 100 },
        secondary_window: { used_percent: 50 },
      },
    };
    const u = parseCodexUsage(data);
    expect(u.primaryUsedPercent).toBe(100);
    expect(u.secondaryUsedPercent).toBe(50);
    expect(u.remaining).toBe(50);
    expect(u.creditOverrideActive).toBe(false);
  });
});
