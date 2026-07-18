import { describe, expect, test } from "bun:test";
import {
  averageSpeedMetrics,
  isContentfulStreamChunk,
  tokensPerSecondForSample,
} from "../../src/proxy/share-metrics";
import {
  __resetActiveClientRequestsForTests,
  getActiveClientRequests,
  trackClientRequestStart,
} from "../../src/proxy/live-clients";

describe("share-metrics", () => {
  test("isContentfulStreamChunk detects delta content and tool calls", () => {
    expect(isContentfulStreamChunk({ choices: [{ delta: { content: "hi" } }] })).toBe(true);
    expect(
      isContentfulStreamChunk({ choices: [{ delta: { reasoning_content: "think" } }] }),
    ).toBe(true);
    expect(
      isContentfulStreamChunk({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }),
    ).toBe(true);
    expect(isContentfulStreamChunk({ choices: [{ delta: {} }] })).toBe(false);
    expect(isContentfulStreamChunk({ choices: [{ delta: { role: "assistant" } }] })).toBe(false);
    expect(isContentfulStreamChunk(null)).toBe(false);
  });

  test("tokensPerSecond prefers post-TTFT generation window", () => {
    // 100 tokens over 1s generation after 500ms TTFT in a 1500ms total.
    const tps = tokensPerSecondForSample({
      completionTokens: 100,
      durationMs: 1500,
      ttftMs: 500,
    });
    expect(tps).toBeCloseTo(100, 5);

    // No TTFT → full duration.
    const tpsFull = tokensPerSecondForSample({
      completionTokens: 50,
      durationMs: 1000,
      ttftMs: null,
    });
    expect(tpsFull).toBeCloseTo(50, 5);

    expect(tokensPerSecondForSample({ completionTokens: 0, durationMs: 1000, ttftMs: 10 })).toBe(
      null,
    );
  });

  test("averageSpeedMetrics averages only usable samples", () => {
    const m = averageSpeedMetrics([
      { completionTokens: 100, durationMs: 1500, ttftMs: 500 },
      { completionTokens: 50, durationMs: 1000, ttftMs: 200 },
      { completionTokens: 0, durationMs: 900, ttftMs: null },
    ]);
    expect(m.sampleSize).toBe(3);
    expect(m.ttftMs).toBe(350); // (500+200)/2
    // tps: 100/(1.0s)=100 and 50/(0.8s)=62.5 → avg 81.25 → 81.3
    expect(m.tokensPerSecond).toBeCloseTo(81.3, 1);
  });
});

describe("live-clients", () => {
  test("tracks nested in-flight clients with idempotent end", () => {
    __resetActiveClientRequestsForTests();
    expect(getActiveClientRequests()).toBe(0);
    const end1 = trackClientRequestStart();
    const end2 = trackClientRequestStart();
    expect(getActiveClientRequests()).toBe(2);
    end1();
    end1(); // second call no-ops
    expect(getActiveClientRequests()).toBe(1);
    end2();
    expect(getActiveClientRequests()).toBe(0);
  });
});
