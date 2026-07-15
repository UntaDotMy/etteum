/**
 * Grok OAuth billing parsers — real credits, no fake 100 placeholder.
 */
import { describe, test, expect } from "bun:test";
import {
  parseGrokBillingJson,
  parseGrokCreditsProtobuf,
  selectGrokOAuthQuota,
  GROK_FREE_BUILD_TOKEN_LIMIT,
  type GrokOAuthQuota,
} from "../../src/proxy/providers/grok/oauth";

describe("parseGrokBillingJson", () => {
  test("paid monthly pool uses absolute API units (not 100)", () => {
    const q = parseGrokBillingJson({
      config: {
        monthlyLimit: { val: 99900 },
        used: { val: 12345 },
        billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      },
    });
    expect(q).not.toBeNull();
    expect(q!.limit).toBe(99900);
    expect(q!.used).toBe(12345);
    expect(q!.remaining).toBe(99900 - 12345);
    expect(q!.percentScale).toBe(false);
    expect(q!.source).toBe("cli-chat-proxy/billing");
    expect(q!.resetAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  test("free-tier monthlyLimit=0 returns null so caller uses credits-config", () => {
    const q = parseGrokBillingJson({
      config: {
        monthlyLimit: { val: 0 },
        used: { val: 0 },
        billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      },
    });
    expect(q).toBeNull();
  });

  test("missing config returns null", () => {
    expect(parseGrokBillingJson({})).toBeNull();
    expect(parseGrokBillingJson(null)).toBeNull();
  });

  test("used above limit clamps remaining at 0", () => {
    const q = parseGrokBillingJson({
      config: { monthlyLimit: { val: 100 }, used: { val: 150 } },
    });
    expect(q!.remaining).toBe(0);
    expect(q!.used).toBe(150);
  });
});

describe("parseGrokCreditsProtobuf", () => {
  // Live fixture from free OAuth account (GetGrokCreditsConfig, 2026-07-11):
  // period timestamps present, no credit_usage_percent float → 0% used.
  const LIVE_FREE_POOL = Buffer.from(
    "00000000300a2e12001a0022060880a6b6d2062a0608809bdbd2064212080212060880a6b6d2061a0608809bdbd206580162006801800000000f677270632d7374617475733a300d0a",
    "hex",
  );

  test("live free-pool fixture → 0% used on 100-point scale with resetAt", () => {
    const q = parseGrokCreditsProtobuf(new Uint8Array(LIVE_FREE_POOL));
    expect(q).not.toBeNull();
    expect(q!.percentScale).toBe(true);
    expect(q!.limit).toBe(100);
    expect(q!.used).toBe(0);
    expect(q!.remaining).toBe(100);
    expect(q!.source).toBe("grok.com/GetGrokCreditsConfig");
    expect(q!.resetAt).toBeInstanceOf(Date);
    expect(q!.resetAt!.getTime()).toBeGreaterThan(1_700_000_000_000);
  });

  test("empty buffer returns null", () => {
    expect(parseGrokCreditsProtobuf(new Uint8Array())).toBeNull();
  });

  test("fixed32 float percent is recovered when present", () => {
    // Minimal message: field 1 = length-delimited {
    //   field 1 = fixed32 float 25.0 (0x41c80000 LE)
    // }
    // tag field1 wire2 = 0x0a, len 5, tag field1 wire5 = 0x0d, then 4 float bytes
    const float25 = new Uint8Array([0x0a, 0x05, 0x0d, 0x00, 0x00, 0xc8, 0x41]);
    // Also need a period timestamp so we know it's a valid credits payload if
    // percent path needs period — but with fixed32 present we don't need it.
    const q = parseGrokCreditsProtobuf(float25);
    expect(q).not.toBeNull();
    expect(q!.used).toBe(25);
    expect(q!.remaining).toBe(75);
    expect(q!.limit).toBe(100);
  });
});

describe("selectGrokOAuthQuota", () => {
  const paid: GrokOAuthQuota = {
    limit: 99900,
    remaining: 80000,
    used: 19900,
    resetAt: null,
    source: "cli-chat-proxy/billing",
    percentScale: false,
  };
  const absolute: GrokOAuthQuota = {
    limit: 2_000_000,
    remaining: 1_900_000,
    used: 100_000,
    resetAt: null,
    source: "cli-chat-proxy/ratelimit-headers",
    percentScale: false,
  };
  const percent: GrokOAuthQuota = {
    limit: 100,
    remaining: 100,
    used: 0,
    resetAt: new Date("2026-07-15T00:00:00.000Z"),
    source: "grok.com/GetGrokCreditsConfig",
    percentScale: true,
  };

  test("paid absolute pool beats free absolute and percent", () => {
    const q = selectGrokOAuthQuota(paid, absolute, percent);
    expect(q?.source).toBe("cli-chat-proxy/billing");
    expect(q?.limit).toBe(99900);
  });

  test("trusted absolute burn (remaining < limit) beats weekly percent", () => {
    const q = selectGrokOAuthQuota(null, absolute, percent);
    expect(q?.source).toBe("cli-chat-proxy/ratelimit-headers");
    expect(q?.limit).toBe(2_000_000);
    expect(q?.remaining).toBe(1_900_000);
    expect(q?.resetAt?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  test("weekly percent is free-tier default when headers are untrusted full package", () => {
    const fullPackage: GrokOAuthQuota = {
      limit: 2_000_000,
      remaining: 2_000_000,
      used: 0,
      resetAt: null,
      source: "cli-chat-proxy/ratelimit-headers",
      percentScale: false,
    };
    const q = selectGrokOAuthQuota(null, fullPackage, percent);
    expect(q?.percentScale).toBe(true);
    expect(q?.source).toBe("grok.com/GetGrokCreditsConfig");
    expect(q?.limit).toBe(100);
    expect(q?.remaining).toBe(100);
  });

  test("percent-scale alone is free-tier CLI billing (GetGrokCreditsConfig)", () => {
    const q = selectGrokOAuthQuota(null, null, percent);
    expect(q).not.toBeNull();
    expect(q!.percentScale).toBe(true);
    expect(q!.limit).toBe(100);
    expect(q!.remaining).toBe(100);
  });

  test("headers-missing liveness falls through to weekly percent", () => {
    const emptyAbsolute: GrokOAuthQuota = {
      limit: 0,
      remaining: 0,
      used: 0,
      resetAt: null,
      source: "cli-chat-proxy/responses-probe",
      percentScale: false,
    };
    const q = selectGrokOAuthQuota(null, emptyAbsolute, percent);
    expect(q?.source).toBe("grok.com/GetGrokCreditsConfig");
    expect(q?.percentScale).toBe(true);
    expect(q?.remaining).toBe(100);
  });

  test("free-usage-exhausted zeros weekly percent when available", () => {
    const exhausted: GrokOAuthQuota = {
      limit: 0,
      remaining: 0,
      used: 0,
      resetAt: null,
      source: "cli-chat-proxy/free-usage-exhausted",
      percentScale: false,
    };
    const q = selectGrokOAuthQuota(null, exhausted, percent);
    expect(q).not.toBeNull();
    expect(q!.remaining).toBe(0);
    expect(q!.limit).toBe(100);
    expect(q!.percentScale).toBe(true);
    expect(q!.source).toContain("free-usage-exhausted");
  });

  test("free-usage-exhausted without percent keeps absolute exhausted shape", () => {
    const exhausted: GrokOAuthQuota = {
      limit: 0,
      remaining: 0,
      used: 0,
      resetAt: null,
      source: "cli-chat-proxy/free-usage-exhausted",
      percentScale: false,
    };
    const q = selectGrokOAuthQuota(null, exhausted, null);
    expect(q!.remaining).toBe(0);
    expect(q!.limit).toBe(GROK_FREE_BUILD_TOKEN_LIMIT);
    expect(q!.percentScale).toBe(false);
  });
});
