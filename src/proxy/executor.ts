/**
 * Shared provider executor (F12) — wraps the provider dispatch with per-URL
 * retry + Codex SSE-peek for 200-OK errors + error reclassification.
 *
 * Ported from the reference proxy open-sse/executors/base.js (BaseExecutor.execute) +
 * executors/codex.js (SSE-peek reclassification). Adapted: the reference has
 * one executor *per provider*; the TS proxy has a single executor at the
 * router dispatch seam (router.ts) that wraps `provider.chatCompletion(Stream)`,
 * so it works for every provider without touching provider files.
 *
 * Responsibilities:
 *   1. Per-status retry: on a retryable status (502/503/504), retry up to
 *      `maxAttempts` with `delayMs` backoff before returning failure.
 *   2. Codex SSE-peek: on a 200-OK stream/response, peek the first ~4KB for
 *      `server_is_overloaded`/`service_unavailable_error` and reclassify as a
 *      retryable 503 (these errors hide inside a 200 SSE body — silently
 *      surfaced as empty success otherwise).
 *   3. Uniform error reclassification via the F12 error-rules table.
 */
import type { Account } from "../db/schema";
import type { ChatCompletionRequest } from "./providers/base";
import type { BaseProvider, ProviderResult } from "./providers/base";
import { classifyError } from "./error-rules";

// Retry config — mirrors reference runtimeConfig.js DEFAULT_RETRY_CONFIG + RETRY_CONFIG.
const RETRY_CONFIG: Record<number, { attempts: number; delayMs: number }> = {
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 },
};
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_DELAY_MS = 2000;
// The retry loop must be able to reach the largest configured `attempts`
// value, otherwise a 502/503 (attempts:3) silently caps at 2 retries.
// `attempt < retry.attempts` needs attempt to reach attempts-1, and the loop
// bound `attempt <= MAX_RETRY_ATTEMPTS` must allow that.
const MAX_RETRY_ATTEMPTS = Math.max(
  DEFAULT_MAX_ATTEMPTS,
  ...Object.values(RETRY_CONFIG).map((c) => c.attempts),
);

// Codex SSE-peek — mirrors reference codex.js:16-17.
const CODEX_SSE_OVERLOADED_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const CODEX_SSE_PEEK_BYTES = 4096;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Peek the first ~4KB of a 200-OK stream for Codex overload patterns.
 *
 * IMPORTANT (MDN WHATWG Streams spec): `tee()` LOCKS the original stream —
 * the caller can no longer read `result.stream` directly. Both branches must
 * be consumed. The previous implementation teed and discarded branch 2, then
 * returned `result.stream` to the caller, whose `getReader()` threw
 * "ReadableStream is locked" on EVERY successful non-overload Codex stream.
 *
 * Fix: this function receives ONE branch (the caller passes `branch1` and
 * keeps `branch2`). It reads up to 4KB looking for an overload pattern.
 * Returns the matched pattern, or null on no-match.
 *
 * Mirrors reference codex.js _peekSseOverloaded (195-263).
 */
async function peekSseOverloaded(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    reader = stream.getReader();
    let acc = "";
    let bytesRead = 0;
    while (bytesRead < CODEX_SSE_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        acc += new TextDecoder().decode(value, { stream: true });
        bytesRead += value.byteLength;
        const hit = CODEX_SSE_OVERLOADED_PATTERNS.find((p) => acc.includes(p));
        if (hit) return hit;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { reader?.cancel(); } catch { /* ignore */ }
  }
}

/** True when a provider's responses are Codex-style (Responses API, where 200-OK overload errors hide). */
function isCodexStyleProvider(providerName: string): boolean {
  return providerName === "codex";
}

export interface ExecuteOptions {
  provider: BaseProvider;
  providerName: string;
  account: Account;
  request: ChatCompletionRequest;
  stream: boolean;
  signal?: AbortSignal;
}

/**
 * Execute a provider call with per-status retry + Codex SSE-peek.
 * Wraps `provider.chatCompletion` / `chatCompletionStream`. On a retryable
 * status/error, retries up to the configured attempts before returning the
 * failure. Never throws — returns a ProviderResult (success or error).
 */
export async function execute(opts: ExecuteOptions): Promise<ProviderResult> {
  const { provider, providerName, account, request, stream, signal } = opts;

  let lastResult: ProviderResult = { success: false, error: "No attempt made" };

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(DEFAULT_DELAY_MS);
    if (signal?.aborted) return { success: false, error: "aborted" };

    try {
      const result = stream
        ? await provider.chatCompletionStream(account, request)
        : await provider.chatCompletion(account, request);

      // Success — but check for a Codex 200-OK overload hiding in the body.
      if (result.success) {
        if (isCodexStyleProvider(providerName)) {
          const overload = await checkCodexOverload(result, stream);
          if (overload) {
            // Reclassify as retryable 503.
            lastResult = { success: false, error: overload, rateLimited: false };
            const retry = RETRY_CONFIG[503];
            if (retry && attempt < retry.attempts) {
              await sleep(retry.delayMs);
              continue;
            }
            return lastResult;
          }
        }
        return result;
      }

      // Failure — classify + decide retry.
      lastResult = result;
      const status = inferStatus(result);
      const rule = classifyError(status, result.error);

      // Non-account / permanent → no retry.
      if (rule && (rule.kind === "nonAccount" || rule.kind === "permanent")) {
        return result;
      }

      // Retryable status (502/503/504) → retry per config.
      if (status && RETRY_CONFIG[status]) {
        const retry = RETRY_CONFIG[status]!;
        if (attempt < retry.attempts) {
          await sleep(retry.delayMs);
          continue;
        }
      }

      // rateLimit / transient with backoff → retry up to default attempts.
      if (rule && (rule.kind === "rateLimit" || rule.kind === "transient") && attempt < DEFAULT_MAX_ATTEMPTS) {
        continue;
      }

      // No retry path → return the failure.
      return result;
    } catch (err: any) {
      lastResult = { success: false, error: err?.message || String(err) };
      const rule = classifyError(undefined, lastResult.error);
      if (rule && (rule.kind === "nonAccount" || rule.kind === "permanent")) return lastResult;
      if (attempt < DEFAULT_MAX_ATTEMPTS) continue;
      return lastResult;
    }
  }

  return lastResult;
}

/** Infer an HTTP status from a ProviderResult (providers set rateLimited/quotaExhausted flags). */
function inferStatus(result: ProviderResult): number | undefined {
  // Exhaustion outranks bare rateLimited (Grok free-usage-exhausted arrives as 429).
  if (result.quotaExhausted) return 402;
  if (result.rateLimited) return 429;
  if (result.error) {
    const e = result.error.toLowerCase();
    if (
      e.includes("free-usage-exhausted") ||
      e.includes("quota_exhausted") ||
      e.includes("spending-limit") ||
      e.includes("payment required")
    ) {
      return 402;
    }
    if (e.includes("(502)") || e.includes("bad gateway")) return 502;
    if (e.includes("(503)") || e.includes("service unavailable") || e.includes("server_is_overloaded")) return 503;
    if (e.includes("(504)") || e.includes("gateway timeout")) return 504;
    if (e.includes("(429)") || e.includes("rate limit") || e.includes("too many requests")) return 429;
    if (e.includes("(401)") || e.includes("unauthorized") || e.includes("expired")) return 401;
  }
  return undefined;
}

/**
 * Check a Codex success result for a 200-OK overload error hiding in the body.
 * For streams: peek the first 4KB. For non-streams: inspect the response text.
 *
 * STREAM CORRECTNESS: tee() locks the source stream, so we must hand the
 * caller a branch it can still read. On a no-match we replace result.stream
 * with branch2 (the unconsumed twin, which still contains the full data).
 * On a match (overload) we cancel both branches — the stream is abandoned
 * because the result will be reclassified as a retryable 503.
 */
async function checkCodexOverload(result: ProviderResult, stream: boolean): Promise<string | null> {
  if (stream && result.stream) {
    try {
      const [peek, original] = result.stream.tee();
      const hit = await peekSseOverloaded(peek);
      if (hit) {
        // Overload: abandon the stream (reclassified as 503 below).
        try { original.cancel(); } catch { /* ignore */ }
        return hit;
      }
      // No overload: hand the caller the intact second branch. The original
      // result.stream is now locked (tee locks it); branch2 is the readable copy.
      result.stream = original as any;
      return null;
    } catch {
      return null;
    }
  }
  // Non-stream: inspect the assembled response text for overload patterns.
  const resp = result.response as any;
  const text = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
  return CODEX_SSE_OVERLOADED_PATTERNS.find((p) => text.includes(p)) ?? null;
}
