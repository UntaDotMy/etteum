/**
 * Shared security primitives used across auth, rate limiting, and the proxy.
 *
 * Kept dependency-free and synchronous where possible so it can be hot-path
 * safe. The rate limiter is an in-memory token-bucket per identifier — suitable
 * for a single-process Bun deployment.
 */

/**
 * Constant-time string comparison (timing-safe equal).
 *
 * Avoids early-exit timing side-channels when comparing API keys or tokens.
 * Two strings of different length still run in time proportional to the
 * longer one (we hash-compare via a fixed-length digest to avoid leaking
 * length), but the common-case direct compare is constant-time.
 *
 * Uses node:crypto timingSafeEqual under the hood.
 */
import { timingSafeEqual, createHash } from "node:crypto";

export function constantTimeEqual(a: string, b: string): boolean {
  // Hash both to a fixed-length digest so timingSafeEqual never sees unequal
  // lengths (which would throw) and length is not leaked.
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  try {
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

/**
 * Extract the bearer token from common auth locations.
 * Order: Authorization: Bearer <key> → x-api-key header → ?api_key= query.
 *
 * NOTE: query-param auth is retained for browser/dashboard convenience but
 * should be avoided where possible (leaks in logs). Callers that want to
 * forbid query auth can pass `allowQuery: false`.
 */
export function extractApiKey(
  headers: Headers,
  query?: URLSearchParams | null,
  opts: { allowQuery?: boolean } = {},
): string {
  const authHeader = headers.get("Authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (bearer) return bearer;
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey.trim();
  if (opts.allowQuery !== false && query) {
    const q = query.get("api_key");
    if (q) return q.trim();
  }
  return "";
}

/** Result of a rate-limit check. */
export interface RateLimitResult {
  allowed: boolean;
  /** Epoch ms when the caller may retry (only meaningful when !allowed). */
  retryAfterMs: number;
  /** Remaining tokens in the bucket. */
  remaining: number;
}

interface Bucket {
  tokens: number;
  /** Epoch ms of last refill. */
  lastRefill: number;
}

/**
 * In-memory token-bucket rate limiter, keyed by an arbitrary identifier
 * (IP, API key, route). Not shared across processes — fine for single-process
 * Bun. Evicts idle buckets to bound memory.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly maxTokens: number;
  private readonly refillPerMs: number;
  private readonly idleEvictMs: number;
  private lastSweep = Date.now();

  /**
   * @param capacity   Maximum burst size (tokens in the bucket).
   * @param perMinute  How many tokens refill per minute.
   */
  constructor(capacity: number, perMinute: number) {
    this.maxTokens = capacity;
    this.refillPerMs = perMinute / 60_000;
    this.idleEvictMs = Math.max(60_000, (capacity / perMinute) * 60_000 * 2);
  }

  check(id: string): RateLimitResult {
    this.maybeSweep();
    const now = Date.now();
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(id, b);
    } else {
      const elapsed = now - b.lastRefill;
      b.tokens = Math.min(this.maxTokens, b.tokens + elapsed * this.refillPerMs);
      b.lastRefill = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(b.tokens) };
    }
    const need = 1 - b.tokens;
    const retryAfterMs = Math.ceil(need / this.refillPerMs);
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  /** Remove buckets idle longer than idleEvictMs. */
  private maybeSweep() {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [id, b] of this.buckets) {
      if (now - b.lastRefill > this.idleEvictMs) {
        this.buckets.delete(id);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}