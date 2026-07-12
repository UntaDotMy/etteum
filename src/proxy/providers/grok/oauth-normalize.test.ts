import { describe, expect, test } from "bun:test";
import { normalizeExpiresAt, normalizeGrokOAuthTokens } from "./oauth";

describe("normalizeGrokOAuthTokens", () => {
  test("accepts farm auth_mode oidc + ISO expires_at", () => {
    // Fake JWT with exp in payload (not verified)
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp, sub: "abc-123" })).toString("base64url");
    const access = `${header}.${payload}.sig`;

    const n = normalizeGrokOAuthTokens({
      access_token: access,
      refresh_token: "rt_test",
      expires_at: new Date(exp * 1000).toISOString(),
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      auth_mode: "oidc",
      credits_remaining: 2_000_000,
      credits_limit: 2_000_000,
      email: "a@b.com",
    });
    expect(n).not.toBeNull();
    expect(n!.auth_method).toBe("oauth");
    expect(n!.expires_at).toBe(exp);
    expect(n!.credits_remaining).toBe(2_000_000);
    expect(n!.oidc_client_id).toContain("b1a00492");
  });

  test("normalizeExpiresAt handles ISO and unix", () => {
    expect(normalizeExpiresAt(1_700_000_000)).toBe(1_700_000_000);
    expect(normalizeExpiresAt("2026-07-12T19:43:41.817447Z")).toBeGreaterThan(1_700_000_000);
  });
});
