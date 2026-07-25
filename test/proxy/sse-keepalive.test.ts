/**
 * SSE keepalive: quiet streams must keep emitting comment frames so
 * Bun.serve idleTimeout / reverse proxies don't cut /v1 mid-request.
 */
import { describe, expect, test } from "bun:test";
import { startSseKeepalive } from "../../src/proxy/sse-keepalive";

describe("startSseKeepalive", () => {
  test("intervalMs <= 0 is a no-op", async () => {
    const writes: string[] = [];
    const h = startSseKeepalive((b) => writes.push(new TextDecoder().decode(b)), 0);
    await Bun.sleep(50);
    h.stop();
    expect(writes).toEqual([]);
  });

  test("emits comment frame after quiet interval", async () => {
    const writes: string[] = [];
    // interval 40ms → tick ~20ms; wait past one quiet window
    const h = startSseKeepalive((b) => writes.push(new TextDecoder().decode(b)), 40);
    await Bun.sleep(120);
    h.stop();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => w.startsWith(": keepalive"))).toBe(true);
    expect(writes.every((w) => w.endsWith("\n\n"))).toBe(true);
  });

  test("touch() postpones keepalive while stream is chatty", async () => {
    const writes: string[] = [];
    const h = startSseKeepalive((b) => writes.push(new TextDecoder().decode(b)), 80);
    const end = Date.now() + 120;
    while (Date.now() < end) {
      h.touch();
      await Bun.sleep(15);
    }
    h.stop();
    // While we kept touching, no quiet window of 80ms should have elapsed.
    expect(writes).toEqual([]);
  });

  test("stop() ends further writes", async () => {
    const writes: string[] = [];
    const h = startSseKeepalive((b) => writes.push(new TextDecoder().decode(b)), 40);
    await Bun.sleep(100);
    h.stop();
    const n = writes.length;
    await Bun.sleep(100);
    expect(writes.length).toBe(n);
  });
});
