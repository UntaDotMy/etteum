/**
 * Share-board secret hygiene + admin scope gate:
 *  - /v1/share/board (authless) must NEVER emit full managed keys — previews only.
 *    Anyone who can reach SHARE_PORT could otherwise harvest every friend key.
 *  - The single-key deep link (/v1/share?key=…) may return the full key because
 *    the caller already presented it.
 *  - Managed (friend) keys are /v1 client credentials, never admin (/api/*, /ws).
 */
import { describe, test, expect } from "bun:test";
import { shareKeyPublic, type ShareKeyRow } from "../../src/proxy/share-key-public";
import { isAdminApiScope } from "../../src/utils/security";

const FULL_KEY = "etteum_testsecret_ABCDEFGH1234567890";

function row(partial: Partial<ShareKeyRow> = {}): ShareKeyRow {
  return {
    id: 7,
    key: FULL_KEY,
    name: "Friend A",
    machineId: null,
    isActive: true,
    createdAt: new Date(),
    lastUsedAt: null,
    allowedModels: JSON.stringify(["grok-4.5"]),
    tokenQuota: 1000,
    tokensUsed: 250,
    rateLimit: null,
    expiresAt: null,
    ...partial,
  } as ShareKeyRow;
}

const ACTIVE_MODELS = ["grok-4.5", "composer-2.5", "cbc-kimi-k3"];

describe("shareKeyPublic secret hygiene", () => {
  test("board mode (no opts) omits the full key, keeps preview + status fields", () => {
    const p = shareKeyPublic(row(), ACTIVE_MODELS);
    expect(p.key).toBeUndefined();
    expect("key" in p).toBe(false);
    expect(p.keyPreview).toBe(FULL_KEY.slice(0, 12) + "…");
    expect(p.keyPreview).not.toBe(FULL_KEY);
    expect(p.status).toBe("active");
    expect(p.tokensLeft).toBe(750);
    expect(p.models).toEqual(["grok-4.5"]); // allowlist filters catalog
    expect(p.baseUrl).toBe("/v1");
  });

  test("explicit includeFullKey:false also omits the secret", () => {
    const p = shareKeyPublic(row(), ACTIVE_MODELS, undefined, { includeFullKey: false });
    expect(p.key).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain(FULL_KEY);
  });

  test("deep-link mode returns the full key (caller already presented it)", () => {
    const p = shareKeyPublic(row(), ACTIVE_MODELS, undefined, { includeFullKey: true });
    expect(p.key).toBe(FULL_KEY);
  });

  test("status: inactive / expired / exhausted", () => {
    expect(shareKeyPublic(row({ isActive: false }), ACTIVE_MODELS).status).toBe("inactive");
    expect(
      shareKeyPublic(row({ expiresAt: new Date(Date.now() - 1000) }), ACTIVE_MODELS).status,
    ).toBe("expired");
    expect(
      shareKeyPublic(row({ tokenQuota: 100, tokensUsed: 100 }), ACTIVE_MODELS).status,
    ).toBe("exhausted");
  });
});

describe("isAdminApiScope", () => {
  test("managed (friend) keys are NOT admin", () => {
    expect(isAdminApiScope("managed")).toBe(false);
  });

  test("pool key / dashboard session ARE admin", () => {
    expect(isAdminApiScope("pool")).toBe(true);
    expect(isAdminApiScope(undefined)).toBe(true);
    expect(isAdminApiScope(null)).toBe(true);
  });
});
