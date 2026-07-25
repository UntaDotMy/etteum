/**
 * Qoder stream stall: must surface an error, not invent finish_reason "stop".
 *
 * Regression: when STREAM_TIMEOUT fired, the loop broke with finishEmitted=false
 * and the finally path emitted finish_reason "stop" + [DONE] — Claude Code /
 * OpenAI clients treated that as a clean mid-request stop with no reason.
 */
import { describe, expect, test } from "bun:test";

/**
 * Minimal reimplementation of the stall→error branch so we don't need a full
 * Qoder account. Mirrors provider.ts: on stalled, emit error frame, not stop.
 */
function finishAfterLoop(opts: {
  finishEmitted: boolean;
  stalled: boolean;
  streamActive: boolean;
  streamTimeoutMs: number;
}): string[] {
  const frames: string[] = [];
  const { finishEmitted, stalled, streamActive, streamTimeoutMs } = opts;
  if (!streamActive) return frames;

  if (stalled) {
    frames.push(
      `data: ${JSON.stringify({
        error: {
          message: `Stream read timeout after ${streamTimeoutMs}ms of silence`,
          type: "api_error",
          code: "stream_timeout",
        },
      })}\n\n`,
    );
  } else if (!finishEmitted) {
    frames.push(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
  }
  frames.push("data: [DONE]\n\n");
  return frames;
}

describe("Qoder stream stall completion", () => {
  test("stalled → error frame, never finish_reason stop", () => {
    const frames = finishAfterLoop({
      finishEmitted: false,
      stalled: true,
      streamActive: true,
      streamTimeoutMs: 300_000,
    });
    const joined = frames.join("");
    expect(joined).toContain("stream_timeout");
    expect(joined).toContain("Stream read timeout");
    expect(joined).not.toContain('"finish_reason":"stop"');
    expect(joined).toContain("[DONE]");
  });

  test("clean end without finish still emits stop (OpenAI safety net)", () => {
    const frames = finishAfterLoop({
      finishEmitted: false,
      stalled: false,
      streamActive: true,
      streamTimeoutMs: 300_000,
    });
    const joined = frames.join("");
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined).not.toContain("stream_timeout");
  });

  test("upstream already finished → no invented stop or error", () => {
    const frames = finishAfterLoop({
      finishEmitted: true,
      stalled: false,
      streamActive: true,
      streamTimeoutMs: 300_000,
    });
    const joined = frames.join("");
    expect(joined).toBe("data: [DONE]\n\n");
  });
});
