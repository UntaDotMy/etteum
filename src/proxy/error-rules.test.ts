import { describe, test, expect } from "bun:test";
import { classifyError, isNonAccountError, BACKOFF_CONFIG, ERROR_RULES } from "./error-rules";

describe("error-rules classification", () => {
  test("classifies 429 as rateLimit with backoff", () => {
    const r = classifyError(429, "Too many requests");
    expect(r?.kind).toBe("rateLimit");
    expect(r?.backoff).toBe(true);
  });

  test("classifies 401/expired as transient (refresh path)", () => {
    const r = classifyError(401, "token expired");
    expect(r?.kind).toBe("transient");
  });

  test("classifies content moderation as nonAccount (never rotate)", () => {
    const r = classifyError(400, "content_filter triggered");
    expect(r?.kind).toBe("nonAccount");
  });

  test("classifies invalid model as nonAccount", () => {
    const r = classifyError(404, "model_not_found: foo");
    expect(r?.kind).toBe("nonAccount");
  });

  test("classifies 503 as transient with backoff", () => {
    const r = classifyError(503, "service unavailable");
    expect(r?.kind).toBe("transient");
    expect(r?.backoff).toBe(true);
  });

  test("classifies server_is_overloaded (Codex SSE-peek pattern) as transient", () => {
    const r = classifyError(undefined, "server_is_overloaded");
    expect(r?.kind).toBe("transient");
  });

  test("classifies banned as permanent", () => {
    const r = classifyError(403, "account banned");
    expect(r?.kind).toBe("permanent");
  });

  test("returns null for unclassifiable errors", () => {
    expect(classifyError(undefined, undefined)).toBeNull();
    expect(classifyError(200, "ok")).toBeNull();
  });
});

describe("isNonAccountError", () => {
  test("413 is always non-account (oversized payload)", () => {
    expect(isNonAccountError(413, undefined)).toBe(true);
  });

  test("content moderation is non-account", () => {
    expect(isNonAccountError(400, "data_inspection_failed")).toBe(true);
  });

  test("rate limit is NOT non-account (should rotate)", () => {
    expect(isNonAccountError(429, "rate limit")).toBe(false);
  });

  test("transient 503 is NOT non-account (should retry/backoff)", () => {
    expect(isNonAccountError(503, "bad gateway")).toBe(false);
  });
});

describe("BACKOFF_CONFIG", () => {
  test("delayFor doubles and caps", () => {
    expect(BACKOFF_CONFIG.delayFor(0)).toBe(2_000);
    expect(BACKOFF_CONFIG.delayFor(1)).toBe(4_000);
    expect(BACKOFF_CONFIG.delayFor(2)).toBe(8_000);
    // capped at maxMs (5 min)
    expect(BACKOFF_CONFIG.delayFor(20)).toBe(BACKOFF_CONFIG.maxMs);
  });
});

describe("ERROR_RULES table integrity", () => {
  test("every rule has an id, match fn, and kind", () => {
    for (const rule of ERROR_RULES) {
      expect(typeof rule.id).toBe("string");
      expect(typeof rule.match).toBe("function");
      expect(["nonAccount", "transient", "rateLimit", "invalidModel", "permanent"]).toContain(rule.kind);
    }
  });

  test("match fn never throws on undefined inputs", () => {
    for (const rule of ERROR_RULES) {
      expect(() => rule.match(undefined, undefined)).not.toThrow();
      expect(() => rule.match(500, undefined)).not.toThrow();
      expect(() => rule.match(undefined, "some error")).not.toThrow();
    }
  });
});
