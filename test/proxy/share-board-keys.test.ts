/**
 * Share-board payload + admin scope gate:
 *  - The public board is preview-only; CSS presentation is not a secret boundary.
 *  - A single-key endpoint may echo a key only after the caller presents it.
 *  - Managed (friend) keys are /v1 client credentials, never admin (/api/*, /ws).
 */
import { describe, test, expect } from "bun:test";
import { shareKeyPresented, shareKeyPublic, type ShareKeyRow } from "../../src/proxy/share-key-public";
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

describe("shareKeyPublic payload", () => {
  test("public board mode omits the full key", () => {
    const p = shareKeyPublic(row(), ACTIVE_MODELS);
    expect(p.key).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain(FULL_KEY);
    expect(p.keyPreview).toBe(FULL_KEY.slice(0, 12) + "…");
    expect(p.status).toBe("active");
    expect(p.tokensLeft).toBe(750);
    expect(p.models).toEqual(["grok-4.5"]); // allowlist filters catalog
    expect(p.baseUrl).toBe("/v1");
  });

  test("single-key mode can echo an already-presented credential", () => {
    const p = shareKeyPresented(row(), ACTIVE_MODELS);
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
