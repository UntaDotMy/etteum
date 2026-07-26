/**
 * Token self-heal: near-expiry / missing expires_at must force refresh path;
 * proactive scheduler must parse ISO + JWT exp; warmup must rotate + persist.
 *
 * External truth (not training data):
 * - https://auth.x.ai/.well-known/openid-configuration — grant_types includes refresh_token
 * - RFC 6749 §6 — refresh grant; if new RT issued, client MUST replace old
 * - RFC 9700 — refresh token rotation / single-use
 */
import { describe, test, expect, mock, afterEach, beforeAll } from "bun:test";
import {
  ensureFreshAccessToken,
  resolveGrokAccessExpiresAtSec,
  GROK_ACCESS_REFRESH_MARGIN_SEC,
  normalizeGrokOAuthTokens,
} from "../../src/proxy/providers/grok/oauth";
import { extractExpiryMs } from "../../src/auth/refresh-scheduler";
import { GrokProvider } from "../../src/proxy/providers/grok/index";
import { setRefreshBackoffBaseMs } from "../../src/auth/refresh-coordinator";
import type { Account } from "../../src/db/schema";

beforeAll(() => setRefreshBackoffBaseMs(0));

function makeJwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: expSec, sub: "heal-sub", aud: "b1a00492-073a-47ea-816f-4c329264a828" }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeAccount(tokens: Record<string, unknown>): Account {
  return {
    id: 9001,
    provider: "grok",
    email: "heal@oauth",
    password: "",
    status: "active",
    enabled: true,
    tokens,
    quotaLimit: 100,
    quotaRemaining: 50,
    quotaResetAt: null,
    freeLimit: null,
    freeRemaining: null,
    freeResetAt: null,
    lastUsed: null,
    errorMessage: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Account;
}

describe("resolveGrokAccessExpiresAtSec / ensureFreshAccessToken", () => {
  test("fresh access (> margin) returns bearer", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const account = makeAccount({
      auth_method: "oauth",
      access_token: makeJwt(exp),
      refresh_token: "rt_ok",
      expires_at: exp,
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    const bearer = await ensureFreshAccessToken(account);
    expect(bearer).toBeTruthy();
    expect(bearer).toBe((account.tokens as any).access_token);
  });

  test("near-expiry within margin returns null (must heal via coordinator)", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60; // 1 min left < 5 min margin
    expect(GROK_ACCESS_REFRESH_MARGIN_SEC).toBe(300);
    const account = makeAccount({
      auth_method: "oauth",
      access_token: makeJwt(exp),
      refresh_token: "rt_ok",
      expires_at: exp,
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    expect(await ensureFreshAccessToken(account)).toBeNull();
  });

  test("already expired returns null", async () => {
    const exp = Math.floor(Date.now() / 1000) - 30;
    const account = makeAccount({
      auth_method: "oauth",
      access_token: makeJwt(exp),
      refresh_token: "rt_ok",
      expires_at: exp,
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    expect(await ensureFreshAccessToken(account)).toBeNull();
  });

  test("expires_at=0 peeks JWT exp — still valid uses bearer", async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const access = makeJwt(exp);
    const account = makeAccount({
      auth_method: "oauth",
      access_token: access,
      refresh_token: "rt_ok",
      expires_at: 0,
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    const n = normalizeGrokOAuthTokens(account.tokens);
    // normalize peeks JWT into expires_at when stored as 0? check resolve path
    expect(resolveGrokAccessExpiresAtSec(n!)).toBe(exp);
    expect(await ensureFreshAccessToken(account)).toBe(access);
  });

  test("expires_at=0 and JWT already expired → null (force heal)", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    const account = makeAccount({
      auth_method: "oauth",
      access_token: makeJwt(exp),
      refresh_token: "rt_ok",
      expires_at: 0,
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    // Old bug: expires_at===0 always returned access_token forever.
    expect(await ensureFreshAccessToken(account)).toBeNull();
  });
});

describe("extractExpiryMs (proactive scheduler)", () => {
  test("unix seconds", () => {
    expect(extractExpiryMs({ expires_at: 1_784_180_000 })).toBe(1_784_180_000_000);
  });

  test("ISO-8601 farm string (was skipped by old Number() parse)", () => {
    const iso = "2026-07-16T20:00:00.000Z";
    const ms = extractExpiryMs({ expires_at: iso });
    expect(ms).toBe(Date.parse(iso));
  });

  test("JWT exp fallback when expires_at missing", () => {
    const exp = 1_784_200_000;
    const ms = extractExpiryMs({ access_token: makeJwt(exp) });
    expect(ms).toBe(exp * 1000);
  });
});

describe("GrokProvider.healthCheck heals near-expired OAuth on warmup path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("near-expired AT → refreshToken + weekly quota → healthy with new tokens", async () => {
    const exp = Math.floor(Date.now() / 1000) + 30; // inside 5m margin
    const oldAt = makeJwt(exp);
    const newExp = Math.floor(Date.now() / 1000) + 21_600;
    const newAt = makeJwt(newExp);
    let refreshCalls = 0;

    const account = makeAccount({
      auth_method: "oauth",
      access_token: oldAt,
      refresh_token: "rt_old",
      expires_at: exp,
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      sub: "heal-sub",
    });

    class HealGrok extends GrokProvider {
      override async refreshToken() {
        refreshCalls++;
        return {
          success: true,
          tokens: JSON.stringify({
            auth_method: "oauth",
            access_token: newAt,
            refresh_token: "rt_new_rotated",
            expires_at: newExp,
            oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
            sub: "heal-sub",
          }),
        };
      }
      override async fetchQuota() {
        return {
          success: true,
          quota: {
            limit: 100,
            remaining: 88,
            used: 12,
            resetAt: null as Date | null,
            source: "grok.com/GetGrokCreditsConfig",
            percentScale: true,
          },
        };
      }
      // Isolate token-heal path from throttled chat liveness hop.
      protected override async runChatLivenessProbe() {
        return { reason: "ok" as const, status: 200 };
      }
    }

    // Avoid real DB write if pool.updateTokens is invoked — intercept via mock
    // of the dynamic import target by stubbing fetch only for models if needed.
    const provider = new HealGrok();
    // pool.updateTokens hits DB; use spy if available. On this machine DB exists.
    const health = await provider.healthCheck(account);

    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    expect(health.success).toBe(true);
    expect(health.kind).toBe("healthy");
    expect(health.tokens).toBeTruthy();
    const tok = health.tokens as any;
    expect(tok.refresh_token || tok).toBeTruthy();
    // coordinator parses JSON string → object
    const rt =
      typeof health.tokens === "object" && health.tokens
        ? (health.tokens as any).refresh_token
        : null;
    expect(rt).toBe("rt_new_rotated");
    expect(health.quota?.remaining).toBe(88);
  });
});
