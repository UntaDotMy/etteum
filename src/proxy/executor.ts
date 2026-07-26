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
import { isHardConnectFailure } from "./errors";
import type { Utf8StreamReader } from "../utils/stream-reader";

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
/**
 * Wall-clock ceiling on the overload peek. The byte budget alone stalls the
 * client until upstream has produced 4 KB of SSE; seconds of buffered tokens on
 * a healthy stream, i.e. a TTFT regression on the one provider it applies to.
 * An overload frame arrives in the FIRST chunk, so a short deadline loses nothing.
 */
const CODEX_SSE_PEEK_MS = Math.max(
  100,
  Number(process.env.POOLPROX_CODEX_PEEK_MS) || 1_500,
);

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
  let reader: Utf8StreamReader | null = null;
  const deadline = Date.now() + CODEX_SSE_PEEK_MS;
  try {
    reader = stream.getReader();
    let acc = "";
    let bytesRead = 0;
    while (bytesRead < CODEX_SSE_PEEK_BYTES) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Race the read against the remaining budget so a slow-but-healthy stream
      // is handed to the client promptly instead of buffering to the byte cap.
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (!next) break; // deadline hit
      const { done, value } = next;
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
  /**
   * Cap on same-account retries. When undefined the full per-status RETRY_CONFIG
   * / DEFAULT_MAX_ATTEMPTS budget applies (legacy behavior). The router passes 0
   * when another account is available — rotating to a fresh account beats
   * re-hitting a degraded one — and a positive cap to bound total hops.
   */
  maxRetries?: number;
}

/**
 * Execute a provider call with per-status retry + Codex SSE-peek.
 * Wraps `provider.chatCompletion` / `chatCompletionStream`. On a retryable
 * status/error, retries up to the configured attempts before returning the
 * failure. Never throws — returns a ProviderResult (success or error).
 */
export async function execute(opts: ExecuteOptions): Promise<ProviderResult> {
  const { provider, providerName, account, request, stream, signal } = opts;
  // Cap on same-account retries. When the caller passes a cap, the effective
  // per-status budget is min(configured, cap); the outer loop never exceeds
  // cap+1 total attempts against this account.
  const cap = opts.maxRetries;
  const effectiveAttempts = (configured: number) => (cap === undefined ? configured : Math.min(configured, cap));
  const maxAttempts = cap === undefined ? MAX_RETRY_ATTEMPTS : Math.min(MAX_RETRY_ATTEMPTS, cap);

  let lastResult: ProviderResult = { success: false, error: "No attempt made" };

  // Set when a branch below already slept its per-status delay, so the
  // top-of-loop backoff does not double-charge (a 503 cost 2s + 2s = 4s).
  let sleptForThisAttempt = false;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (attempt > 0 && !sleptForThisAttempt) await sleep(DEFAULT_DELAY_MS);
    sleptForThisAttempt = false;
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
            if (retry && attempt < effectiveAttempts(retry.attempts)) {
              await sleep(retry.delayMs);
              sleptForThisAttempt = true;
              continue;
            }
            return lastResult;
          }
        }
        return result;
      }

      // Failure — classify + decide retry.
      lastResult = result;
      // Hard connect (connection refused / upstream connect) will fail the same
      // way on every attempt — do not burn 3×2s sleeps on the same account.
      if (isHardConnectFailure(result.error)) {
        return result;
      }
      const status = inferStatus(result);
      const rule = classifyError(status, result.error);

      // Non-account / permanent → no retry.
      if (rule && (rule.kind === "nonAccount" || rule.kind === "permanent")) {
        return result;
      }

      // Retryable status (502/503/504) → retry per config (soft overload only).
      if (status && RETRY_CONFIG[status]) {
        const retry = RETRY_CONFIG[status]!;
        if (attempt < effectiveAttempts(retry.attempts)) {
          await sleep(retry.delayMs);
          sleptForThisAttempt = true;
          continue;
        }
      }

      // rateLimit / transient with backoff → retry up to default attempts.
      if (rule && (rule.kind === "rateLimit" || rule.kind === "transient") && attempt < effectiveAttempts(DEFAULT_MAX_ATTEMPTS)) {
        continue;
      }

      // No retry path → return the failure.
      return result;
    } catch (err: any) {
      lastResult = { success: false, error: err?.message || String(err) };
      if (isHardConnectFailure(lastResult.error)) return lastResult;
      const rule = classifyError(undefined, lastResult.error);
      if (rule && (rule.kind === "nonAccount" || rule.kind === "permanent")) return lastResult;
      if (attempt < effectiveAttempts(DEFAULT_MAX_ATTEMPTS)) continue;
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
    if (e.includes("(502)") || e.includes("bad gateway") || /\berror\s+502\b/.test(e)) return 502;
    // Grok: `cli-chat-proxy error 503: ...` (no parentheses)
    if (
      e.includes("(503)") ||
      e.includes("service unavailable") ||
      e.includes("server_is_overloaded") ||
      /\berror\s+503\b/.test(e) ||
      (/\b503\b/.test(e) && (e.includes("connect") || e.includes("upstream")))
    ) {
      return 503;
    }
    if (e.includes("(504)") || e.includes("gateway timeout") || /\berror\s+504\b/.test(e)) return 504;
    if (e.includes("(429)") || e.includes("rate limit") || e.includes("too many requests")) return 429;
    if (e.includes("(401)") || e.includes("unauthorized") || e.includes("expired")) return 401;
    if (e.includes("access denied") || (/\b403\b/.test(e) && e.includes("forbidden"))) return 403;
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
