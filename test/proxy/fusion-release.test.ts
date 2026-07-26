/**
 * §4.5; fusion fan-out leaked pool tracking.
 *
 * routeRequest hands a SUCCESSFUL stream to the caller and deliberately skips
 * pool.trackRequestEnd (the stream finalizer owns that release). Fusion returned
 * the first fulfilled result and dropped the rest on the floor, so every losing
 * account kept a permanently non-zero in-flight count and the least-in-flight
 * balancer stopped choosing it.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { releaseLosingResults } from "../../src/proxy/fusion";
import { pool } from "../../src/proxy/pool";
import type { RouteResult } from "../../src/proxy/router";

function streamResult(accountId: number, cancelled: { hit: boolean }): PromiseSettledResult<RouteResult> {
  const stream = new ReadableStream<Uint8Array>({
    start() { /* never enqueues; stays open like a live upstream */ },
    cancel() { cancelled.hit = true; },
  });
  return {
    status: "fulfilled",
    value: {
      result: { success: true, stream },
      account: { id: accountId } as any,
      provider: "grok" as any,
      durationMs: 1,
    } as RouteResult,
  };
}

function nonStreamResult(accountId: number): PromiseSettledResult<RouteResult> {
  return {
    status: "fulfilled",
    value: {
      result: { success: true, response: { choices: [] } as any },
      account: { id: accountId } as any,
      provider: "grok" as any,
      durationMs: 1,
    } as RouteResult,
  };
}

const rejected = (): PromiseSettledResult<RouteResult> => ({ status: "rejected", reason: new Error("boom") });

describe("releaseLosingResults", () => {
  beforeEach(() => {
    for (const id of [901, 902, 903]) {
      while (pool.getInFlightCount(id) > 0) pool.trackRequestEnd(id);
    }
  });

  test("losing streams are cancelled and their in-flight tracking released", () => {
    const c1 = { hit: false };
    const c2 = { hit: false };
    const results = [streamResult(901, c1), streamResult(902, c2)];
    pool.trackRequestStart(901);
    pool.trackRequestStart(902);

    releaseLosingResults(results, 0); // index 0 wins

    expect(pool.getInFlightCount(901)).toBe(1); // winner still in flight
    expect(pool.getInFlightCount(902)).toBe(0); // loser released
    expect(c1.hit).toBe(false);
    expect(c2.hit).toBe(true);
  });

  test("non-stream losers are left alone (routeRequest already released them)", () => {
    const results = [streamResult(901, { hit: false }), nonStreamResult(902)];
    pool.trackRequestStart(901);
    releaseLosingResults(results, 0);
    expect(pool.getInFlightCount(902)).toBe(0);
    expect(pool.getInFlightCount(901)).toBe(1);
  });

  test("rejected entries are skipped without throwing", () => {
    expect(() => releaseLosingResults([rejected(), rejected()], -1)).not.toThrow();
  });

  test("winnerIndex -1 releases every fulfilled stream (nothing won)", () => {
    const c1 = { hit: false };
    const c2 = { hit: false };
    const results = [streamResult(901, c1), streamResult(902, c2)];
    pool.trackRequestStart(901);
    pool.trackRequestStart(902);

    releaseLosingResults(results, -1);

    expect(pool.getInFlightCount(901)).toBe(0);
    expect(pool.getInFlightCount(902)).toBe(0);
    expect(c1.hit).toBe(true);
    expect(c2.hit).toBe(true);
  });
});
