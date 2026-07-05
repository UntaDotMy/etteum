/**
 * Tests for shared security utilities (audit fixes H1, C4, H4).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { constantTimeEqual, extractApiKey, RateLimiter } from "../../src/utils/security";

describe("constantTimeEqual (H1)", () => {
  test("returns true for equal strings", () => {
    expect(constantTimeEqual("secret-key", "secret-key")).toBe(true);
  });

  test("returns false for different strings", () => {
    expect(constantTimeEqual("secret-key", "other-key")).toBe(false);
  });

  test("returns false for different lengths", () => {
    expect(constantTimeEqual("short", "much-longer-string")).toBe(false);
  });

  test("returns true for both empty", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  test("returns false for empty vs non-empty", () => {
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("x", "")).toBe(false);
  });

  test("handles unicode", () => {
    expect(constantTimeEqual("🔑", "🔑")).toBe(true);
    expect(constantTimeEqual("🔑", "🗝️")).toBe(false);
  });
});

describe("extractApiKey (H2 dedup)", () => {
  const baseHeaders = () => new Headers();

  test("extracts Bearer token from Authorization header", () => {
    const h = baseHeaders();
    h.set("Authorization", "Bearer my-token");
    expect(extractApiKey(h, null, { allowQuery: false })).toBe("my-token");
  });

  test("extracts from x-api-key header", () => {
    const h = baseHeaders();
    h.set("x-api-key", "x-key");
    expect(extractApiKey(h, null)).toBe("x-key");
  });

  test("extracts from ?api_key= query when allowed", () => {
    const h = baseHeaders();
    const q = new URLSearchParams("api_key=query-token");
    expect(extractApiKey(h, q, { allowQuery: true })).toBe("query-token");
  });

  test("does NOT extract from query when allowQuery is false", () => {
    const h = baseHeaders();
    const q = new URLSearchParams("api_key=query-token");
    expect(extractApiKey(h, q, { allowQuery: false })).toBe("");
  });

  test("Authorization header takes precedence over x-api-key", () => {
    const h = baseHeaders();
    h.set("Authorization", "Bearer bearer");
    h.set("x-api-key", "xkey");
    expect(extractApiKey(h, null)).toBe("bearer");
  });

  test("returns empty string when no auth present", () => {
    expect(extractApiKey(baseHeaders(), null)).toBe("");
  });
});

describe("RateLimiter (C4, H4)", () => {
  test("allows up to capacity then blocks", () => {
    const rl = new RateLimiter(3, 60); // 3 burst, 60/min
    expect(rl.check("ip1").allowed).toBe(true);
    expect(rl.check("ip1").allowed).toBe(true);
    expect(rl.check("ip1").allowed).toBe(true);
    const blocked = rl.check("ip1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("different keys have independent buckets", () => {
    const rl = new RateLimiter(1, 60);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    expect(rl.check("b").allowed).toBe(false);
  });

  test("refills over time", async () => {
    const rl = new RateLimiter(1, 6000); // 6000/min = 100/sec
    expect(rl.check("x").allowed).toBe(true);
    expect(rl.check("x").allowed).toBe(false);
    // Wait 30ms → should refill ~3 tokens.
    await new Promise((r) => setTimeout(r, 30));
    expect(rl.check("x").allowed).toBe(true);
  });

  test("retryAfterMs is positive when blocked", () => {
    const rl = new RateLimiter(1, 60);
    rl.check("z");
    const r = rl.check("z");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  test("remaining decreases with each allowed check", () => {
    const rl = new RateLimiter(5, 60);
    const r1 = rl.check("k");
    expect(r1.remaining).toBe(4);
    const r2 = rl.check("k");
    expect(r2.remaining).toBe(3);
  });
});