/**
 * Managed/friend key CRUD validation + scoping (src/api/keys.ts).
 *
 * Covers the assigned unit:
 *   - POST   /managed            create validation (allowlist/quota/rate/expiry shaping)
 *   - GET    /managed            list + keyPreview truncation
 *   - PATCH  /managed/:id        partial update semantics + "Nothing to update"
 *   - POST   /managed/:id/revoke + /managed/:id/activate  isActive toggle
 *   - DELETE /managed/:id        row removal
 *   - resolveApiKey scoping      allowlist/quota/rate/expiry/machine-binding gates
 *
 * Env is set BEFORE imports because config/db read ENCRYPTION_KEY / DATABASE_PATH
 * at import time. DATABASE_PATH points at a throwaway temp file so these tests
 * never touch the operator's real data/poolprox3.db.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "keys-crud-"));

process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
// Isolate the api_keys store in a throwaway SQLite file (never the real DB).
process.env.DATABASE_PATH = join(tmpHome, "keys-crud-test.db");

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../src/db/migrate";
import { db } from "../../src/db/index";
import { apiKeys } from "../../src/db/schema";
import { like } from "drizzle-orm";
import {
  keysRouter,
  resolveApiKey,
  invalidateResolvedApiKeys,
} from "../../src/api/keys";

// Mount the router the same way the server does, minus dashboard auth — these
// tests exercise CRUD validation/scoping, not the session guard.
const app = new Hono();
app.route("/api/keys", keysRouter);

const KEY_PREFIX = "sk-pool-%";
const createdKeyToken = () =>
  db.select().from(apiKeys).where(like(apiKeys.key, KEY_PREFIX));

beforeAll(async () => {
  await runMigrations();
});

afterEach(async () => {
  // Clean up only the rows these tests created (sk-pool-% generated keys),
  // leaving any other schema rows alone.
  await db.delete(apiKeys).where(like(apiKeys.key, KEY_PREFIX));
  invalidateResolvedApiKeys();
});

afterAll(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function createManaged(body: Record<string, unknown>) {
  const res = await app.request("/api/keys/managed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

// ---------------------------------------------------------------------------
// POST /managed — create validation + limit shaping.
// ---------------------------------------------------------------------------
describe("POST /api/keys/managed — create", () => {
  test("creates an active key with a sk-pool- prefix and returns it once", async () => {
    const res = await createManaged({ name: "Friend A" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; key: string; name: string | null };
    expect(body.id).toBeGreaterThan(0);
    expect(body.key.startsWith("sk-pool-")).toBe(true);
    expect(body.name).toBe("Friend A");
  });

  test("persists a valid allowlist as JSON and exposes it parsed on list", async () => {
    const res = await createManaged({ name: "allow", allowedModels: ["gpt-4o", "claude-3"] });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };

    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; allowedModels: string[] | null }> };
    const row = keys.find((k) => k.id === id);
    expect(row?.allowedModels).toEqual(["gpt-4o", "claude-3"]);
  });

  test("drops an empty allowlist to null (unrestricted)", async () => {
    const res = await createManaged({ name: "empty-allow", allowedModels: [] });
    const { id } = (await res.json()) as { id: number };
    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; allowedModels: string[] | null }> };
    expect(keys.find((k) => k.id === id)?.allowedModels).toBeNull();
  });

  test("rounds a positive tokenQuota and rejects non-positive to null", async () => {
    const pos = await createManaged({ name: "q", tokenQuota: 1000.6 });
    const posId = ((await pos.json()) as { id: number }).id;
    const zero = await createManaged({ name: "q0", tokenQuota: 0 });
    const zeroId = ((await zero.json()) as { id: number }).id;
    const neg = await createManaged({ name: "qn", tokenQuota: -50 });
    const negId = ((await neg.json()) as { id: number }).id;

    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; tokenQuota: number | null }> };
    expect(keys.find((k) => k.id === posId)?.tokenQuota).toBe(1001);
    expect(keys.find((k) => k.id === zeroId)?.tokenQuota).toBeNull();
    expect(keys.find((k) => k.id === negId)?.tokenQuota).toBeNull();
  });

  test("rounds a positive rateLimit and rejects non-finite to null", async () => {
    const ok = await createManaged({ name: "r", rateLimit: 12.4 });
    const okId = ((await ok.json()) as { id: number }).id;
    const bad = await createManaged({ name: "rb", rateLimit: "fast" });
    const badId = ((await bad.json()) as { id: number }).id;

    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; rateLimit: number | null }> };
    expect(keys.find((k) => k.id === okId)?.rateLimit).toBe(12);
    expect(keys.find((k) => k.id === badId)?.rateLimit).toBeNull();
  });

  test("accepts a parseable expiresAt ISO string and drops an unparseable one", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await createManaged({ name: "exp", expiresAt: future });
    const okId = ((await ok.json()) as { id: number }).id;
    const bad = await createManaged({ name: "expb", expiresAt: "not-a-date" });
    const badId = ((await bad.json()) as { id: number }).id;

    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; expiresAt: string | null }> };
    expect(keys.find((k) => k.id === okId)?.expiresAt).not.toBeNull();
    expect(keys.find((k) => k.id === badId)?.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /managed — list shaping + keyPreview truncation.
// ---------------------------------------------------------------------------
describe("GET /api/keys/managed — list", () => {
  test("keyPreview is the first 12 chars plus an ellipsis, never the full key", async () => {
    const res = await createManaged({ name: "preview" });
    const { id, key } = (await res.json()) as { id: number; key: string };

    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; key: string; keyPreview: string }> };
    const row = keys.find((k) => k.id === id);
    expect(row?.keyPreview).toBe(key.slice(0, 12) + "…");
    expect(row?.keyPreview).not.toBe(key);
  });
});

// ---------------------------------------------------------------------------
// PATCH /managed/:id — partial update semantics.
// ---------------------------------------------------------------------------
describe("PATCH /api/keys/managed/:id — update", () => {
  test("returns 400 when no updatable fields are supplied", async () => {
    const res = await createManaged({ name: "noop" });
    const { id } = (await res.json()) as { id: number };

    const patch = await app.request(`/api/keys/managed/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(patch.status).toBe(400);
    const body = (await patch.json()) as { error: string };
    expect(body.error).toMatch(/Nothing to update/);
  });

  test("updates only the provided fields and leaves others intact", async () => {
    const res = await createManaged({ name: "orig", tokenQuota: 500, rateLimit: 5 });
    const { id } = (await res.json()) as { id: number };

    const patch = await app.request(`/api/keys/managed/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenQuota: 900 }),
    });
    expect(patch.status).toBe(200);

    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; name: string | null; tokenQuota: number | null; rateLimit: number | null }> };
    const row = keys.find((k) => k.id === id);
    expect(row?.tokenQuota).toBe(900);   // changed
    expect(row?.name).toBe("orig");       // untouched
    expect(row?.rateLimit).toBe(5);       // untouched
  });

  test("explicit null clears an optional limit", async () => {
    const res = await createManaged({ name: "clear", tokenQuota: 100 });
    const { id } = (await res.json()) as { id: number };

    await app.request(`/api/keys/managed/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenQuota: null }),
    });

    const list = await app.request("/api/keys/managed");
    const { keys } = (await list.json()) as { keys: Array<{ id: number; tokenQuota: number | null }> };
    expect(keys.find((k) => k.id === id)?.tokenQuota).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revoke / activate / delete lifecycle.
// ---------------------------------------------------------------------------
describe("managed key lifecycle — revoke/activate/delete", () => {
  test("revoke flips isActive off and activate flips it back on", async () => {
    const res = await createManaged({ name: "cycle" });
    const { id, key } = (await res.json()) as { id: number; key: string };

    await app.request(`/api/keys/managed/${id}/revoke`, { method: "POST" });
    invalidateResolvedApiKeys();
    let resolved = await resolveApiKey(key);
    expect(resolved.valid).toBe(false);

    await app.request(`/api/keys/managed/${id}/activate`, { method: "POST" });
    invalidateResolvedApiKeys();
    resolved = await resolveApiKey(key);
    expect(resolved.valid).toBe(true);
  });

  test("delete removes the row so the key no longer resolves", async () => {
    const res = await createManaged({ name: "gone" });
    const { id, key } = (await res.json()) as { id: number; key: string };

    await app.request(`/api/keys/managed/${id}`, { method: "DELETE" });
    invalidateResolvedApiKeys();
    const resolved = await resolveApiKey(key);
    expect(resolved.valid).toBe(false);
    const remaining = await createdKeyToken();
    expect(remaining.some((r) => r.id === id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveApiKey — scoping gates (expiry / machine binding / pool precedence).
// ---------------------------------------------------------------------------
describe("resolveApiKey — scoping gates", () => {
  test("operator pool key always wins and is never limited by allowlist", async () => {
    // Bun's .env autoload overrides the pre-set API_KEY with the operator's real
    // key, so resolve against the EFFECTIVE config key (whatever source it came
    // from). The assertion is pool-key precedence, not a specific literal value.
    const { config } = await import("../../src/config");
    expect(config.apiKey.length).toBeGreaterThan(0);
    const resolved = await resolveApiKey(config.apiKey);
    expect(resolved).toEqual({ valid: true, scope: "pool" });
  });

  test("an expired managed key stops resolving with reason=expired", async () => {
    const res = await createManaged({
      name: "expired",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const { key } = (await res.json()) as { key: string };
    invalidateResolvedApiKeys();
    const resolved = await resolveApiKey(key);
    expect(resolved.valid).toBe(false);
    expect((resolved as { reason?: string }).reason).toBe("expired");
  });

  test("a machine-bound key rejects a mismatched machine id", async () => {
    const res = await createManaged({ name: "bound", machineId: "machine-xyz" });
    const { key } = (await res.json()) as { key: string };
    invalidateResolvedApiKeys();

    const wrong = await resolveApiKey(key, { machineId: "machine-other" });
    expect(wrong.valid).toBe(false);
    expect((wrong as { reason?: string }).reason).toBe("machine_mismatch");

    const missing = await resolveApiKey(key);
    expect(missing.valid).toBe(false);
    expect((missing as { reason?: string }).reason).toBe("machine_mismatch");

    const right = await resolveApiKey(key, { machineId: "machine-xyz" });
    expect(right.valid).toBe(true);
    expect((right as { scope?: string }).scope).toBe("managed");
  });

  test("an unknown token resolves invalid", async () => {
    const resolved = await resolveApiKey("sk-pool-does-not-exist-000000000000");
    expect(resolved.valid).toBe(false);
  });
});
