/**
 * Grok free-usage / credit decline must mark accounts exhausted — not
 * temporary rate-limit cooldowns that re-select the same dead credentials.
 *
 * Free Build quota is absolute tokens (~2e6); creditRate must be 1 so each
 * request decrements quotaRemaining by totalTokens (not totalTokens/1000).
 */
import { describe, test, expect } from "bun:test";
import {
  classifyGrokUpstreamError,
  isGrokCreditExhaustedError,
  GrokProvider,
} from "../../src/proxy/providers/grok/index";
import {
  isAbsoluteGrokOAuthQuota,
  selectGrokOAuthQuota,
  type GrokOAuthQuota,
} from "../../src/proxy/providers/grok/oauth";
import { classifyError } from "../../src/proxy/error-rules";
import { mapHealthToAccountUpdate } from "../../src/auth/warmup-runner";
import type { Account } from "../../src/db/schema";

const FREE_USAGE_429 =
  'cli-chat-proxy error 429: {"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage"}';

describe("isGrokCreditExhaustedError", () => {
  test("detects subscription:free-usage-exhausted on HTTP 429 body", () => {
    expect(isGrokCreditExhaustedError(FREE_USAGE_429)).toBe(true);
  });

  test("detects 402 / spending-limit", () => {
    expect(isGrokCreditExhaustedError("cli-chat-proxy error 402: spending-limit")).toBe(true);
  });

  test("does not treat plain rate limit as exhaustion", () => {
    expect(isGrokCreditExhaustedError("rate_limited: HTTP 429 too many requests")).toBe(false);
  });
});

describe("classifyGrokUpstreamError", () => {
  test("free-usage-exhausted → quotaExhausted, not rateLimited", () => {
    const r = classifyGrokUpstreamError(new Error(FREE_USAGE_429));
    expect(r.success).toBe(false);
    expect(r.quotaExhausted).toBe(true);
    expect(r.rateLimited).toBeUndefined();
    expect(r.error).toMatch(/quota_exhausted/i);
  });

  test("plain 429 stays rateLimited", () => {
    const r = classifyGrokUpstreamError(new Error("rate_limited: HTTP 429"));
    expect(r.success).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(r.quotaExhausted).toBeUndefined();
  });

  test("402 spending-limit → quotaExhausted", () => {
    const r = classifyGrokUpstreamError(
      new Error('cli-chat-proxy error 402: {"code":"spending-limit"}'),
    );
    expect(r.quotaExhausted).toBe(true);
    expect(r.rateLimited).toBeUndefined();
  });

  test("quota_remaining zero path text → quotaExhausted", () => {
    const r = classifyGrokUpstreamError(new Error("quota_exhausted: credits drained"));
    expect(r.quotaExhausted).toBe(true);
  });
});

describe("error-rules free-usage-exhausted", () => {
  test("classifies free-usage-exhausted as permanent (not rateLimit)", () => {
    const rule = classifyError(429, FREE_USAGE_429);
    expect(rule?.id).toBe("quota-exhausted");
    expect(rule?.kind).toBe("permanent");
  });

  test("plain 429 is still rateLimit", () => {
    const rule = classifyError(429, "rate_limited: HTTP 429 too many requests");
    expect(rule?.kind).toBe("rateLimit");
  });
});

describe("Grok free Build credit accounting", () => {
  const grok = new GrokProvider();

  test("models debit 1 credit per token (absolute free Build budget)", () => {
    for (const id of ["grok-4.5", "grok-4.5-reasoning", "composer-2.5"]) {
      expect(grok.getProviderCreditRate(id)).toBe(1);
      expect(grok.getProviderCreditUnit(id)).toBe("token");
    }
  });

  test("628623 tokens → 628623 credits (not ~628 from rate 1/1000)", () => {
    const totalTokens = 628_623;
    const creditsUsed = Math.max(0.01, totalTokens * grok.getProviderCreditRate("grok-4.5"));
    expect(creditsUsed).toBe(628_623);
    // Old default rate 1/1000 would under-count by 1000×
    expect(creditsUsed).not.toBeCloseTo(totalTokens / 1000, 0);
  });
});

describe("Grok warmup live credit probe policy", () => {
  test("absolute free Build quota is preferred over percent-scale 100", () => {
    const absolute: GrokOAuthQuota = {
      limit: 2_000_000,
      remaining: 1_250_000,
      used: 750_000,
      resetAt: null,
      source: "cli-chat-proxy/ratelimit-headers",
      percentScale: false,
    };
    const percent: GrokOAuthQuota = {
      limit: 100,
      remaining: 100,
      used: 0,
      resetAt: null,
      source: "grok.com/GetGrokCreditsConfig",
      percentScale: true,
    };
    expect(isAbsoluteGrokOAuthQuota(absolute)).toBe(true);
    expect(isAbsoluteGrokOAuthQuota(percent)).toBe(false);
    const picked = selectGrokOAuthQuota(null, absolute, percent);
    expect(picked?.remaining).toBe(1_250_000);
    expect(picked?.source).toBe("cli-chat-proxy/ratelimit-headers");
  });

  test("warmup writes live ratelimit remaining (not stored-farm full 2M)", () => {
    const account = {
      id: 1,
      provider: "grok",
      email: "t@oauth",
      status: "active",
      quotaLimit: 2_000_000,
      // Stale "full" snapshot that inflated the dashboard to 290M
      quotaRemaining: 2_000_000,
      tokens: { auth_method: "oauth", credits_limit: 2_000_000, credits_remaining: 2_000_000 },
    } as unknown as Account;

    const update = mapHealthToAccountUpdate(account, {
      kind: "healthy",
      success: true,
      quota: {
        limit: 2_000_000,
        remaining: 1_100_000,
        used: 900_000,
        resetAt: null,
        source: "cli-chat-proxy/ratelimit-headers",
      },
      tokens: {
        auth_method: "oauth",
        credits_limit: 2_000_000,
        credits_remaining: 1_100_000,
      },
    });

    expect(update.quotaLimit).toBe(2_000_000);
    // min(db 2M, live 1.1M) → live
    expect(update.quotaRemaining).toBe(1_100_000);
    expect((update.tokens as any)?.credits_remaining).toBe(1_100_000);
  });

  test("stored-farm-credits is ignored as non-authoritative warmup source", () => {
    const account = {
      id: 2,
      provider: "grok",
      email: "t2@oauth",
      status: "active",
      quotaLimit: 2_000_000,
      quotaRemaining: 500_000,
      tokens: null,
    } as unknown as Account;

    const update = mapHealthToAccountUpdate(account, {
      kind: "healthy",
      success: true,
      quota: {
        limit: 2_000_000,
        remaining: 2_000_000,
        used: 0,
        resetAt: null,
        source: "stored-farm-credits",
      },
    });

    // Fallback source: must not re-inflate remaining to full 2M
    expect(update.quotaRemaining).toBeUndefined();
    expect(update.quotaLimit).toBeUndefined();
  });

  test("free-usage-exhausted health zeros remaining and marks exhausted", () => {
    const account = {
      id: 3,
      provider: "grok",
      email: "t3@oauth",
      status: "active",
      quotaLimit: 2_000_000,
      quotaRemaining: 2_000_000,
      tokens: null,
    } as unknown as Account;

    const update = mapHealthToAccountUpdate(account, {
      kind: "exhausted",
      success: true,
      quota: {
        limit: 2_000_000,
        remaining: 0,
        used: 2_000_000,
        resetAt: null,
        source: "cli-chat-proxy/free-usage-exhausted",
      },
    });

    expect(update.status).toBe("exhausted");
    expect(update.quotaRemaining).toBe(0);
  });
});
