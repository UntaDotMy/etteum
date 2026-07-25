/**
 * StreamAdapter: isSoftStop must not end the stream.
 *
 * Regression for silent mid-generation stops: grok.com emits isSoftStop as a
 * pause between segments (tools / search / reasoning). Only isFinal means done.
 * Treating soft-stop as done closed the client stream with finish_reason "stop"
 * and no error — answers appeared to stop for no reason.
 */
import { describe, expect, test } from "bun:test";
import { StreamAdapter } from "../../src/proxy/providers/grok/protocol";

function feedJson(adapter: StreamAdapter, obj: unknown) {
  return adapter.feed(JSON.stringify(obj));
}

describe("StreamAdapter soft-stop vs final", () => {
  test("isSoftStop alone does not emit done (mid-generation pause)", () => {
    const adapter = new StreamAdapter();
    const events = feedJson(adapter, {
      result: {
        response: {
          token: "Hello ",
          isSoftStop: true,
        },
      },
    });
    expect(events.map((e) => e.type)).toEqual(["text"]);
    expect(events[0]?.text).toBe("Hello ");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  test("isSoftStop at result level (no response body) does not emit done", () => {
    const adapter = new StreamAdapter();
    const events = feedJson(adapter, {
      result: { isSoftStop: true },
    });
    expect(events).toEqual([]);
  });

  test("isFinal emits done; later soft-stop would not have blocked more text", () => {
    const adapter = new StreamAdapter();

    // Segment 1: text + soft stop (pause) — keep going.
    const mid = feedJson(adapter, {
      result: {
        response: {
          token: "partial ",
          isSoftStop: true,
        },
      },
    });
    expect(mid.some((e) => e.type === "done")).toBe(false);

    // Segment 2: more text after soft stop.
    const more = feedJson(adapter, {
      result: {
        response: { token: "answer" },
      },
    });
    expect(more.map((e) => e.type)).toEqual(["text"]);
    expect(more[0]?.text).toBe("answer");

    // True final.
    const final = feedJson(adapter, {
      result: {
        response: { isFinal: true },
      },
    });
    expect(final.map((e) => e.type)).toEqual(["done"]);
  });

  test("isFinal at result level emits done", () => {
    const adapter = new StreamAdapter();
    const events = feedJson(adapter, {
      result: { isFinal: true },
    });
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  test("isFinal wins when both flags present", () => {
    const adapter = new StreamAdapter();
    const events = feedJson(adapter, {
      result: {
        response: {
          token: "end",
          isSoftStop: true,
          isFinal: true,
        },
      },
    });
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
  });
});
