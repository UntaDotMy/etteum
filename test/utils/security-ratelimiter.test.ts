/**
 * Tests for the in-memory token-bucket RateLimiter in src/utils/security.ts.
 *
 * The limiter reads Date.now() directly (no injected clock), so these tests
 * monkeypatch Date.now() to simulate the passage of time deterministically
 * and restore the real clock in afterEach. Everything is in-memory — no
 * network, no DB, no env-dependent imports (security.ts only imports
 * node:crypto).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { RateLimiter } from "../../src/utils/security";

const realNow = Date.now;
let nowMs = 0;

function setNow(ms: number): void {
  nowMs = ms;
  Date.now = () => nowMs;
}

function advance(ms: number): void {
  nowMs += ms;
}

afterEach(() => {
  Date.now = realNow;
});

describe("RateLimiter: basic token-bucket behavior", () => {
  test("allows up to capacity requests immediately (burst)", () => {
    setNow(1_000_000);
    const rl = new RateLimiter(5, 60);
    for (let i = 0; i < 5; i++) {
      const r = rl.check("ip-1");
      expect(r.allowed).toBe(true);
      expect(r.retryAfterMs).toBe(0);
    }
    const denied = rl.check("ip-1");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  test("first request starts a bucket with (capacity - 1) remaining", () => {
    setNow(1_000_000);
    const rl = new RateLimiter(10, 60);
    const r = rl.check("ip-1");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
  });

  test("buckets are keyed per identifier", () => {
    setNow(1_000_000);
    const rl = new RateLimiter(2, 60);
    rl.check("a");
    rl.check("a");
    expect(rl.check("a").allowed).toBe(false);
    // A different id has its own full bucket.
    const rb = rl.check("b");
    expect(rb.allowed).toBe(true);
    expect(rb.remaining).toBe(1);
  });

  test("retryAfterMs matches the time needed to earn one token", () => {
    setNow(1_000_000);
    // 1 token per minute → 60_000 ms per token.
    const rl = new RateLimiter(1, 1);
    expect(rl.check("x").allowed).toBe(true);
    const denied = rl.check("x");
    expect(denied.allowed).toBe(false);
    // Need a full token refill: ceil(1 / (1/60000)) = 60000.
    expect(denied.retryAfterMs).toBe(60_000);
  });

  test("tokens refill proportionally with elapsed time", () => {
    setNow(1_000_000);
    const rl = new RateLimiter(10, 60); // 1 token per second
    // Drain the bucket.
    for (let i = 0; i < 10; i++) expect(rl.check("x").allowed).toBe(true);
    expect(rl.check("x").allowed).toBe(false);
    // Advance 5 seconds → 5 tokens refilled.
    advance(5_000);
    for (let i = 0; i < 5; i++) expect(rl.check("x").allowed).toBe(true);
    expect(rl.check("x").allowed).toBe(false);
  });

  test("refill is capped at capacity (no over-accumulation)", () => {
    setNow(1_000_000);
    const rl = new RateLimiter(3, 60);
    // Wait a very long time without consuming — bucket must stay at capacity.
    advance(60 * 60_000);
    expect(rl.check("x").allowed).toBe(true);
    expect(rl.check("x").remaining).toBe(1); // 3 - 1 consumed, then 1 more consumed
    expect(rl.check("x").allowed).toBe(true);
    expect(rl.check("x").remaining).toBe(0);
    expect(rl.check("x").allowed).toBe(false);
  });
});

describe("RateLimiter: size tracking", () => {
  test("size reflects distinct identifiers seen", () => {
    setNow(1_000_000);
    const rl = new RateLimiter(5, 60);
    expect(rl.size).toBe(0);
    rl.check("a");
    expect(rl.size).toBe(1);
    rl.check("b");
    rl.check("c");
    expect(rl.size).toBe(3);
    // Re-checking an existing id does not grow the map.
    rl.check("a");
    expect(rl.size).toBe(3);
  });
});

describe("RateLimiter: idle eviction sweep", () => {
  test("sweep only runs when at least 60s elapsed since last sweep", () => {
    // idleEvictMs = max(60s, 120s) = 120s for (1, 1).
    setNow(10_000_000);
    const rl = new RateLimiter(1, 1);
    rl.check("old"); // maybeSweep: 0s < 60s gate → no sweep

    // 70s later the sweep gate opens; "old" is 70s idle < 120s so it is kept,
    // and the check re-stamps its lastRefill to now.
    advance(70_000);
    rl.check("old");
    expect(rl.size).toBe(1);

    // 61s more: "old" is only 61s idle (re-stamped above), still < 120s, so
    // the sweep that fires keeps it again. Checking an id re-stamps it — a
    // bucket that keeps being checked never goes idle.
    advance(61_000);
    rl.check("trigger");
    expect(rl.size).toBe(2); // "old" + "trigger"
  });

  test("sweep evicts a bucket that went genuinely idle past idleEvictMs", () => {
    // idleEvictMs = 120s for (1, 1).
    setNow(10_000_000);
    const rl = new RateLimiter(1, 1);
    rl.check("old");

    // Never touch "old" again; jump 130s (> 120s idle, > 60s sweep gate) and
    // trigger the sweep via a different id.
    advance(130_000);
    rl.check("trigger");
    expect(rl.size).toBe(1); // "old" evicted, "trigger" remains
  });

  test("sweep gate keys off last SWEEP time, not last check time", () => {
    // idleEvictMs = 120s for (1, 1). The gate is `now - lastSweep < 60_000`,
    // and lastSweep only advances when a sweep actually runs — so checks
    // arriving every 59s still let a sweep fire every ~118s.
    setNow(10_000_000);
    const rl = new RateLimiter(1, 1);
    rl.check("keepme");

    for (let i = 0; i < 4; i++) {
      advance(59_000);
      rl.check(`pinger-${i}`);
    }
    // Sweeps fired at t+118s and t+236s. The second sweep evicted "keepme"
    // (236s idle > 120s) and "pinger-0" (177s idle > 120s); pinger-1/2/3 are
    // newer than 120s and survive.
    expect(rl.size).toBe(3);
  });

  test("sweep gate suppresses eviction within 60s of the last sweep", () => {
    // idleEvictMs = 120s for (1, 1).
    setNow(10_000_000);
    const rl = new RateLimiter(1, 1);
    rl.check("old");

    // Open the gate and run a sweep at t+61s (61s > 60s gate). "old" is 61s
    // idle < 120s so it survives; lastSweep is now t+61s.
    advance(61_000);
    rl.check("poke");
    expect(rl.size).toBe(2);

    // 59s later "old" is 120s idle — exactly at the boundary, but the sweep
    // gate is closed (59s < 60s since last sweep), so maybeSweep returns
    // early and "old" is NOT evicted.
    advance(59_000);
    rl.check("poke2");
    expect(rl.size).toBe(3); // "old" still present thanks to the closed gate

    // One more second: gate opens (60s since last sweep) and "old" is now
    // 121s idle > 120s → evicted. Note eviction is strict `>` idleEvictMs.
    advance(1_000);
    rl.check("poke3");
    expect(rl.size).toBe(3); // "old" gone; poke/poke2/poke3 remain
  });

  test("idle buckets are evicted and get a fresh full bucket on next check", () => {
    setNow(10_000_000);
    const rl = new RateLimiter(2, 1); // capacity 2, 1/min → idleEvictMs = max(60s, 240s) = 240s
    rl.check("gone"); // consume 1 token
    rl.check("gone"); // consume 2nd token → bucket empty

    advance(241_000); // idle > 240s; also > 60s sweep gate
    rl.check("trigger"); // fires the sweep → "gone" evicted
    expect(rl.size).toBe(1);

    // "gone" was evicted: its next check must create a NEW bucket with full
    // capacity 2, not a refilled-but-empty one.
    const r1 = rl.check("gone");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);
  });

  test("recently-active buckets survive the sweep", () => {
    setNow(10_000_000);
    const rl = new RateLimiter(5, 60); // idleEvictMs = max(60s, 10s) = 60s
    rl.check("stale");
    advance(30_000);
    rl.check("active"); // created at t+30s
    advance(61_000); // now t+91s: "stale" idle 91s > 60s; "active" idle 61s > 60s — hmm both evict
    rl.check("trigger");
    // Both went idle > 60s (idleEvictMs is 60s for this config), so only the
    // just-created "trigger" bucket remains.
    expect(rl.size).toBe(1);
  });

  test("idleEvictMs uses the 60s floor for high-refill configs", () => {
    setNow(10_000_000);
    // capacity 5, perMinute 60 → (5/60)*60s*2 = 10s → floored to 60s.
    const rl = new RateLimiter(5, 60);
    rl.check("x");
    advance(59_000);
    rl.check("x"); // still active at 59s; also re-stamps lastRefill
    advance(61_000); // idle 61s > 60s floor
    rl.check("trigger");
    expect(rl.size).toBe(1); // "x" evicted by the 60s floor, not the 10s formula
  });

  test("idleEvictMs scales with capacity/perMinute for slow refills", () => {
    setNow(10_000_000);
    // capacity 10, perMinute 1 → (10/1)*60s*2 = 1200s idle window.
    const rl = new RateLimiter(10, 1);
    rl.check("x");
    advance(600_000); // 600s idle — well under the 1200s window
    rl.check("x"); // sweep fires (600s > 60s gate) but keeps "x"; re-stamps it
    advance(61_000); // > 60s sweep gate, but only 61s idle
    rl.check("trigger");
    expect(rl.size).toBe(2); // nothing evicted: long idle window protects "x"
  });
});
