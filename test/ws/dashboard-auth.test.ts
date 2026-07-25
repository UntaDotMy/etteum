/**
 * Dashboard /ws dual-auth: session cookie OR pool api_key (not managed keys).
 *
 * Mocks are installed in beforeAll and torn down in afterAll. bun's
 * mock.module REPLACES the entire module registry entry for the rest of the
 * process — a top-level stub that only returned one export was the root cause
 * of the full-suite CI flake in ip-ban-tripwire (banIp / resolveApiKey /
 * triggerFriendKeyTripwire came back undefined / no-op). Spreading the real
 * module + restoring after the suite keeps other tests honest.
 */
import { describe, test, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import type { authorizeDashboardWebSocket as AuthorizeFn } from "../../src/ws/dashboard-auth";

const resolveApiKey = mock(async (_token: string, _opts: unknown) => ({
  valid: false as boolean,
  scope: "pool" as string | undefined,
  apiKeyId: null as number | null,
}));

const triggerFriendKeyTripwire = mock(async () => {});

const verifyDashboardAuthToken = mock(async (_token?: string) => null as Record<string, unknown> | null);

let authorizeDashboardWebSocket: typeof AuthorizeFn;
let realKeys: typeof import("../../src/api/keys");
let realIpBan: typeof import("../../src/utils/ip-ban");
let realDashSec: typeof import("../../src/auth/dashboardSecurity");

describe("authorizeDashboardWebSocket", () => {
  beforeAll(async () => {
    realKeys = await import("../../src/api/keys");
    realIpBan = await import("../../src/utils/ip-ban");
    realDashSec = await import("../../src/auth/dashboardSecurity");

    mock.module("../../src/api/keys", () => ({
      ...realKeys,
      resolveApiKey,
    }));
    mock.module("../../src/utils/ip-ban", () => ({
      ...realIpBan,
      triggerFriendKeyTripwire,
    }));
    mock.module("../../src/auth/dashboardSecurity", () => ({
      ...realDashSec,
      SESSION_COOKIE: "auth_token",
      verifyDashboardAuthToken,
    }));

    // Import SUT only after mocks are registered so it binds to the stubs.
    ({ authorizeDashboardWebSocket } = await import("../../src/ws/dashboard-auth"));
  });

  afterAll(() => {
    // Reinstall real modules so later suites (ip-ban-tripwire) see real exports.
    if (realKeys) mock.module("../../src/api/keys", () => realKeys);
    if (realIpBan) mock.module("../../src/utils/ip-ban", () => realIpBan);
    if (realDashSec) mock.module("../../src/auth/dashboardSecurity", () => realDashSec);
  });

  beforeEach(() => {
    resolveApiKey.mockReset();
    triggerFriendKeyTripwire.mockReset();
    verifyDashboardAuthToken.mockReset();
    resolveApiKey.mockImplementation(async () => ({
      valid: false,
      scope: "pool",
      apiKeyId: null,
    }));
    verifyDashboardAuthToken.mockImplementation(async () => null);
  });

  test("accepts a valid pool api_key query", async () => {
    resolveApiKey.mockImplementation(async () => ({
      valid: true,
      scope: "pool",
      apiKeyId: 1,
    }));
    const res = await authorizeDashboardWebSocket({
      apiKeyQuery: "pool-secret",
      cookieHeader: null,
      ip: "1.2.3.4",
      headers: new Headers(),
    });
    expect(res).toEqual({ ok: true });
    expect(verifyDashboardAuthToken).not.toHaveBeenCalled();
  });

  test("rejects managed (friend) api_key and tripwires", async () => {
    resolveApiKey.mockImplementation(async () => ({
      valid: true,
      scope: "managed",
      apiKeyId: 9,
    }));
    const res = await authorizeDashboardWebSocket({
      apiKeyQuery: "friend-key",
      cookieHeader: null,
      ip: "1.2.3.4",
      headers: new Headers(),
    });
    expect(res).toEqual({ ok: false, status: 403, body: "Access denied." });
    expect(triggerFriendKeyTripwire).toHaveBeenCalled();
  });

  test("rejects invalid non-empty api_key without falling through to cookie", async () => {
    resolveApiKey.mockImplementation(async () => ({
      valid: false,
      scope: "pool",
      apiKeyId: null,
    }));
    verifyDashboardAuthToken.mockImplementation(async () => ({ authenticated: true }));
    const res = await authorizeDashboardWebSocket({
      apiKeyQuery: "wrong-key",
      cookieHeader: "auth_token=good.session",
      ip: "1.2.3.4",
      headers: new Headers(),
    });
    expect(res).toEqual({ ok: false, status: 401, body: "Unauthorized" });
    expect(verifyDashboardAuthToken).not.toHaveBeenCalled();
  });

  test("accepts valid session cookie when api_key is empty", async () => {
    verifyDashboardAuthToken.mockImplementation(async (t) =>
      t === "sess.jwt.here" ? { authenticated: true } : null,
    );
    const res = await authorizeDashboardWebSocket({
      apiKeyQuery: null,
      cookieHeader: "other=1; auth_token=sess.jwt.here; x=y",
      ip: "1.2.3.4",
      headers: new Headers(),
    });
    expect(res).toEqual({ ok: true });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  test("rejects when neither api_key nor session is valid", async () => {
    const res = await authorizeDashboardWebSocket({
      apiKeyQuery: "",
      cookieHeader: null,
      ip: "1.2.3.4",
      headers: new Headers(),
    });
    expect(res).toEqual({ ok: false, status: 401, body: "Unauthorized" });
  });
});
