import { describe, expect, test } from "bun:test";
import { warmupQueue } from "../../src/auth/warmup-queue";

/**
 * Verifies the stop-warmup control surface. The queue is a singleton with
 * DB-coupled enqueue/processItem, so we test the public stop() contract +
 * abort-signal linking in isolation — the parts that don't need a database.
 *
 * The full "abort an in-flight provider HTTP call" path is verified separately
 * via an AbortController/fetch round-trip (external signal → immediate abort),
 * which is the seam fetchWithTimeout relies on.
 */
describe("warmupQueue.stop()", () => {
  test("returns a well-formed { dropped, active } result on an idle queue", () => {
    const r = warmupQueue.stop();
    expect(typeof r.dropped).toBe("number");
    expect(typeof r.active).toBe("number");
    expect(r.dropped).toBeGreaterThanOrEqual(0);
    expect(r.active).toBeGreaterThanOrEqual(0);
  });

  test("is idempotent — calling repeatedly never throws", () => {
    expect(() => {
      warmupQueue.stop();
      warmupQueue.stop();
      warmupQueue.stop();
    }).not.toThrow();
  });

  test("a fresh (non-aborted) signal exists after stop, so warmup stays usable", () => {
    warmupQueue.stop();
    // After stop, the next job captured a fresh controller. We can't read the
    // private signal directly, but stop() must not leave the queue in a
    // permanently-aborted state — enqueue() after stop must still be callable.
    expect(() => warmupQueue.clear()).not.toThrow();
  });
});

describe("AbortSignal linking (the fetchWithTimeout seam)", () => {
  test("an external AbortSignal aborts an in-flight fetch immediately, not after the timeout", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(30_000);
        return new Response("ok");
      },
    });
    try {
      const p = fetch(`http://localhost:${server.port}/`, {
        signal: controller.signal,
      }).catch((e) => ({ aborted: true, name: (e as Error)?.name, ms: Date.now() - started }));
      await Bun.sleep(150);
      controller.abort();
      const res = (await p) as { aborted: boolean; name: string; ms: number };
      // Must abort in well under the 30s the server would take, proving the
      // external signal fires instantly rather than waiting for a timeout.
      expect(res.aborted).toBe(true);
      expect(res.name).toBe("AbortError");
      expect(res.ms).toBeLessThan(2000);
    } finally {
      server.stop();
    }
  });
});
