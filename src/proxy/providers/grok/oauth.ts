/**
 * Grok OAuth2/OIDC token lifecycle.
 *
 * Reverse-engineered from the official Grok CLI v0.2.93 (installed at ~/.grok).
 * Source artifacts:
 *   - ~/.grok/auth.json        → credential shape (access JWT + opaque refresh)
 *   - ~/.grok/models_cache.json → upstream base URL (cli-chat-proxy.grok.com/v1)
 *   - https://auth.x.ai/.well-known/openid-configuration → endpoints
 *
 * Flow: token import only (no browser/device automation in etteum). The user
 * supplies a refresh_token (durable) and/or access_token (ES256 JWT, ~6h TTL).
 * etteum exchanges refresh → access on import and auto-refreshes before expiry.
 *
 * Security: the access token is treated as an OPAQUE BEARER — exactly as the
 * CLI does. We do NOT hand-roll JWT signature verification (Iron Law: no custom
 * crypto). We read `exp` only for refresh-scheduling, never trusting it for
 * authz (the upstream validates it; we just avoid wasting a 401).
 */

import type { Account } from "../../../db/schema";

// ---------------------------------------------------------------------------
// Verified constants (from CLI files + OIDC discovery — do not change blindly)
// ---------------------------------------------------------------------------

export const GROK_OAUTH = {
  issuer: "https://auth.x.ai",
  /** OIDC client_id used by the official Grok CLI. */
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  /** Upstream chat surface used by the CLI (Responses API). */
  apiBaseUrl: "https://cli-chat-proxy.grok.com/v1",
  /** Live model-catalog endpoint (ETag-cached by the CLI). */
  modelsEndpoint: "https://cli-chat-proxy.grok.com/v1/models",
  /**
   * Live billing/credits for Grok Build OAuth (JSON).
   * Verified: GET returns { config: { monthlyLimit:{val}, used:{val}, ... } }.
   * Values are the same units the CLI's x.ai/billing RPC uses (credit cents /
   * pool units — never a hardcoded 100 placeholder).
   */
  billingEndpoint: "https://cli-chat-proxy.grok.com/v1/billing",
  /**
   * Shared weekly usage pool as gRPC-web protobuf (used % + reset timestamps).
   * Same surface CodexBar / OmniRoute poll: GrokBuildBilling/GetGrokCreditsConfig.
   * Used when monthlyLimit is 0 (free / non-invoiced pool) so we still report
   * real percent-of-pool remaining instead of a fake 100.
   */
  creditsConfigEndpoint:
    "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
  /** Scopes observed in the CLI's auth.json token request. */
  scopes: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  /** CLI version gate. The cli-chat-proxy requires an x-grok-client-version
   *  header >= its internal floor (ratchets upward over time). A hardcoded
   *  value rots; resolve dynamically via getGrokCliVersion(). */
  cliVersionUrl: "https://x.ai/cli/stable",
  /** Last-resort boot fallback if no dynamic source is reachable. */
  cliVersionFallback: "0.2.93",
} as const;

// ---------------------------------------------------------------------------
// CLI version resolution — rot-proof against CLI updates
// ---------------------------------------------------------------------------

/**
 * The cli-chat-proxy version gate ratchets upward over time. A hardcoded
 * version rots. This resolver picks a valid version from the best available
 * source, in priority order:
 *
 *   1. ~/.grok/version.json  — auto-current if the CLI is installed (it
 *      rewrites this file on every run / self-update). Zero network cost.
 *   2. GROK_CLI_VERSION env  — manual override for locked-down deployments.
 *   3. https://x.ai/cli/stable — the installer's own "latest stable" feed.
 *      Works WITHOUT the CLI installed. Cached 24h to avoid hammering it.
 *   4. cliVersionFallback    — hardcoded boot constant (last resort).
 *
 * As long as EITHER the CLI is installed OR the machine has internet, the
 * version stays current automatically. No code change needed on CLI updates.
 */
let _cachedRemoteVersion: { value: string; fetchedAt: number } | null = null;
const REMOTE_VERSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function readCliVersionFile(): Promise<string | null> {
  try {
    const { readFileSync } = await import("fs");
    const { homedir } = await import("os");
    const { join } = await import("path");
    const path = join(homedir(), ".grok", "version.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string; stable_version?: string };
    return parsed.stable_version || parsed.version || null;
  } catch {
    return null;
  }
}

async function fetchLatestStableVersion(): Promise<string | null> {
  // Return cached if fresh.
  if (_cachedRemoteVersion && Date.now() - _cachedRemoteVersion.fetchedAt < REMOTE_VERSION_TTL_MS) {
    return _cachedRemoteVersion.value;
  }
  try {
    const response = await fetch(GROK_OAUTH.cliVersionUrl, { headers: { Accept: "text/plain" } });
    if (!response.ok) return _cachedRemoteVersion?.value ?? null;
    const version = (await response.text()).trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) return _cachedRemoteVersion?.value ?? null;
    _cachedRemoteVersion = { value: version, fetchedAt: Date.now() };
    return version;
  } catch {
    return _cachedRemoteVersion?.value ?? null;
  }
}

/**
 * Resolve the current Grok CLI version for the x-grok-client-version header.
 * Synchronous-safe: callers should `await` it, but it never throws — on any
 * failure it returns the hardcoded fallback so inference still works.
 */
export async function getGrokCliVersion(): Promise<string> {
  // 1. CLI install on disk (best — auto-current, no network).
  const fromFile = await readCliVersionFile();
  if (fromFile) return fromFile;

  // 2. Manual env override.
  const fromEnv = process.env.GROK_CLI_VERSION;
  if (fromEnv && /^\d+\.\d+\.\d+$/.test(fromEnv)) return fromEnv;

  // 3. Remote latest-stable feed (works without CLI installed).
  const fromRemote = await fetchLatestStableVersion();
  if (fromRemote) return fromRemote;

  // 4. Last-resort fallback.
  return GROK_OAUTH.cliVersionFallback;
}

// ---------------------------------------------------------------------------
// Token shapes
// ---------------------------------------------------------------------------

/** Token bundle persisted in accounts.tokens for an OAuth grok account. */
export interface GrokOAuthTokens {
  auth_method: "oauth";
  /** ES256 JWT access token (~6h TTL). Used as Authorization: Bearer. */
  access_token: string;
  /** Opaque refresh token (durable). Exchanged for new access tokens. */
  refresh_token: string;
  /** Unix seconds when access_token expires (decoded from JWT `exp`). 0 = unknown. */
  expires_at: number;
  /** OIDC client_id the token was issued to (for multi-tenant safety). */
  oidc_client_id: string;
  /** Subject (user id) from the JWT, for identification. */
  sub?: string;
  /** Optional email from farm / id_token claims. */
  email?: string;
  /** Free Build absolute token credits (from x-ratelimit-*-tokens headers). */
  credits_remaining?: number;
  credits_limit?: number;
}

/**
 * Normalize expires_at from number (unix s/ms) or ISO string.
 * Farm batches store ISO strings; if left as strings, `expires_at - now` is NaN
 * and ensureFreshAccessToken always treats the token as expired.
 */
export function normalizeExpiresAt(value: unknown, accessToken?: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 1_000_000_000) {
      return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
    }
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  if (accessToken) {
    const claims = peekJwtClaims(accessToken);
    if (claims.exp) return claims.exp;
  }
  return 0;
}

/**
 * Normalize farm / paste / legacy token blobs into the canonical OAuth shape.
 * Accepts grok-farm accounts.json tokens (`auth_mode: "oidc"`, ISO expires_at).
 */
export function normalizeGrokOAuthTokens(raw: unknown): GrokOAuthTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const access = typeof t.access_token === "string" ? t.access_token.trim() : "";
  if (!access) return null;
  // SSO-only blobs are not OAuth.
  if (typeof t.sso === "string" && t.sso && !t.access_token) return null;

  const refresh = typeof t.refresh_token === "string" ? t.refresh_token.trim() : "";
  const claims = peekJwtClaims(access);
  const clientId =
    (typeof t.oidc_client_id === "string" && t.oidc_client_id) ||
    (typeof t.client_id === "string" && t.client_id) ||
    GROK_OAUTH.clientId;

  const creditsRem = Number(t.credits_remaining);
  const creditsLim = Number(t.credits_limit);

  return {
    auth_method: "oauth",
    access_token: access,
    refresh_token: refresh,
    expires_at: normalizeExpiresAt(t.expires_at, access),
    oidc_client_id: clientId,
    sub: (typeof t.sub === "string" && t.sub) || claims.sub,
    email: typeof t.email === "string" ? t.email : undefined,
    credits_remaining: Number.isFinite(creditsRem) ? creditsRem : undefined,
    credits_limit: Number.isFinite(creditsLim) ? creditsLim : undefined,
  };
}

/** Response from auth.x.ai/oauth2/token on a refresh exchange. */
interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  token_type?: string;
  scope?: string;
  id_token?: string;
}

// ---------------------------------------------------------------------------
// JWT `exp` extraction (decode only — NOT verification)
// ---------------------------------------------------------------------------

/**
 * Decode the `exp` (and `sub`) claims from a JWT access token WITHOUT
 * verifying the signature. We use this ONLY to schedule proactive refresh —
 * the upstream is the authority on validity. Never use this for authz.
 */
export function peekJwtClaims(token: string): { exp?: number; sub?: string; aud?: string } {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    // JWT payload is base64url. Bun's atob handles standard base64; convert.
    const payload = parts[1];
    if (!payload) return {};
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = Buffer.from(b64, "base64").toString("utf-8");
    const claims = JSON.parse(json) as { exp?: number; sub?: string; aud?: string };
    return { exp: claims.exp, sub: claims.sub, aud: claims.aud };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh_token for a fresh access_token at auth.x.ai.
 * Standard OIDC refresh grant. Returns a complete GrokOAuthTokens bundle.
 *
 * @param refreshToken opaque refresh token (from CLI auth.json or user paste)
 * @returns fresh token bundle, or throws on failure
 */
export async function exchangeRefreshToken(refreshToken: string): Promise<GrokOAuthTokens> {
  const trimmed = refreshToken.trim();
  if (!trimmed) throw new Error("empty refresh token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: trimmed,
    client_id: GROK_OAUTH.clientId,
    scope: GROK_OAUTH.scopes,
  });

  const response = await fetch(GROK_OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let reason = `refresh failed (${response.status})`;
    try {
      const errBody = JSON.parse(text) as { error?: string; error_description?: string };
      if (errBody.error === "invalid_grant") {
        // Token revoked/expired/already-rotated. Common when a token was used
        // once before (rotation) or revoked by re-login.
        reason = `refresh token invalid or revoked (${errBody.error_description || "invalid_grant"})`;
      } else if (errBody.error === "invalid_client") {
        // The token was issued to a different OAuth client than ours.
        reason = `wrong OAuth client (token not issued to this client_id)`;
      } else if (errBody.error) {
        reason = `${errBody.error}: ${errBody.error_description || ""}`.trim();
      }
    } catch { /* non-JSON error body */ }
    throw new Error(reason);
  }

  const data = (await response.json()) as TokenEndpointResponse;
  if (!data.access_token) {
    throw new Error("token endpoint returned no access_token");
  }

  const claims = peekJwtClaims(data.access_token);
  const expiresIn = data.expires_in ?? 21600; // default 6h if omitted
  const expiresAt = claims.exp ?? Math.floor(Date.now() / 1000) + expiresIn;

  return {
    auth_method: "oauth",
    access_token: data.access_token,
    // Refresh tokens may rotate — prefer the new one, fall back to the original.
    refresh_token: data.refresh_token || trimmed,
    expires_at: expiresAt,
    oidc_client_id: GROK_OAUTH.clientId,
    sub: claims.sub,
  };
}

/**
 * Build a GrokOAuthTokens bundle from a user-supplied access_token (with an
 * optional refresh_token). Used by single-account import when only an access
 * token is available. If a refresh_token is present, we keep it for later
 * auto-refresh; if not, the account will expire when the access_token does.
 */
export function bundleFromAccessToken(
  accessToken: string,
  refreshToken?: string
): GrokOAuthTokens {
  const claims = peekJwtClaims(accessToken);
  return {
    auth_method: "oauth",
    access_token: accessToken,
    refresh_token: refreshToken ?? "",
    expires_at: claims.exp ?? 0,
    oidc_client_id: GROK_OAUTH.clientId,
    sub: claims.sub,
  };
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

/** Type guard: does an account's token blob use the OAuth / CLI method? */
export function isOAuthAccount(account: Account): boolean {
  return normalizeGrokOAuthTokens(account.tokens) != null;
}

/** Extract a normalized OAuth token bundle from an account, or null. */
export function getOAuthTokens(account: Account): GrokOAuthTokens | null {
  return normalizeGrokOAuthTokens(account.tokens);
}

/**
/**
 * Return the current Bearer access token IF it is still valid (not near expiry).
 * Returns null if the account is not OAuth, or the token is expired/near-expiry.
 *
 * IMPORTANT: this function does NOT refresh. Refresh-token rotation happens via
 * the central refresh-coordinator (locked + deduped + persisted) — either the
 * proactive scheduler (refresh-scheduler.ts) or the router's reactive 401 path
 * (router.ts → coordinatedRefresh). Doing refresh here would bypass the lock and
 * race the coordinator: two concurrent refreshes would rotate the token twice,
 * and the loser's "old" refresh token is already revoked → account bricked.
 *
 * So: when this returns null, the caller throws "expired" → the router catches
 * it → coordinatedRefresh rotates once, safely, and retries.
 *
 * @param account the DB account row
 * @returns a Bearer token string ready for `Authorization`, or null if expired
 */
export async function ensureFreshAccessToken(
  account: Account,
  _onRefreshed?: (tokens: GrokOAuthTokens) => Promise<void>
): Promise<string | null> {
  const tokens = getOAuthTokens(account);
  if (!tokens) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const REFRESH_MARGIN = 300; // 5 minutes before expiry

  // Still valid → use as-is.
  if (tokens.expires_at === 0 || tokens.expires_at - nowSec > REFRESH_MARGIN) {
    return tokens.access_token;
  }

  // Expired / near-expiry → return null. The caller throws "expired"; the
  // router's 401 path rotates via the coordinator (safe, locked, persisted).
  return null;
}

// ---------------------------------------------------------------------------
// Upstream API helpers (cli-chat-proxy.grok.com/v1)
// ---------------------------------------------------------------------------

/** Money/credit amount as returned by xAI billing APIs (`{ val: number }`). */
export interface GrokBillingAmount {
  val?: number;
}

/** JSON body of GET cli-chat-proxy /v1/billing (verified live). */
export interface GrokBillingConfig {
  monthlyLimit?: GrokBillingAmount;
  used?: GrokBillingAmount;
  onDemandCap?: GrokBillingAmount;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  history?: Array<{
    billingCycle?: { year?: number; month?: number };
    includedUsed?: GrokBillingAmount;
    onDemandUsed?: GrokBillingAmount;
    totalUsed?: GrokBillingAmount;
  }>;
}

export interface GrokBillingResponse {
  config?: GrokBillingConfig;
}

/** Normalized quota for the pool/dashboard (no placeholders). */
export interface GrokOAuthQuota {
  limit: number;
  remaining: number;
  used: number;
  resetAt: Date | null;
  /** Provenance so callers can tell paid vs percent-scale pool. */
  source: string;
  /** True when numbers are percent-of-pool (limit always 100). */
  percentScale: boolean;
  raw?: unknown;
}

function moneyVal(v: GrokBillingAmount | undefined): number {
  const n = Number(v?.val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse GET /v1/billing JSON into a quota snapshot when monthlyLimit > 0.
 * Returns null when the response is free-tier shaped (limit 0) so the caller
 * can fall through to the shared-pool percent source.
 */
export function parseGrokBillingJson(
  data: GrokBillingResponse | null | undefined,
  now: Date = new Date(),
): GrokOAuthQuota | null {
  const cfg = data?.config;
  if (!cfg) return null;

  const limit = moneyVal(cfg.monthlyLimit);
  const used = moneyVal(cfg.used);
  const periodEnd = cfg.billingPeriodEnd ? new Date(cfg.billingPeriodEnd) : null;
  const resetAt =
    periodEnd && !Number.isNaN(periodEnd.getTime()) && periodEnd > now
      ? periodEnd
      : periodEnd && !Number.isNaN(periodEnd.getTime())
        ? periodEnd
        : null;

  // Paid / invoiced pool: real absolute units from the API.
  if (limit > 0) {
    const remaining = Math.max(0, limit - used);
    return {
      limit,
      used: Math.max(0, used),
      remaining,
      resetAt,
      source: "cli-chat-proxy/billing",
      percentScale: false,
      raw: data,
    };
  }

  // Free / non-invoiced: monthlyLimit=0. Absolute units are not the source of
  // truth — the shared weekly pool % lives on GetGrokCreditsConfig.
  return null;
}

// ── gRPC-web protobuf scanner for GetGrokCreditsConfig ─────────────────────
// Ported in spirit from CodexBar's GrokWebBillingFetcher: recover used %
// (fixed32 float 0..100) and the soonest future unix reset timestamp.

function readVarint(bytes: Uint8Array, index: { i: number }): number | null {
  let value = 0;
  let shift = 0;
  while (index.i < bytes.length && shift < 64) {
    const byte = bytes[index.i]!;
    index.i += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  return null;
}

function grpcWebDataFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 5 <= data.length) {
    const flags = data[i]!;
    const length =
      (data[i + 1]! << 24) |
      (data[i + 2]! << 16) |
      (data[i + 3]! << 8) |
      data[i + 4]!;
    const start = i + 5;
    const end = start + length;
    if (length < 0 || end > data.length) break;
    if ((flags & 0x80) === 0) frames.push(data.subarray(start, end));
    i = end;
  }
  return frames;
}

interface ProtoScan {
  fixed32: Array<{ path: number[]; value: number }>;
  varints: Array<{ path: number[]; value: number }>;
}

function scanProtobuf(data: Uint8Array, depth: number, path: number[]): ProtoScan {
  const scan: ProtoScan = { fixed32: [], varints: [] };
  const index = { i: 0 };
  while (index.i < data.length) {
    const fieldStart = index.i;
    const key = readVarint(data, index);
    if (key == null || key === 0) {
      index.i = fieldStart + 1;
      continue;
    }
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;
    const fieldPath = [...path, fieldNumber];
    switch (wireType) {
      case 0: {
        const value = readVarint(data, index);
        if (value != null) scan.varints.push({ path: fieldPath, value });
        else index.i = fieldStart + 1;
        break;
      }
      case 1: {
        if (index.i + 8 > data.length) return scan;
        index.i += 8;
        break;
      }
      case 2: {
        const length = readVarint(data, index);
        if (length == null || index.i + length > data.length) {
          index.i = fieldStart + 1;
          break;
        }
        const start = index.i;
        const end = index.i + length;
        if (depth < 4) {
          const nested = scanProtobuf(data.subarray(start, end), depth + 1, fieldPath);
          scan.fixed32.push(...nested.fixed32);
          scan.varints.push(...nested.varints);
        }
        index.i = end;
        break;
      }
      case 5: {
        if (index.i + 4 > data.length) return scan;
        const bits =
          data[index.i]! |
          (data[index.i + 1]! << 8) |
          (data[index.i + 2]! << 16) |
          (data[index.i + 3]! << 24);
        // IEEE-754 float32 little-endian (credit_usage_percent).
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, bits >>> 0, true);
        const f = new DataView(buf).getFloat32(0, true);
        scan.fixed32.push({ path: fieldPath, value: f });
        index.i += 4;
        break;
      }
      default:
        index.i = fieldStart + 1;
    }
  }
  return scan;
}

/**
 * Parse GetGrokCreditsConfig gRPC-web (or raw protobuf) into a percent-scale
 * quota. Omitted credit_usage_percent in a current period → 0% used (proto3).
 */
export function parseGrokCreditsProtobuf(
  data: Uint8Array,
  now: Date = new Date(),
): GrokOAuthQuota | null {
  if (!data.length) return null;

  let payloads = grpcWebDataFrames(data);
  if (payloads.length === 0 && data.length > 0 && (data[0]! >> 3) > 0) {
    payloads = [data];
  }
  if (payloads.length === 0) return null;

  const scan: ProtoScan = { fixed32: [], varints: [] };
  for (const p of payloads) {
    const s = scanProtobuf(p, 0, []);
    scan.fixed32.push(...s.fixed32);
    scan.varints.push(...s.varints);
  }

  const percentCandidates = scan.fixed32.filter(
    (f) => Number.isFinite(f.value) && f.value >= 0 && f.value <= 100,
  );
  // Prefer shallowest field-1 float (credit_usage_percent is typically path ends with 1).
  percentCandidates.sort((a, b) => {
    const aEnd = a.path[a.path.length - 1] === 1 ? 0 : 1;
    const bEnd = b.path[b.path.length - 1] === 1 ? 0 : 1;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.path.length - b.path.length;
  });
  let usedPercent: number | null =
    percentCandidates.length > 0 ? percentCandidates[0]!.value : null;

  // Epoch-looking varints mark a period window even after it has ended.
  // Do NOT filter by "now" before deciding usedPercent — a fixture captured
  // mid-period must still parse as 0% used weeks later (proto3 omit of
  // credit_usage_percent). resetAt still prefers future timestamps.
  const periodTimestamps = scan.varints
    .map((v) => v.value)
    .filter((ts) => ts >= 1_700_000_000 && ts <= 2_100_000_000)
    .map((ts) => new Date(ts * 1000));

  const futureResets = periodTimestamps.filter((d) => d.getTime() > now.getTime() - 60_000);
  const resetAt =
    (futureResets.length ? futureResets : periodTimestamps)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  // Period present (unix timestamps found) + no percent field → 0% used (proto3 omit).
  if (usedPercent == null && periodTimestamps.length > 0) {
    usedPercent = 0;
  }
  if (usedPercent == null) return null;

  const used = Math.min(100, Math.max(0, Math.round(usedPercent)));
  const limit = 100;
  const remaining = Math.max(0, limit - used);

  return {
    limit,
    used,
    remaining,
    resetAt,
    source: "grok.com/GetGrokCreditsConfig",
    percentScale: true,
    raw: { usedPercent, resetAt: resetAt?.toISOString() ?? null },
  };
}

/**
 * Free Build package size observed on cli-chat-proxy rate-limit headers
 * (`x-ratelimit-limit-tokens`). Used when free-usage is exhausted and xAI
 * returns 429 without headers so the dashboard still shows a real package
 * (2M / 0) instead of the unrelated percent-scale 100.
 */
export const GROK_FREE_BUILD_TOKEN_LIMIT = 2_000_000;

/** True when the absolute probe reported free Build subscription exhaustion. */
export function isGrokFreeUsageExhaustedQuota(
  q: GrokOAuthQuota | null | undefined,
): boolean {
  if (!q || q.percentScale) return false;
  return (
    q.source.includes("free-usage-exhausted") ||
    (q.remaining <= 0 && q.source.includes("exhausted"))
  );
}

/**
 * Free Build `x-ratelimit-remaining-tokens` often equals the full package
 * (2_000_000) even after heavy use — live probes confirmed this. That value
 * is a package ceiling, NOT live remaining. Only trust remaining when it is
 * strictly below the limit (real burn signal) or free-usage exhausted (0).
 */
export function isTrustedGrokAbsoluteRemaining(
  limit: number,
  remaining: number,
): boolean {
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return false;
  if (limit <= 0) return remaining <= 0;
  return remaining < limit;
}

/**
 * Tag / normalize an absolute free-Build snapshot so warmup will not re-inflate
 * every healthy account to full package remaining.
 */
export function normalizeGrokAbsoluteRemaining(
  q: GrokOAuthQuota,
): GrokOAuthQuota {
  if (q.percentScale) return q;
  if (isGrokFreeUsageExhaustedQuota(q)) return q;
  if (q.limit > 0 && !isTrustedGrokAbsoluteRemaining(q.limit, q.remaining)) {
    return {
      ...q,
      // Keep remaining=limit for shape, but mark source untrusted so warmup
      // preserves local debit tracking instead of writing full package.
      source: q.source.includes("untrusted-full-remaining")
        ? q.source
        : `${q.source}+untrusted-full-remaining`,
    };
  }
  return q;
}

/**
 * True when DB quota columns store the CLI weekly pool (0–100 scale), not
 * absolute free-Build tokens (~2e6). Local token debit must not run on this
 * scale (one request would wipe remaining).
 */
export function isGrokWeeklyPercentQuotaLimit(limit: number | null | undefined): boolean {
  const lim = Number(limit);
  return Number.isFinite(lim) && lim > 0 && lim <= 100;
}

/**
 * Pick the best Grok OAuth quota snapshot for dashboard + pool accounting.
 *
 * Free-tier CLI truth is GetGrokCreditsConfig (weekly percent 0–100), not
 * x-ratelimit headers (often stuck at full package) and not /v1/billing
 * (monthlyLimit=0 on free).
 *
 * Priority:
 *   1. Paid absolute billing (limit > 0)
 *   2. free-usage-exhausted → remaining 0 (prefer percent-scale shape when available)
 *   3. Trusted absolute burn (remaining < limit on free Build headers)
 *   4. Weekly percent (CLI GetGrokCreditsConfig) — free tier default
 *   5. Untrusted full absolute headers → skip (do not re-inflate to 2M)
 */
export function selectGrokOAuthQuota(
  paid: GrokOAuthQuota | null | undefined,
  absolute: GrokOAuthQuota | null | undefined,
  percent: GrokOAuthQuota | null | undefined,
): GrokOAuthQuota | null {
  if (paid && paid.limit > 0 && !paid.percentScale) return paid;

  // Chat entitlement gone for this window — never report healthy 100%.
  if (absolute && isGrokFreeUsageExhaustedQuota(absolute)) {
    if (percent?.percentScale) {
      return {
        ...percent,
        remaining: 0,
        used: 100,
        limit: 100,
        percentScale: true,
        source: `${absolute.source}+weekly-percent`,
        resetAt: percent.resetAt ?? absolute.resetAt ?? null,
      };
    }
    const limit =
      absolute.limit > 0 ? Math.floor(absolute.limit) : GROK_FREE_BUILD_TOKEN_LIMIT;
    return {
      ...absolute,
      limit,
      remaining: 0,
      used: limit,
      percentScale: false,
      resetAt: absolute.resetAt ?? percent?.resetAt ?? null,
    };
  }

  // Rare: headers report real burn (remaining strictly below package).
  if (
    absolute &&
    absolute.limit > 0 &&
    !absolute.percentScale &&
    isTrustedGrokAbsoluteRemaining(absolute.limit, absolute.remaining)
  ) {
    let out = absolute;
    if (!absolute.resetAt && percent?.resetAt) {
      out = { ...absolute, resetAt: percent.resetAt };
    }
    return out;
  }

  // Free / unified Build default — same surface the Grok CLI uses.
  if (percent && percent.percentScale) return percent;

  // Untrusted full remaining (2M/2M or 53M/53M) — do not write as live budget.
  if (absolute && absolute.limit > 0 && !absolute.percentScale) {
    const norm = normalizeGrokAbsoluteRemaining(absolute);
    if (norm.source.includes("untrusted-full-remaining")) return null;
    if (!norm.resetAt && percent?.resetAt) {
      return { ...norm, resetAt: percent.resetAt };
    }
    return norm;
  }

  if (absolute && !absolute.percentScale && absolute.limit > 0) return absolute;
  if (paid && !paid.percentScale) return paid;
  return null;
}

/**
 * Fetch real OAuth quota for a Grok Build account.
 *
 * 1. GET /v1/billing — absolute monthlyLimit/used when paid (limit > 0).
 * 2. Absolute free Build credits via rate-limit headers on a tiny probe.
 * 3. Else POST GetGrokCreditsConfig — shared pool percent (limit=100 scale).
 * 4. Never invent a fake 100/100 placeholder when every source fails.
 */
export async function fetchOAuthBillingQuota(
  bearer: string,
  signal?: AbortSignal,
): Promise<GrokOAuthQuota | null> {
  const cliVersion = await getGrokCliVersion();

  let paid: GrokOAuthQuota | null = null;
  let absolute: GrokOAuthQuota | null = null;
  let percent: GrokOAuthQuota | null = null;

  // 1) JSON billing (paid monthly pool).
  try {
    const response = await fetch(GROK_OAUTH.billingEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        "x-grok-client-version": cliVersion,
      },
      signal,
    });
    if (response.ok) {
      const json = (await response.json()) as GrokBillingResponse;
      paid = parseGrokBillingJson(json);
    } else if (response.status === 402) {
      paid = {
        limit: 0,
        remaining: 0,
        used: 0,
        resetAt: null,
        source: "cli-chat-proxy/billing",
        percentScale: false,
        raw: { status: 402 },
      };
    }
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
  }

  // Paid absolute pool wins immediately (no extra probe cost).
  if (paid && paid.limit > 0 && !paid.percentScale) return paid;

  // 2) Farm-compatible absolute free Build credits (x-ratelimit-*-tokens).
  //    Must run BEFORE GetGrokCreditsConfig — that endpoint always returns a
  //    percent-scale 100 and would hide real 2M token budgets forever.
  try {
    absolute = await probeOAuthChatCredits(bearer, signal);
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
  }

  // 3) Shared weekly pool percent (reset window / usage %).
  try {
    const response = await fetch(GROK_OAUTH.creditsConfigEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Origin: "https://grok.com",
        Referer: "https://grok.com/?_s=usage",
        Accept: "*/*",
        "Content-Type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
      },
      // Empty gRPC-web data frame (flags=0, length=0).
      body: new Uint8Array([0, 0, 0, 0, 0]),
      signal,
    });
    if (response.ok) {
      const buf = new Uint8Array(await response.arrayBuffer());
      percent = parseGrokCreditsProtobuf(buf);
    }
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
  }

  const selected = selectGrokOAuthQuota(paid, absolute, percent);
  // A headers-missing liveness hit (limit=0 remaining=0) is NOT a usable
  // credit snapshot — callers must not write 0/0 over a real free Build budget.
  if (
    selected &&
    selected.limit <= 0 &&
    selected.remaining <= 0 &&
    !selected.source.includes("free-usage-exhausted") &&
    !selected.source.includes("exhausted") &&
    selected.source !== "cli-chat-proxy/billing"
  ) {
    return null;
  }
  return selected;
}

/**
 * Farm-compatible free Build credit probe: POST /v1/responses with max_output_tokens=16
 * and read absolute token quota from x-ratelimit-*-tokens response headers.
 *
 * Also treats free-usage-exhausted / 402 as remaining=0 so warmup can mark the
 * account exhausted instead of leaving a stale full 2M snapshot.
 */
export async function probeOAuthChatCredits(
  bearer: string,
  signal?: AbortSignal,
): Promise<GrokOAuthQuota | null> {
  const cliVersion = await getGrokCliVersion();
  const response = await fetch(`${GROK_OAUTH.apiBaseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-grok-client-version": cliVersion,
      "x-grok-client-identifier": "grok-build",
      "x-grok-client-surface": "grok-build",
    },
    body: JSON.stringify({
      model: "grok-4.5",
      input: "Reply with exactly: OK",
      stream: false,
      max_output_tokens: 16,
    }),
    signal,
  });

  const rem = Number(response.headers.get("x-ratelimit-remaining-tokens"));
  const lim = Number(response.headers.get("x-ratelimit-limit-tokens"));
  if (Number.isFinite(rem) && Number.isFinite(lim) && lim > 0) {
    return {
      limit: lim,
      remaining: Math.max(0, rem),
      used: Math.max(0, lim - rem),
      resetAt: null,
      source: "cli-chat-proxy/ratelimit-headers",
      percentScale: false,
      raw: {
        status: response.status,
        ok: response.ok,
        rem,
        lim,
      },
    };
  }

  // Headers missing — read body for credit-decline / free-usage exhaustion.
  // (xAI often returns 429 + subscription:free-usage-exhausted without remaining headers.)
  const text = await response.text().catch(() => "");
  const lower = text.toLowerCase();
  const exhausted =
    response.status === 402 ||
    lower.includes("free-usage-exhausted") ||
    lower.includes("spending-limit") ||
    lower.includes("spending_limit") ||
    lower.includes("you've used all") ||
    lower.includes("you have used all") ||
    lower.includes("payment required");

  if (exhausted) {
    // Live: free-usage 429 has empty rate-limit headers. Use the known free
    // Build package size so select/warmup write 2_000_000 / 0 (exhausted),
    // never fall through to GetGrokCreditsConfig percent 100.
    const limit =
      Number.isFinite(lim) && lim > 0 ? lim : GROK_FREE_BUILD_TOKEN_LIMIT;
    return {
      limit,
      remaining: 0,
      used: limit,
      resetAt: null,
      source: "cli-chat-proxy/free-usage-exhausted",
      percentScale: false,
      raw: { status: response.status, body: text.slice(0, 200) },
    };
  }

  // No rate-limit headers — still useful as a liveness signal when 200.
  if (response.ok) {
    return {
      limit: 0,
      remaining: 0,
      used: 0,
      resetAt: null,
      source: "cli-chat-proxy/responses-probe",
      percentScale: false,
      raw: { status: response.status, headersMissing: true },
    };
  }

  return null;
}

/**
 * True when a live Grok OAuth quota snapshot is absolute free-Build / paid
 * tokens (not the percent-scale 0–100 weekly pool placeholder).
 */
export function isAbsoluteGrokOAuthQuota(q: GrokOAuthQuota | null | undefined): boolean {
  return !!q && !q.percentScale && typeof q.limit === "number" && q.limit > 0;
}

/**
 * Fetch the live model catalog from the CLI upstream. ETag-cached like the
 * CLI's models_cache.json. Returns null on failure (caller falls back to the
 * hardcoded list).
 *
 * The endpoint returns OpenAI-format `{ object:"list", data:[{id,...}] }`.
 *
 * @param bearer access token
 * @param etag last-known ETag for conditional request (optional)
 */
export async function fetchModelsCatalog(
  bearer: string,
  etag?: string
): Promise<{ models: Record<string, unknown>; etag?: string } | null> {
  const cliVersion = await getGrokCliVersion();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    "x-grok-client-version": cliVersion,
  };
  if (etag) headers["If-None-Match"] = etag;

  try {
    const response = await fetch(GROK_OAUTH.modelsEndpoint, { headers });
    if (response.status === 304) return null; // not modified; caller keeps cache
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: Array<{ id: string }>; models?: Record<string, unknown> };
    // Normalize both shapes: OpenAI {data:[...]} and CLI {models:{...}}.
    if (json.models) return { models: json.models, etag: response.headers.get("etag") ?? undefined };
    if (json.data) {
      const map: Record<string, unknown> = {};
      for (const m of json.data) map[m.id] = m;
      return { models: map, etag: response.headers.get("etag") ?? undefined };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Lightweight "is this token alive?" check. Calls GET /v1/models (no token cost)
 * and returns true on 200/304.
 *
 * Does NOT rotate refresh tokens. Callers that need a valid access JWT when the
 * stored one is expired (warmup healthCheck, validateAccount) must refresh first
 * via coordinatedRefresh / provider.refreshToken, then call this.
 */
export async function validateOAuthToken(
  account: Account,
  onRefreshed?: (tokens: GrokOAuthTokens) => Promise<void>
): Promise<{ alive: boolean; refreshed: boolean }> {
  const bearer = await ensureFreshAccessToken(account, onRefreshed);
  if (!bearer) return { alive: false, refreshed: false };

  const wasRefreshed = (() => {
    const tokens = getOAuthTokens(account);
    if (!tokens) return false;
    // If the bearer we just got differs from the stored access token, we refreshed.
    return bearer !== tokens.access_token;
  })();

  try {
    const cliVersion = await getGrokCliVersion();
    const response = await fetch(GROK_OAUTH.modelsEndpoint, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        "x-grok-client-version": cliVersion,
      },
    });
    return { alive: response.ok || response.status === 304, refreshed: wasRefreshed };
  } catch {
    return { alive: false, refreshed: wasRefreshed };
  }
}
