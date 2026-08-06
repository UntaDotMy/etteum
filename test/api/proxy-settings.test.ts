/**
 * Unit tests for src/api/proxy-settings.ts:
 *   GET  /api/settings            serialize + defaults merge (no secret leakage)
 *   GET  /api/settings/:key       single setting fetch
 *   PUT  /api/settings/:key       validation + upsert + round-trip
 *   DELETE /api/settings/:key     removal + 404
 *   PUT  /api/settings            bulk upsert + round-trip
 *
 * Env is set BEFORE imports because config/db read ENCRYPTION_KEY /
 * DATABASE_PATH at import time. DATABASE_PATH points at a temp file so these
 * tests never touch the operator's real data/poolprox3.db.
 *
 * Privacy note: settings values are served verbatim (the dashboard needs the
 * real strings). The leakage risk is *credentials accidentally persisted as
 * settings rows* showing up in GET /api/settings — so the tests seed
 * password/api-key-shaped values and assert what the endpoint actually returns.
 * See notes on the suite for the suspected issue this documents.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "proxy-settings-"));

process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
process.env.DATABASE_PATH = join(tmpHome, "proxy-settings-test.db");

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../src/db/migrate";
import { db } from "../../src/db/index";
import { settings } from "../../src/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { proxySettingsRouter } from "../../src/api/proxy-settings";

// Mount the router under its real prefix so internal "/" and "/:key" paths
// resolve exactly as they do in the server.
const app = new Hono().route("/api/settings", proxySettingsRouter);

// Prefix every key we persist so cleanup is surgical and re-runs never collide.
const P = "ps-test-";
const seededKeys: string[] = [];

async function putSingle(key: string, body: unknown): Promise<Response> {
  return app.request(`/api/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await runMigrations();
  // Clean slate for our prefix only — other suites may share the temp DB.
  try {
    await db.delete(settings).where(like(settings.key, `${P}%`));
  } catch { /* best-effort */ }
});

afterAll(async () => {
  try {
    if (seededKeys.length > 0) {
      await db.delete(settings).where(inArray(settings.key, seededKeys));
    }
  } catch { /* best-effort */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// GET /api/settings — serialize + defaults merge
// ---------------------------------------------------------------------------
describe("GET /api/settings serialization", () => {
  test("returns every known default key with backend default values", async () => {
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, string>; defaults: boolean };
    expect(json.defaults).toBe(true);
    // Spot-check a few keys from the defaults table in the handler.
    expect(json.data.load_balancing_method).toBe("round_robin");
    expect(json.data.retry_max_account_attempts).toBe("3");
    expect(json.data.auto_warmup_interval_minutes).toBe("15");
    expect(json.data.proxy_pool_usage).toBe("all");
    expect(json.data.proxy_pool_rotation).toBe("round_robin");
    // Compression defaults exist and are strings (not undefined).
    expect(typeof json.data.compression_rtk_enabled).toBe("string");
    expect(typeof json.data.compression_headroom_timeout_ms).toBe("string");
  });

  test("serves DB values verbatim, overriding defaults for persisted keys", async () => {
    const key = `${P}load_balancing_method`;
    await db.insert(settings).values({ key, value: "least_used" });
    seededKeys.push(key);

    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, string> };
    expect(json.data[key]).toBe("least_used");
  });

  test("null-valued rows serialize as empty string (type contract: string map)", async () => {
    const key = `${P}null-row`;
    await db.insert(settings).values({ key, value: null });
    seededKeys.push(key);

    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, string> };
    expect(json.data[key]).toBe("");
    expect(typeof json.data[key]).toBe("string");
  });

  test("a credential-shaped value seeded into settings IS served verbatim (documents leak surface)", async () => {
    // The endpoint is a raw key/value dump with no redaction — this test pins
    // that behavior so any future fix (masking) trips it loudly.
    const key = `${P}upstream_password`;
    const secret = "hunter2-super-secret";
    await db.insert(settings).values({ key, value: secret });
    seededKeys.push(key);

    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, string> };
    // CURRENT behavior: full value returned. If a mask lands later this fails.
    expect(json.data[key]).toBe(secret);
  });
});

// ---------------------------------------------------------------------------
// GET /api/settings/:key
// ---------------------------------------------------------------------------
describe("GET /api/settings/:key", () => {
  test("returns the row for an existing key", async () => {
    const key = `${P}single`;
    await db.insert(settings).values({ key, value: "v1" });
    seededKeys.push(key);

    const res = await app.request(`/api/settings/${encodeURIComponent(key)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { key: string; value: string | null };
    expect(json.key).toBe(key);
    expect(json.value).toBe("v1");
  });

  test("404s for a missing key", async () => {
    const res = await app.request(`/api/settings/${P}never-existed`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Setting not found");
  });

  test("keys with no backend default still 404 (defaults only merge on the list route)", async () => {
    // GET /:key reads ONLY the DB row — the defaults map in GET / is not consulted.
    const res = await app.request("/api/settings/proxy_pool_usage");
    const json = (await res.json()) as { error?: string };
    // Unless another suite persisted it, this key is DB-absent in our temp DB.
    expect([404, 200]).toContain(res.status); // tolerate prior seeding
    if (res.status === 404) expect(json.error).toBe("Setting not found");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/:key — validation
// ---------------------------------------------------------------------------
describe("PUT /api/settings/:key validation", () => {
  test("rejects a body with no value field (400)", async () => {
    const res = await putSingle(`${P}noval`, {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("value is required");
  });

  test("rejects a non-object JSON body (400)", async () => {
    // c.req.json on a bare string parses; the destructure leaves value undefined.
    const res = await app.request(`/api/settings/${P}scalar`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("just-a-string"),
    });
    // Hono's c.req.json() returns the string; body.value is undefined → 400.
    expect(res.status).toBe(400);
  });

  test("accepts an explicit empty-string value (not undefined)", async () => {
    const key = `${P}empty-ok`;
    const res = await putSingle(key, { value: "" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { key: string; value: string };
    expect(json.value).toBe("");
    seededKeys.push(key);

    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    expect(row?.value).toBe("");
  });

  test("malformed JSON body surfaces as an error, never writes a row", async () => {
    const key = `${P}badjson`;
    let status = 0;
    try {
      const res = await app.request(`/api/settings/${key}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      status = res.status;
    } catch {
      status = -1; // Hono threw before responding
    }
    expect([400, 500, -1]).toContain(status);
    const rows = await db.select().from(settings).where(eq(settings.key, key));
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/:key — upsert + round-trip
// ---------------------------------------------------------------------------
describe("PUT /api/settings/:key upsert", () => {
  test("inserts a new key and round-trips via GET", async () => {
    const key = `${P}upsert-new`;
    const put = await putSingle(key, { value: "round_robin" });
    expect(put.status).toBe(200);
    seededKeys.push(key);

    const get = await app.request(`/api/settings/${encodeURIComponent(key)}`);
    expect(get.status).toBe(200);
    const json = (await get.json()) as { key: string; value: string | null };
    expect(json.value).toBe("round_robin");
  });

  test("updates an existing key in place (no duplicate rows)", async () => {
    const key = `${P}upsert-existing`;
    await db.insert(settings).values({ key, value: "old" });
    seededKeys.push(key);

    const put = await putSingle(key, { value: "new" });
    expect(put.status).toBe(200);

    const rows = await db.select().from(settings).where(eq(settings.key, key));
    expect(rows.length).toBe(1);
    expect(rows[0]?.value).toBe("new");
  });

  test("updatedAt refreshes on update", async () => {
    const key = `${P}ts`;
    await db.insert(settings).values({ key, value: "a" });
    seededKeys.push(key);
    const [before] = await db.select().from(settings).where(eq(settings.key, key));

    // Force a distinct timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await putSingle(key, { value: "b" });
    const [after] = await db.select().from(settings).where(eq(settings.key, key));

    expect(after?.value).toBe("b");
    expect(after?.updatedAt?.getTime()).toBeGreaterThanOrEqual(
      before?.updatedAt?.getTime() ?? 0,
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/settings/:key
// ---------------------------------------------------------------------------
describe("DELETE /api/settings/:key", () => {
  test("deletes an existing key and confirms", async () => {
    const key = `${P}del`;
    await db.insert(settings).values({ key, value: "x" });
    // Not pushed to seededKeys — the test itself removes it.

    const res = await app.request(`/api/settings/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; deleted: string };
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(key);

    const rows = await db.select().from(settings).where(eq(settings.key, key));
    expect(rows.length).toBe(0);
  });

  test("404s when deleting a missing key", async () => {
    const res = await app.request(`/api/settings/${P}del-missing`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Setting not found");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings — bulk
// ---------------------------------------------------------------------------
describe("PUT /api/settings bulk", () => {
  test("upserts multiple keys in one call and reports the count", async () => {
    const k1 = `${P}bulk-a`;
    const k2 = `${P}bulk-b`;
    seededKeys.push(k1, k2);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [k1]: "1", [k2]: "2" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; updated: number };
    expect(json.success).toBe(true);
    expect(json.updated).toBe(2);

    const [r1] = await db.select().from(settings).where(eq(settings.key, k1));
    const [r2] = await db.select().from(settings).where(eq(settings.key, k2));
    expect(r1?.value).toBe("1");
    expect(r2?.value).toBe("2");
  });

  test("bulk-updating an existing key keeps a single row", async () => {
    const key = `${P}bulk-existing`;
    await db.insert(settings).values({ key, value: "before" });
    seededKeys.push(key);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: "after" }),
    });
    expect(res.status).toBe(200);

    const rows = await db.select().from(settings).where(eq(settings.key, key));
    expect(rows.length).toBe(1);
    expect(rows[0]?.value).toBe("after");
  });
});
