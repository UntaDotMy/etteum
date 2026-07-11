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

// --- Access-control tier (closes management-API exposure HIGH cluster) ---
// Mirrors 9router's dashboardGuard.js: spawn-capable + secret-reading routes
// must be reachable only from localhost, OR via a machine-bound CLI token.
// Without this, a leaked API key → remote code execution (update.ts spawns
// git/build/migrate) and host-secret reads.

/** Private loopback ranges — a request is "local" if its real origin is here. */
const LOOPBACK_PREFIXES = ["127.", "::1", "::ffff:127."];

/**
 * Determine the real client IP for security decisions.
 *
 * SECURITY: x-forwarded-for / x-real-ip / x-9r-real-ip are ALL client-
 * controllable headers. They MUST NOT be trusted for loopback/admin
 * decisions unless the deployment is explicitly behind a trusted reverse
 * proxy (TRUST_PROXY=true). Reading them unconditionally enabled a trivial
 * auth-bypass: a remote attacker sets `x-real-ip: 127.0.0.1` and is treated
 * as local by adminGuard → RCE via /api/update/apply. (CWE-348; OWASP "IP
 * Spoofing via HTTP Headers"; CVE-2025-13694 / CVE-2026-0033 class.)
 *
 * When TRUST_PROXY is not set, callers must rely on the actual TCP socket
 * peer (preferred — see isLocalOriginFromPeer / adminGuardFromPeer) and
 * treat header-derived IPs as untrusted, returning "unknown".
 */
export function realClientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY === "true") {
    // Behind a trusted proxy that overwrites these headers — safe to read.
    const realIp = headers.get("x-9r-real-ip") || headers.get("x-real-ip");
    if (realIp) return realIp.trim();
    const xff = headers.get("x-forwarded-for");
    if (xff) return (xff.split(",")[0] || "").trim();
  }
  return "unknown";
}

/**
 * Loopback check from a known-trusted TCP socket peer (Bun
 * server.requestIP()). This is the preferred path for admin/loopback
 * decisions because the peer address cannot be spoofed by the client.
 */
export function isLoopbackPeer(peerIp: string | null | undefined): boolean {
  if (!peerIp) return false;
  return isLoopbackIp(peerIp);
}

/**
 * Decide local-origin for admin guarding using the TCP peer as the source of
 * truth, falling back to header-derived IP only under TRUST_PROXY. Use this
 * (or adminGuardFromPeer) instead of the header-only isLocalOrigin for any
 * spawn-capable / secret-disclosure route.
 */
export function isLocalOriginFromPeer(
  peerIp: string | null | undefined,
  headers: Headers,
): boolean {
  if (process.env.ALLOW_REMOTE_ADMIN === "true") return true;
  // 1. Trust the TCP socket peer first (non-spoofable).
  if (peerIp) return isLoopbackIp(peerIp);
  // 2. Fallback: header-derived IP, only if behind a trusted proxy.
  if (process.env.TRUST_PROXY === "true") {
    return isLoopbackIp(realClientIp(headers));
  }
  // 3. No peer info and no trusted proxy → cannot prove local → fail closed.
  return false;
}

/**
 * adminGuard variant that accepts a TCP peer IP. Prefer this over the
 * header-only adminGuard() on routes that have access to the raw request
 * (and thus server.requestIP()).
 */
export function adminGuardFromPeer(
  peerIp: string | null | undefined,
  headers: Headers,
  query?: URLSearchParams | null,
): { allowed: boolean; reason: string } {
  if (isLocalOriginFromPeer(peerIp, headers)) return { allowed: true, reason: "local" };
  const token = extractCliAdminToken(headers, query);
  if (token && isValidCliAdminToken(token)) return { allowed: true, reason: "cli-token" };
  return {
    allowed: false,
    reason: "admin actions require a local origin (TCP peer) or a valid x-9r-cli-token (CLI_ADMIN_TOKEN)",
  };
}

/**
 * Extract the TCP socket peer IP from a Hono context (Bun.serve).
 * Bun populates `c.env.server` (the BunServer) on requests; its
 * `server.requestIP(request)` returns the real socket peer, which a client
 * cannot spoof — unlike x-forwarded-for / x-real-ip headers.
 * Returns null when unavailable (non-Bun runtime, no server in env, or the
 * socket is gone). Callers must treat null as "unknown origin" → fail closed.
 */
export function peerIpFromHonoContext(c: any): string | null {
  try {
    const server = c?.env?.server ?? c?.env?.runtime?.server;
    if (server && typeof server.requestIP === "function") {
      const addr = server.requestIP(c.req.raw);
      if (addr) {
        // Bun returns { address, family, port } (SocketAddress).
        return typeof addr === "string" ? addr : (addr as any).address ?? null;
      }
    }
  } catch { /* best effort */ }
  return null;
}

/** True if the IP is a loopback address. */
export function isLoopbackIp(ip: string): boolean {
  if (!ip || ip === "unknown") return false;
  return LOOPBACK_PREFIXES.some((p) => ip.startsWith(p));
}

/**
 * Proxy-hop-aware loopback detection. A request behind a reverse proxy looks
 * like it comes from the proxy (loopback) even when the real client is remote.
 * To decide "is the TRUE origin local", walk the full XFF chain (when trusted)
 * and require the FIRST HOP (the real client) to be loopback. If TRUST_PROXY is
 * not set, we fall back to the direct socket peer — but in that case
 * x-forwarded-for is attacker-controllable, so we treat unknown as non-local.
 */
export function isLocalOrigin(headers: Headers): boolean {
  // Explicit override for trusted-proxy deployments where the operator has
  // already ensured the proxy strips/sets XFF correctly.
  if (process.env.ALLOW_REMOTE_ADMIN === "true") return true;
  const ip = realClientIp(headers);
  return isLoopbackIp(ip);
}

/**
 * The machine-bound CLI token. Set once by the operator (env or a local file)
 * and required for spawn-capable/secret routes when the request is NOT local.
 * This is separate from the API key (which authorizes proxy traffic) so a
 * leaked API key alone cannot trigger admin actions.
 */
export function cliAdminToken(): string {
  return process.env.CLI_ADMIN_TOKEN || process.env.ETTEUM_CLI_TOKEN || "";
}

/** Validate a presented CLI admin token (constant-time). */
export function isValidCliAdminToken(presented: string): boolean {
  const expected = cliAdminToken();
  if (!expected) return false; // no token configured → no remote admin at all
  return constantTimeEqual(presented, expected);
}

/** Extract a CLI admin token from the x-9r-cli-token header or ?cli_token=. */
export function extractCliAdminToken(headers: Headers, query?: URLSearchParams | null): string {
  const h = headers.get("x-9r-cli-token");
  if (h) return h.trim();
  if (query) {
    const q = query.get("cli_token");
    if (q) return q.trim();
  }
  return "";
}

/**
 * Guard for spawn-capable / secret-reading management routes (update.ts,
 * management.ts, dashboardAuth reset-password, oauth.ts).
 *
 * Allows the request iff:
 *   (a) the TRUE origin is local (loopback), OR
 *   (b) a valid machine-bound CLI admin token is presented.
 * Returns an error Response (to short-circuit the route) or null (allow).
 */
export function adminGuard(
  headers: Headers,
  query?: URLSearchParams | null,
): { allowed: boolean; reason: string } {
  if (isLocalOrigin(headers)) return { allowed: true, reason: "local" };
  const token = extractCliAdminToken(headers, query);
  if (token && isValidCliAdminToken(token)) return { allowed: true, reason: "cli-token" };
  return {
    allowed: false,
    reason: isLocalOrigin(headers)
      ? "local"
      : "admin actions require a local origin or a valid x-9r-cli-token (CLI_ADMIN_TOKEN)",
  };
}