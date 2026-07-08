/**
 * Token-refresh coordinator (F8) — dedup + per-account lock + unrecoverable-error
 * classification + retry/backoff, wrapping provider.refreshToken().
 *
 * Ported from the reference proxy:
 *   - open-sse/services/tokenRefresh/dedup.js  → dedupRefresh (10s TTL map)
 *   - open-sse/services/oauthCredentialManager.js withCredentialRefreshLock
 *     → per-account promise lock
 *   - open-sse/services/tokenRefresh.js isUnrecoverableRefreshError (36-45)
 *     → disable-account classification
 *   - open-sse/services/tokenRefresh.js refreshWithRetry (235-253)
 *     → 3 retries, 1s/2s linear backoff
 *
 * Problem it solves (the F8 gap): concurrent 401s on the same account each
 * called provider.refreshToken + pool.updateTokens, racing on refresh-token
 * rotation (one wins the DB write, the other's rotated refresh_token is
 * invalidated). The coordinator coalesces them: same account → one in-flight
 * refresh, others await its result (dedup), and identical refresh tokens across
 * accounts share within a 10s window.
 */
import type { Account } from "../db/schema";
import type { BaseProvider } from "../proxy/providers/base";

/** A refresh result, normalized. `unrecoverable` means the account should be disabled. */
export interface CoordinatedRefreshResult {
  success: boolean;
  tokens?: unknown;
  error?: string;
  /** True when the error is permanent (invalid_grant / reused refresh token) → disable account. */
  unrecoverable: boolean;
}

// --- Per-account lock (mirrors withCredentialRefreshLock) ---
// Key: `provider:accountId`. Coalesces concurrent refreshes on the SAME account
// (the common case — multiple requests 401-ing on one expired token).
const accountLocks = new Map<string, Promise<CoordinatedRefreshResult>>();

// --- Token dedup (mirrors dedup.js, 10s TTL) ---
// Key: `provider:refreshTokenTail`. Coalesces refreshes on the SAME refresh
// token across different accounts (e.g. shared test credentials). Settled
// results are reused within TTL; failures are evicted immediately.
const DEDUP_TTL_MS = 10_000;
interface DedupEntry {
  promise: Promise<CoordinatedRefreshResult> | null;
  result: CoordinatedRefreshResult | null;
  expiresAt: number;
}
const dedupCache = new Map<string, DedupEntry>();

function refreshTokenTail(account: Account): string {
  const tokens = account.tokens as any;
  const rt = tokens?.refresh_token || tokens?.refreshToken;
  if (typeof rt !== "string" || rt.length === 0) return "";
  return rt.slice(-16);
}

/**
 * Is a refresh error unrecoverable (account should be disabled)?
 * Mirrors reference isUnrecoverableRefreshError (tokenRefresh.js:36-45) +
 * classifyOAuthRefreshError permanent markers (providers.js:214-233).
 */
export function isUnrecoverableRefreshError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes("invalid_grant") ||
    e.includes("invalid grant") ||
    e.includes("refresh_token_reused") ||
    e.includes("refresh token reused") ||
    e.includes("refresh_token_expired") ||
    e.includes("refresh token expired") ||
    e.includes("refresh_token_invalidated") ||
    e.includes("refresh token invalidated") ||
    e.includes("unrecoverable_refresh_error")
  );
}

/**
 * Is a refresh error transient (worth retrying)? Mirrors reference
 * refreshWithRetry's catch-and-continue for network/5xx/429.
 */
function isTransientRefreshError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes("timeout") ||
    e.includes("econnreset") ||
    e.includes("enotfound") ||
    e.includes("fetch failed") ||
    e.includes("network") ||
    e.includes("502") ||
    e.includes("503") ||
    e.includes("504") ||
    e.includes("429") ||
    e.includes("rate limit") ||
    e.includes("service_unavailable") ||
    e.includes("server_is_overloaded")
  );
}

/** Backoff base delay between retry attempts (ms). Defaults to 1000 (1s, 2s).
 * Tests set this to ~0 via setRefreshBackoffBaseMs to avoid slowing the suite. */
let REFRESH_BACKOFF_BASE_MS = 1000;
/** @internal Test hook to shorten backoff. */
export function setRefreshBackoffBaseMs(ms: number): void {
  REFRESH_BACKOFF_BASE_MS = Math.max(0, ms);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a single refresh attempt via the provider. Mirrors reference
 * refreshTokenByProvider (a single HTTP POST). Returns the normalized result.
 */
async function attemptRefresh(
  provider: BaseProvider,
  account: Account,
): Promise<CoordinatedRefreshResult> {
  try {
    const res = await provider.refreshToken(account);
    if (res.success && res.tokens) {
      let parsed: unknown;
      try { parsed = typeof res.tokens === "string" ? JSON.parse(res.tokens) : res.tokens; }
      catch { parsed = res.tokens; }
      return { success: true, tokens: parsed, unrecoverable: false };
    }
    const error = res.error || "Refresh failed";
    return { success: false, error, unrecoverable: isUnrecoverableRefreshError(error) };
  } catch (err: any) {
    const error = err?.message || String(err);
    return { success: false, error, unrecoverable: isUnrecoverableRefreshError(error) };
  }
}

/**
 * Refresh with retry (mirrors reference refreshWithRetry, 235-253):
 * up to 3 attempts, 1s/2s linear backoff, only retrying transient errors.
 * Unrecoverable errors short-circuit immediately (no point retrying invalid_grant).
 */
async function refreshWithRetry(
  provider: BaseProvider,
  account: Account,
): Promise<CoordinatedRefreshResult> {
  const maxRetries = 3;
  let last: CoordinatedRefreshResult = { success: false, error: "No attempt made", unrecoverable: false };
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) await sleep(attempt * REFRESH_BACKOFF_BASE_MS); // 1×base, then 2×base
    last = await attemptRefresh(provider, account);
    if (last.success) return last;
    if (last.unrecoverable) return last; // don't retry permanent errors
    if (!isTransientRefreshError(last.error)) return last; // don't retry unknown hard errors
    // transient → loop to retry
  }
  return last;
}

/**
 * Coordinated refresh: dedup + per-account lock + retry + classification.
 *
 * Call this instead of `provider.refreshToken(account)` from the router's
 * reactive 401 path AND from the proactive scheduler. Guarantees:
 *   - same account → one in-flight refresh, concurrent callers await it
 *   - same refresh-token tail → result reused within 10s
 *   - transient errors retried up to 3× with backoff
 *   - unrecoverable errors flagged so the caller can disable the account
 */
export async function coordinatedRefresh(
  provider: BaseProvider,
  account: Account,
): Promise<CoordinatedRefreshResult> {
  const providerName = (provider as any).name || "unknown";
  const accountKey = `${providerName}:${account.id}`;

  // Per-account lock: coalesce concurrent refreshes on the same account.
  const existing = accountLocks.get(accountKey);
  if (existing) return existing;

  // Token dedup: reuse a recent result for the same refresh-token tail.
  const tail = refreshTokenTail(account);
  const dedupKey = tail ? `${providerName}:${tail}` : "";
  if (dedupKey) {
    const hit = dedupCache.get(dedupKey);
    if (hit) {
      if (hit.promise) return hit.promise; // in-flight → await it
      if (hit.result && hit.expiresAt > Date.now()) return hit.result; // fresh result → reuse
      dedupCache.delete(dedupKey); // stale/expired → evict
    }
  }

  const promise = (async (): Promise<CoordinatedRefreshResult> => {
    const result = await refreshWithRetry(provider, account);
    // Cache successful (or recoverable) results for 10s; evict failures immediately
    // so a genuine retry isn't suppressed.
    if (dedupKey) {
      if (result.success) {
        dedupCache.set(dedupKey, { promise: null, result, expiresAt: Date.now() + DEDUP_TTL_MS });
      }
      // failures: don't cache (mirrors dedup.js eviction on failure)
    }
    return result;
  })();

  accountLocks.set(accountKey, promise);
  try {
    return await promise;
  } finally {
    accountLocks.delete(accountKey);
  }
}

/** Evict any cached dedup entry for an account's refresh-token tail (call after a token rotation). */
export function invalidateRefreshDedup(account: Account, providerName?: string): void {
  const pn = providerName || "unknown";
  const tail = refreshTokenTail(account);
  if (tail) dedupCache.delete(`${pn}:${tail}`);
}
