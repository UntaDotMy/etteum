/**
 * Share-board speed metrics derived from request_logs.
 *
 * TTFT: first contentful SSE chunk time (stream only; null for non-stream).
 * tok/s: completion tokens / generation seconds after first token when TTFT
 * is known, else completion / full duration.
 */

export type SpeedSample = {
  completionTokens: number;
  durationMs: number;
  ttftMs: number | null;
};

export type SpeedMetrics = {
  ttftMs: number | null;
  tokensPerSecond: number | null;
  sampleSize: number;
};

/** True when a parsed SSE payload contains model output (text/reasoning/tools). */
export function isContentfulStreamChunk(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, any>;
  const choice = p.choices?.[0];
  const text = String(
    choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      p.delta?.content ??
      p.content ??
      p.text ??
      "",
  );
  const reasoning = String(
    choice?.delta?.reasoning_content ??
      choice?.message?.reasoning_content ??
      p.delta?.reasoning_content ??
      "",
  );
  if (text.length > 0 || reasoning.length > 0) return true;
  if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) return true;
  if (choice?.delta?.function_call) return true;
  // Anthropic-shaped stream events sometimes appear after transform.
  if (p.type === "content_block_delta" && (p.delta?.text || p.delta?.partial_json)) return true;
  return false;
}

/**
 * Tokens/sec for one completed request.
 * Prefers post-TTFT generation window so prompt wait is not counted as generation.
 */
export function tokensPerSecondForSample(s: SpeedSample): number | null {
  const tokens = Number(s.completionTokens) || 0;
  if (tokens <= 0) return null;
  const duration = Math.max(0, Number(s.durationMs) || 0);
  if (duration <= 0) return null;
  const ttft = s.ttftMs != null && Number.isFinite(s.ttftMs) ? Math.max(0, Number(s.ttftMs)) : null;
  const genMs = ttft != null ? Math.max(1, duration - ttft) : Math.max(1, duration);
  return tokens / (genMs / 1000);
}

/** Average TTFT + tok/s across samples; nulls when no usable data. */
export function averageSpeedMetrics(samples: SpeedSample[]): SpeedMetrics {
  let ttftSum = 0;
  let ttftN = 0;
  let tpsSum = 0;
  let tpsN = 0;
  for (const s of samples) {
    if (s.ttftMs != null && Number.isFinite(s.ttftMs) && s.ttftMs >= 0) {
      ttftSum += s.ttftMs;
      ttftN += 1;
    }
    const tps = tokensPerSecondForSample(s);
    if (tps != null && Number.isFinite(tps)) {
      tpsSum += tps;
      tpsN += 1;
    }
  }
  return {
    ttftMs: ttftN > 0 ? Math.round(ttftSum / ttftN) : null,
    tokensPerSecond: tpsN > 0 ? Math.round((tpsSum / tpsN) * 10) / 10 : null,
    sampleSize: samples.length,
  };
}
