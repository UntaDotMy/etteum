/**
 * SSE keepalive: quiet streams must keep emitting wire comments AND optional
 * protocol activity so Bun.serve idleTimeout / reverse proxies / client
 * event-idle watchdogs don't cut /v1 mid-request.
 *
 * Claude Code aborts after ~5 min with no non-ping stream events
 * ("API Error: Response stalled mid-stream"). Comment/ping alone do not reset
 * that timer — activity() must supply a real protocol event.
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

  test("activity() fires on quiet interval (protocol event for client idle reset)", async () => {
    const writes: string[] = [];
    let activityCount = 0;
    const h = startSseKeepalive(
      (b) => writes.push(new TextDecoder().decode(b)),
      40,
      {
        activity: () => {
          activityCount += 1;
          writes.push("ACTIVITY\n\n");
        },
      },
    );
    await Bun.sleep(120);
    h.stop();
    expect(activityCount).toBeGreaterThan(0);
    expect(writes.some((w) => w === "ACTIVITY\n\n")).toBe(true);
    expect(writes.some((w) => w.startsWith(": keepalive"))).toBe(true);
  });

  test("activity() is postponed by touch() while stream is chatty", async () => {
    const writes: string[] = [];
    let activityCount = 0;
    const h = startSseKeepalive(
      (b) => writes.push(new TextDecoder().decode(b)),
      80,
      { activity: () => { activityCount += 1; } },
    );
    const end = Date.now() + 120;
    while (Date.now() < end) {
      h.touch();
      await Bun.sleep(15);
    }
    h.stop();
    expect(activityCount).toBe(0);
    expect(writes).toEqual([]);
  });
});
