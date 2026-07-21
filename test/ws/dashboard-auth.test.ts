/**
 * Dashboard /ws dual-auth: session cookie OR pool api_key (not managed keys).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock resolveApiKey + tripwire + JWT verify before importing the unit under test.
const resolveApiKey = mock(async (_token: string, _opts: unknown) => ({
  valid: false as boolean,
  scope: "pool" as string | undefined,
  apiKeyId: null as number | null,
}));

const triggerFriendKeyTripwire = mock(async () => {});

const verifyDashboardAuthToken = mock(async (_token?: string) => null as Record<string, unknown> | null);

mock.module("../../src/api/keys", () => ({
  resolveApiKey,
}));

mock.module("../../src/utils/ip-ban", () => ({
  triggerFriendKeyTripwire,
}));

mock.module("../../src/auth/dashboardSecurity", () => ({
  SESSION_COOKIE: "auth_token",
  verifyDashboardAuthToken,
}));

const { authorizeDashboardWebSocket } = await import("../../src/ws/dashboard-auth");

describe("authorizeDashboardWebSocket", () => {
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
