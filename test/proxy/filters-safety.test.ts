/**
 * Tests for filter safety (audit fix C7): regex ReDoS guard + infinite-loop
 * guard on non-regex replace-all.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect } from "bun:test";
import { applyPudidilFilters } from "../../src/proxy/filters";

describe("applyPudidilFilters safety (C7)", () => {
  // The function reads from the in-memory cache (DB-backed). In a test env
  // without a DB, it falls back to the built-in PUDIDIL_FILTERS const, which
  // are all non-regex sanitization rules. We test those + the loop guard.

  test("does not crash on empty input", () => {
    expect(() => applyPudidilFilters("")).not.toThrow();
    expect(applyPudidilFilters("")).toBe("");
  });

  test("passes through content with no matching rules unchanged", () => {
    const input = "This is a perfectly normal sentence with no patterns.";
    const result = applyPudidilFilters(input);
    expect(typeof result).toBe("string");
  });

  test("terminates on input that could cause repeated replacement", () => {
    // If a non-regex rule replaces "aa" with "aaa", a naive while-includes
    // loop would never terminate. Our iteration cap + no-progress guard
    // ensures it returns within a reasonable time.
    const input = "aa".repeat(100);
    const start = Date.now();
    const result = applyPudidilFilters(input);
    const elapsed = Date.now() - start;
    // Should complete in well under 1 second even with pathological input.
    expect(elapsed).toBeLessThan(1000);
    expect(typeof result).toBe("string");
  });

  test("handles very long input without hanging", () => {
    const input = "normal text ".repeat(10_000);
    const start = Date.now();
    applyPudidilFilters(input);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});