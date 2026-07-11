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

/** Type guard: does an account's token blob use the OAuth method? */
export function isOAuthAccount(account: Account): boolean {
  const tokens = account.tokens as Record<string, unknown> | null;
  return tokens?.auth_method === "oauth" && typeof tokens.access_token === "string";
}

/** Extract the OAuth token bundle from an account, or null. */
export function getOAuthTokens(account: Account): GrokOAuthTokens | null {
  if (!isOAuthAccount(account)) return null;
  return account.tokens as unknown as GrokOAuthTokens;
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
 * Lightweight "is this token alive?" check for warmup. Calls GET /v1/models
 * (no token cost) and returns true on 200/304. Optionally refreshes the token
 * first if near-expiry.
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
