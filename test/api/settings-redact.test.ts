/**
 * Every settings read route (proxy-settings.ts GET /api/settings[/:key], the
 * full dump included) is pool-key-gated while writes are peer-admin-guarded,
 * so it must not hand a stored OIDC clientSecret back to a reader. This pins
 * the redaction behavior by importing the real redactor the routes use.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect } from "bun:test";
import { redactSettingsValue } from "../../src/api/management";

describe("settings read redaction", () => {
  test("oidc_config clientSecret is redacted", () => {
    const raw = JSON.stringify({ enabled: true, issuer: "https://idp.example", clientId: "abc", clientSecret: "super-secret" });
    const out = JSON.parse(redactSettingsValue("oidc_config", raw));
    expect(out.clientSecret).toBe("***");
    expect(out.clientId).toBe("abc"); // non-secret fields preserved
    expect(out.issuer).toBe("https://idp.example");
  });

  test("oidc_config without a secret is returned unchanged", () => {
    const raw = JSON.stringify({ enabled: true, issuer: "https://idp.example", clientId: "abc" });
    expect(redactSettingsValue("oidc_config", raw)).toBe(raw);
  });

  test("non-oidc settings are never altered", () => {
    const raw = JSON.stringify({ clientSecret: "untouched" });
    expect(redactSettingsValue("some_other_key", raw)).toBe(raw);
  });

  test("malformed JSON is returned as-is (no throw)", () => {
    expect(redactSettingsValue("oidc_config", "{not json")).toBe("{not json");
  });
});
