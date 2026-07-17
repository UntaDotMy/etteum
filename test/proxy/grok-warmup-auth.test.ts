/**
 * Regression: Grok warmup must not mass-kill OAuth accounts as
 * "OAuth access token invalid after refresh" when:
 *   - an auth'd live quota probe already succeeded with the bearer, or
 *   - /v1/models returns 403 Access denied (Build policy ≠ dead RT), or
 *   - /v1/models fails transiently (network/5xx).
 *
 * Permanent RT death (invalid_grant / missing RT) still maps to auth_error.
 */
import { describe, test, expect, mock, afterEach, beforeAll } from "bun:test";
import {
  classifyGrokModelsLiveness,
  classifyGrokOAuthFallbackFromModels,
  GrokProvider,
} from "../../src/proxy/providers/grok/index";
import { mapHealthToAccountUpdate } from "../../src/auth/warmup-runner";
import { setRefreshBackoffBaseMs } from "../../src/auth/refresh-coordinator";
import type { Account } from "../../src/db/schema";
import type { ProviderHealthResult } from "../../src/proxy/providers/base";

beforeAll(() => {
  // why: coordinatedRefresh retries transient failures with 1s/2s backoff
  setRefreshBackoffBaseMs(0);
});

function makeJwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: expSec, sub: "test-sub", aud: "b1a00492-073a-47ea-816f-4c329264a828" }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeOAuthAccount(overrides: Partial<Account> = {}): Account {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  // Default: recent chat probe so credit/models-path tests stay isolated from
  // the throttled POST /responses hop (covered in grok-chat-probe tests).
  const baseMeta = {
    warmup: {
      lastChatProbeAt: new Date().toISOString(),
      chatProbe: "ok",
    },
  };
  return {
    id: 42,
    provider: "grok",
    email: "grok-test@oauth",
    password: "",
    status: "active",
    enabled: true,
    tokens: {
      auth_method: "oauth",
      access_token: makeJwt(exp),
      refresh_token: "rt_test_not_dead",
      expires_at: exp,
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      sub: "test-sub",
    },
    quotaLimit: 100,
    quotaRemaining: 80,
    quotaResetAt: null,
    freeLimit: null,
    freeRemaining: null,
    freeResetAt: null,
    lastUsed: null,
    errorMessage: null,
    metadata: baseMeta,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Account;
}

describe("classifyGrokModelsLiveness", () => {
  test("200/304 → alive ok", () => {
    expect(classifyGrokModelsLiveness({ httpStatus: 200 }).alive).toBe(true);
    expect(classifyGrokModelsLiveness({ httpStatus: 304 }).reason).toBe("ok");
  });

  test("403 Access denied is Build block, not refresh death", () => {
    const r = classifyGrokModelsLiveness({
      httpStatus: 403,
      bodySnippet: '{"error":"Access denied"}',
    });
    expect(r.alive).toBe(false);
    expect(r.reason).toBe("access_denied");
    expect(r.error).toMatch(/Access denied \(403\)/i);
    expect(r.error).not.toMatch(/invalid after refresh/i);
    expect(r.error).toMatch(/not a dead refresh token/i);
  });

  test("401 → unauthorized", () => {
    const r = classifyGrokModelsLiveness({ httpStatus: 401 });
    expect(r.reason).toBe("unauthorized");
    expect(r.error).not.toMatch(/invalid after refresh/i);
  });

  test("network null status → transient", () => {
    const r = classifyGrokModelsLiveness({
      httpStatus: null,
      networkError: "fetch failed",
    });
    expect(r.reason).toBe("transient");
  });

  test("5xx / 429 → transient", () => {
    expect(classifyGrokModelsLiveness({ httpStatus: 503 }).reason).toBe("transient");
    expect(classifyGrokModelsLiveness({ httpStatus: 429 }).reason).toBe("transient");
  });
});

describe("classifyGrokOAuthFallbackFromModels", () => {
  test("ok → healthy", () => {
    const r = classifyGrokOAuthFallbackFromModels({
      alive: true,
      reason: "ok",
      status: 200,
    });
    expect(r.kind).toBe("healthy");
    expect(r.success).toBe(true);
  });

  test("access_denied → banned (not session_expired / not invalid after refresh)", () => {
    const r = classifyGrokOAuthFallbackFromModels({
      alive: false,
      reason: "access_denied",
      status: 403,
      error:
        "cli-chat-proxy Access denied (403) — Build API blocked (not a dead refresh token)",
    });
    expect(r.kind).toBe("banned");
    expect(r.retryable).toBe(false);
    expect(r.error).not.toMatch(/invalid after refresh/i);
  });

  test("unauthorized → session_expired", () => {
    const r = classifyGrokOAuthFallbackFromModels({
      alive: false,
      reason: "unauthorized",
      status: 401,
      error: "OAuth access token rejected by cli-chat-proxy (401)",
    });
    expect(r.kind).toBe("session_expired");
  });

  test("transient → transient_error (warmup must not hard-error the row)", () => {
    const r = classifyGrokOAuthFallbackFromModels({
      alive: false,
      reason: "transient",
      error: "fetch failed",
    });
    expect(r.kind).toBe("transient_error");
    expect(r.retryable).toBe(true);
  });
});

describe("mapHealthToAccountUpdate — warmup status policy", () => {
  const base = makeOAuthAccount({ status: "active" });

  test("transient_error keeps active (no mass death)", () => {
    const update = mapHealthToAccountUpdate(base, {
      kind: "transient_error",
      success: false,
      retryable: true,
      error: "models probe HTTP 503",
    });
    expect(update.status).toBe("active");
  });

  test("banned maps to error with Build-deny message (not refresh wording)", () => {
    const update = mapHealthToAccountUpdate(base, {
      kind: "banned",
      success: false,
      error:
        "cli-chat-proxy Access denied (403) — Build API blocked (not a dead refresh token)",
    });
    expect(update.status).toBe("error");
    expect(update.errorMessage).toMatch(/Access denied \(403\)/);
    expect(update.errorMessage).not.toMatch(/invalid after refresh/i);
  });

  test("auth_error (true invalid_grant path) maps to error", () => {
    const update = mapHealthToAccountUpdate(base, {
      kind: "auth_error",
      success: false,
      error: "refresh token invalid or revoked (invalid_grant)",
    });
    expect(update.status).toBe("error");
    expect(update.errorMessage).toMatch(/invalid_grant/);
  });

  test("healthy weekly quota restores active", () => {
    const update = mapHealthToAccountUpdate(
      makeOAuthAccount({ status: "error", errorMessage: "OAuth access token invalid after refresh" }),
      {
        kind: "healthy",
        success: true,
        quota: {
          limit: 100,
          remaining: 77,
          used: 23,
          resetAt: null,
          source: "grok.com/GetGrokCreditsConfig",
        },
      },
    );
    expect(update.status).toBe("active");
    expect(update.errorMessage).toBeNull();
  });
});

describe("GrokProvider.healthCheck — shipped path", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("weekly live quota success + models 403 → healthy (not session_expired)", async () => {
    class StubGrok extends GrokProvider {
      override async fetchQuota() {
        return {
          success: true,
          quota: {
            limit: 100,
            remaining: 55,
            used: 45,
            resetAt: null as Date | null,
            source: "grok.com/GetGrokCreditsConfig",
            percentScale: true,
          },
        };
      }
    }
    // If healthCheck still gates on models, this 403 would kill the account.
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: "Access denied" }), { status: 403 }),
    ) as unknown as typeof fetch;

    const health = await new StubGrok().healthCheck(makeOAuthAccount());
    expect(health.success).toBe(true);
    expect(health.kind).toBe("healthy");
    expect(health.error ?? "").not.toMatch(/invalid after refresh/i);
    expect(health.kind).not.toBe("session_expired");
    expect(health.quota?.remaining).toBe(55);
    expect(health.quota?.source).toMatch(/GetGrokCreditsConfig/);
  });

  test("live quota fail + models 403 → banned with Access denied (not invalid after refresh)", async () => {
    class StubGrok extends GrokProvider {
      override async fetchQuota() {
        return { success: false, error: "billing endpoints returned no usable quota" };
      }
    }
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ error: "Access denied" }), { status: 403 });
      }
      // getGrokCliVersion may hit remote — return a version-like body
      return new Response("0.2.93", { status: 200 });
    }) as unknown as typeof fetch;

    const health = await new StubGrok().healthCheck(makeOAuthAccount());
    expect(health.success).toBe(false);
    expect(health.kind).toBe("banned");
    expect(health.error).toMatch(/Access denied \(403\)/i);
    expect(health.error).not.toMatch(/invalid after refresh/i);
    expect(health.retryable).toBe(false);

    const update = mapHealthToAccountUpdate(makeOAuthAccount(), health as ProviderHealthResult);
    expect(update.status).toBe("error");
    expect(update.errorMessage).not.toMatch(/invalid after refresh/i);
  });

  test("live quota fail + models network error → transient_error (status stays active)", async () => {
    class StubGrok extends GrokProvider {
      override async fetchQuota() {
        return { success: false, error: "billing endpoints returned no usable quota" };
      }
    }
    globalThis.fetch = mock(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const account = makeOAuthAccount({ status: "active" });
    const health = await new StubGrok().healthCheck(account);
    expect(health.kind).toBe("transient_error");
    expect(health.retryable).toBe(true);
    expect(health.error ?? "").not.toMatch(/invalid after refresh/i);

    const update = mapHealthToAccountUpdate(account, health);
    expect(update.status).toBe("active");
  });

  test("refresh unrecoverable invalid_grant → auth_error", async () => {
    // Force ensureFreshAccessToken to return null (near-expired JWT),
    // then refreshOAuthIfNeeded → coordinatedRefresh → provider.refreshToken.
    const exp = Math.floor(Date.now() / 1000) - 10; // already expired
    const account = makeOAuthAccount({
      tokens: {
        auth_method: "oauth",
        access_token: makeJwt(exp),
        refresh_token: "rt_dead",
        expires_at: exp,
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        sub: "test-sub",
      },
    });

    class StubGrok extends GrokProvider {
      override async refreshToken() {
        return {
          success: false,
          error: "refresh token invalid or revoked (invalid_grant)",
        };
      }
      // Avoid DB writes if refresh somehow succeeded.
      override async fetchQuota() {
        return { success: false, error: "should not reach" };
      }
    }

    // Mock pool.updateTokens path: refresh fails before update.
    // coordinatedRefresh will call our refreshToken.
    const health = await new StubGrok().healthCheck(account);
    expect(health.success).toBe(false);
    expect(health.kind).toBe("auth_error");
    expect(health.retryable).toBe(false);
    expect(health.error).toMatch(/invalid_grant/i);
  });

  test("refresh transient network failure → transient_error (keeps active)", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    const account = makeOAuthAccount({
      status: "active",
      tokens: {
        auth_method: "oauth",
        access_token: makeJwt(exp),
        refresh_token: "rt_ok_but_network",
        expires_at: exp,
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        sub: "test-sub",
      },
    });

    class StubGrok extends GrokProvider {
      override async refreshToken() {
        return { success: false, error: "fetch failed: network timeout" };
      }
    }

    const health = await new StubGrok().healthCheck(account);
    expect(health.kind).toBe("transient_error");
    expect(health.retryable).toBe(true);
    expect(health.error).not.toMatch(/invalid after refresh/i);

    const update = mapHealthToAccountUpdate(account, health);
    expect(update.status).toBe("active");
  });

  test("source still must not emit the old false-death string on weekly path", async () => {
    class StubGrok extends GrokProvider {
      override async fetchQuota() {
        return {
          success: true,
          quota: {
            limit: 100,
            remaining: 0,
            used: 100,
            resetAt: null as Date | null,
            source: "grok.com/GetGrokCreditsConfig",
            percentScale: true,
          },
        };
      }
    }
    globalThis.fetch = mock(async () =>
      new Response("fail", { status: 500 }),
    ) as unknown as typeof fetch;

    const health = await new StubGrok().healthCheck(makeOAuthAccount());
    expect(health.kind).toBe("exhausted");
    expect(JSON.stringify(health)).not.toMatch(/OAuth access token invalid after refresh/);
  });
});
