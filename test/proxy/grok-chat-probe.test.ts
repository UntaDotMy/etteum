/**
 * Throttled Grok chat liveness on warmup (Alibaba-style guard).
 *
 * Credit APIs alone can report healthy while chat is Access denied / dead.
 * Warmup must occasionally POST /v1/responses so dead chat paths leave the pool
 * before user traffic hits them — without re-probing the whole fleet every tick.
 */
import { describe, test, expect } from "bun:test";
import {
  shouldRunGrokChatLivenessProbe,
  classifyGrokChatLiveness,
  mapGrokChatLivenessToHealthPatch,
  getGrokLastChatProbeAtMs,
  GROK_CHAT_PROBE_THROTTLE_MS,
  GrokProvider,
} from "../../src/proxy/providers/grok/index";
import { mapHealthToAccountUpdate } from "../../src/auth/warmup-runner";
import type { Account } from "../../src/db/schema";
import type { GrokChatLivenessResult } from "../../src/proxy/providers/grok/oauth";

function makeJwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: expSec, sub: "test-sub", aud: "b1a00492-073a-47ea-816f-4c329264a828" }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeOAuthAccount(overrides: Partial<Account> = {}): Account {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    id: 77,
    provider: "grok",
    email: "chat-probe@oauth",
    password: "",
    status: "active",
    enabled: true,
    tokens: {
      auth_method: "oauth",
      access_token: makeJwt(exp),
      refresh_token: "rt_ok",
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
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Account;
}

describe("shouldRunGrokChatLivenessProbe", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");

  test("never probed → run", () => {
    expect(shouldRunGrokChatLivenessProbe(makeOAuthAccount(), { now })).toBe(true);
  });

  test("recent lastChatProbeAt → skip", () => {
    const account = makeOAuthAccount({
      metadata: {
        warmup: {
          lastChatProbeAt: new Date(now - 30 * 60 * 1000).toISOString(),
          chatProbe: "ok",
        },
      },
    });
    expect(shouldRunGrokChatLivenessProbe(account, { now })).toBe(false);
    expect(getGrokLastChatProbeAtMs(account)).toBe(now - 30 * 60 * 1000);
  });

  test("stale lastChatProbeAt past throttle → run", () => {
    const account = makeOAuthAccount({
      metadata: {
        warmup: {
          lastChatProbeAt: new Date(now - GROK_CHAT_PROBE_THROTTLE_MS - 1).toISOString(),
          chatProbe: "ok",
        },
      },
    });
    expect(shouldRunGrokChatLivenessProbe(account, { now })).toBe(true);
  });

  test("status error forces re-probe even when recent", () => {
    const account = makeOAuthAccount({
      status: "error",
      metadata: {
        warmup: {
          lastChatProbeAt: new Date(now - 60_000).toISOString(),
          chatProbe: "ok",
        },
      },
    });
    expect(shouldRunGrokChatLivenessProbe(account, { now })).toBe(true);
  });

  test("Access denied errorMessage forces re-probe", () => {
    const account = makeOAuthAccount({
      errorMessage: "cli-chat-proxy Access denied (403)",
      metadata: {
        warmup: {
          lastChatProbeAt: new Date(now - 60_000).toISOString(),
          chatProbe: "ok",
        },
      },
    });
    expect(shouldRunGrokChatLivenessProbe(account, { now })).toBe(true);
  });
});

describe("classifyGrokChatLiveness + mapGrokChatLivenessToHealthPatch", () => {
  test("200 → ok → healthy", () => {
    const live = classifyGrokChatLiveness({ httpStatus: 200 });
    expect(live.reason).toBe("ok");
    expect(mapGrokChatLivenessToHealthPatch(live).kind).toBe("healthy");
  });

  test("403 Access denied → banned (not dead RT phrasing)", () => {
    const live = classifyGrokChatLiveness({
      httpStatus: 403,
      bodySnippet: '{"error":"Access denied"}',
    });
    expect(live.reason).toBe("access_denied");
    const patch = mapGrokChatLivenessToHealthPatch(live);
    expect(patch.kind).toBe("banned");
    expect(patch.error).toMatch(/Access denied \(403\)/i);
    expect(patch.error).not.toMatch(/invalid after refresh/i);
  });

  test("401 → session_expired", () => {
    const live = classifyGrokChatLiveness({ httpStatus: 401 });
    expect(live.reason).toBe("unauthorized");
    expect(mapGrokChatLivenessToHealthPatch(live).kind).toBe("session_expired");
  });

  test("free-usage-exhausted body → exhausted", () => {
    const live = classifyGrokChatLiveness({
      httpStatus: 429,
      bodySnippet: "subscription:free-usage-exhausted",
    });
    expect(live.reason).toBe("exhausted");
    expect(mapGrokChatLivenessToHealthPatch(live).kind).toBe("exhausted");
  });

  test("network null → transient_keep (do not mass-kill)", () => {
    const live = classifyGrokChatLiveness({
      httpStatus: null,
      networkError: "fetch failed",
    });
    expect(live.reason).toBe("transient");
    expect(mapGrokChatLivenessToHealthPatch(live).kind).toBe("transient_keep");
  });

  test("5xx → transient_keep", () => {
    const live = classifyGrokChatLiveness({ httpStatus: 503 });
    expect(mapGrokChatLivenessToHealthPatch(live).kind).toBe("transient_keep");
  });
});

describe("GrokProvider.healthCheck — throttled chat probe", () => {
  class WeeklyCreditsGrok extends GrokProvider {
    override async fetchQuota() {
      return {
        success: true,
        quota: {
          limit: 100,
          remaining: 70,
          used: 30,
          resetAt: null as Date | null,
          source: "grok.com/GetGrokCreditsConfig",
          percentScale: true,
        },
      };
    }
  }

  test("never probed + chat ok → healthy with lastChatProbeAt", async () => {
    class Stub extends WeeklyCreditsGrok {
      protected override async runChatLivenessProbe(): Promise<GrokChatLivenessResult> {
        return { reason: "ok", status: 200 };
      }
    }
    const health = await new Stub().healthCheck(makeOAuthAccount({ metadata: null }));
    expect(health.kind).toBe("healthy");
    expect(health.success).toBe(true);
    expect(health.metadata?.chatProbe).toBe("ok");
    expect(typeof health.metadata?.lastChatProbeAt).toBe("string");
    expect(health.message).toMatch(/chat probe ok/i);

    const update = mapHealthToAccountUpdate(makeOAuthAccount({ metadata: null }), health);
    const warmup = (update.metadata as { warmup?: { lastChatProbeAt?: string; chatProbe?: string } })
      ?.warmup;
    expect(warmup?.chatProbe).toBe("ok");
    expect(typeof warmup?.lastChatProbeAt).toBe("string");
  });

  test("recent probe → throttled, does not call chat hop", async () => {
    let called = 0;
    class Stub extends WeeklyCreditsGrok {
      protected override async runChatLivenessProbe(): Promise<GrokChatLivenessResult> {
        called++;
        return { reason: "ok", status: 200 };
      }
    }
    const account = makeOAuthAccount({
      metadata: {
        warmup: {
          lastChatProbeAt: new Date().toISOString(),
          chatProbe: "ok",
        },
      },
    });
    const health = await new Stub().healthCheck(account);
    expect(called).toBe(0);
    expect(health.kind).toBe("healthy");
    expect(health.metadata?.chatProbe).toBe("throttled");
  });

  test("chat Access denied → banned → status error", async () => {
    class Stub extends WeeklyCreditsGrok {
      protected override async runChatLivenessProbe(): Promise<GrokChatLivenessResult> {
        return {
          reason: "access_denied",
          status: 403,
          error:
            "cli-chat-proxy Access denied (403) on chat probe — Build API blocked (not a dead refresh token)",
        };
      }
    }
    const health = await new Stub().healthCheck(makeOAuthAccount({ metadata: null }));
    expect(health.kind).toBe("banned");
    expect(health.success).toBe(false);
    expect(health.error).toMatch(/Access denied/i);
    expect(health.error).not.toMatch(/invalid after refresh/i);

    const update = mapHealthToAccountUpdate(makeOAuthAccount({ metadata: null }), health);
    expect(update.status).toBe("error");
  });

  test("chat free-usage-exhausted → exhausted (pool skip)", async () => {
    class Stub extends WeeklyCreditsGrok {
      protected override async runChatLivenessProbe(): Promise<GrokChatLivenessResult> {
        return {
          reason: "exhausted",
          status: 429,
          quota: {
            limit: 2_000_000,
            remaining: 0,
            used: 2_000_000,
            resetAt: null,
            source: "cli-chat-proxy/free-usage-exhausted",
            percentScale: false,
          },
        };
      }
    }
    const health = await new Stub().healthCheck(makeOAuthAccount({ metadata: null }));
    expect(health.kind).toBe("exhausted");
    expect(health.success).toBe(true);
    expect(health.quota?.remaining).toBe(0);

    const update = mapHealthToAccountUpdate(makeOAuthAccount({ metadata: null }), health);
    expect(update.status).toBe("exhausted");
  });

  test("chat transient → keep healthy, do not stamp lastChatProbeAt", async () => {
    class Stub extends WeeklyCreditsGrok {
      protected override async runChatLivenessProbe(): Promise<GrokChatLivenessResult> {
        return { reason: "transient", error: "fetch failed" };
      }
    }
    const health = await new Stub().healthCheck(makeOAuthAccount({ metadata: null }));
    expect(health.kind).toBe("healthy");
    expect(health.metadata?.chatProbe).toBe("transient");
    expect(health.metadata?.lastChatProbeAt).toBeUndefined();
    expect(health.message).toMatch(/transient/i);
  });

  test("weekly remaining 0 → exhausted without chat probe", async () => {
    let called = 0;
    class Stub extends GrokProvider {
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
      protected override async runChatLivenessProbe(): Promise<GrokChatLivenessResult> {
        called++;
        return { reason: "ok", status: 200 };
      }
    }
    const health = await new Stub().healthCheck(makeOAuthAccount({ metadata: null }));
    expect(health.kind).toBe("exhausted");
    expect(called).toBe(0);
  });

  test("healing from error status re-runs chat even when recent stamp", async () => {
    let called = 0;
    class Stub extends WeeklyCreditsGrok {
      protected override async runChatLivenessProbe(): Promise<GrokChatLivenessResult> {
        called++;
        return { reason: "ok", status: 200 };
      }
    }
    const account = makeOAuthAccount({
      status: "error",
      errorMessage: "previous Access denied",
      metadata: {
        warmup: {
          lastChatProbeAt: new Date().toISOString(),
          chatProbe: "access_denied",
        },
      },
    });
    const health = await new Stub().healthCheck(account);
    expect(called).toBe(1);
    expect(health.kind).toBe("healthy");
    expect(health.metadata?.chatProbe).toBe("ok");
  });
});
