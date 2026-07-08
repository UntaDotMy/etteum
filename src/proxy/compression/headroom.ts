/**
 * Headroom — LLM-based whole-message compression (F11).
 *
 * Ported from the reference proxy open-sse/rtk/headroom.js. Compresses free-form
 * conversation messages via an external headroom-ai proxy:
 *   POST ${url}/v1/compress  { messages, model, config? }
 * The proxy runs an LLM (Claude→OpenAI→compress→Claude round-trip in the
 * reference) and returns compressed messages.
 *
 * This is the only technique that can SEMANTICALLY compress whole assistant+
 * user messages (not just truncate tool_result). Output-token-neutral on the
 * request side; the savings come from a smaller conversation.
 *
 * Fail-open: any error (proxy down, timeout, parse failure) returns the request
 * unchanged so the recording path is never blocked. Mirrors reference
 * compressWithHeadroom (:51-53).
 *
 * ASYNC — called as a pre-step before the synchronous compressRequest pipeline
 * (which is sync). The router calls applyHeadroom() first, then compressRequest().
 */
import type { ChatCompletionRequest } from "../providers/base";
import type { HeadroomConfig } from "./types";

export interface HeadroomResult {
  request: ChatCompletionRequest;
  /** Estimated tokens saved (input-side). 0 when no-op/failed. */
  saved: number;
  /** True when the proxy actually compressed the messages. */
  applied: boolean;
}

/**
 * Compress a request's free-form messages via the headroom-ai proxy.
 * Only compresses when enabled + the proxy is reachable. Never throws.
 */
export async function applyHeadroom(
  request: ChatCompletionRequest,
  cfg: HeadroomConfig,
  estimateTokens: (req: ChatCompletionRequest) => number,
): Promise<HeadroomResult> {
  if (!cfg.enabled || !cfg.url) {
    return { request, saved: 0, applied: false };
  }

  const tokensBefore = estimateTokens(request);
  // Don't bother compressing tiny conversations.
  if (tokensBefore < 200) {
    return { request, saved: 0, applied: false };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    const body: Record<string, unknown> = {
      messages: request.messages,
      model: request.model,
    };
    if (cfg.compressUserMessages) {
      body.config = { compress_user_messages: true };
    }

    const res = await fetch(`${cfg.url.replace(/\/$/, "")}/v1/compress`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { request, saved: 0, applied: false };
    }

    const data = (await res.json()) as { messages?: any[]; tokens_saved?: number };
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      return { request, saved: 0, applied: false };
    }

    const compressed: ChatCompletionRequest = { ...request, messages: data.messages };
    const tokensAfter = estimateTokens(compressed);
    const saved = Math.max(0, tokensBefore - tokensAfter);
    return { request: compressed, saved, applied: true };
  } catch {
    // Fail-open: network/timeout/parse error → pass through unchanged.
    return { request, saved: 0, applied: false };
  }
}
