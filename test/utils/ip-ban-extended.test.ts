/**
 * Extended unit tests for src/utils/ip-ban.ts.
 *
 * Covers the units assigned for this file:
 *   - effectiveClientIpFromParts / effectiveClientIp — XFF/peer precedence.
 *   - banIp / unbanIp / isIpBanned — in-process ban-cache coherency.
 *
 * Env is set BEFORE imports because config reads ENCRYPTION_KEY / DATABASE_PATH
 * at import time. DATABASE_PATH is pointed at a temp file so these tests never
 * touch the operator's real data/poolprox3.db.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "ipban-ext-"));

process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
// Isolate the ban store in a throwaway SQLite file (never the real DB).
process.env.DATABASE_PATH = join(tmpHome, "ipban-extended-test.db");

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { runMigrations } from "../../src/db/migrate";
import {
  banIp,
  effectiveClientIp,
  effectiveClientIpFromParts,
  isIpBanned,
  unbanIp,
  __resetBanCacheForTests,
} from "../../src/utils/ip-ban";
import { db } from "../../src/db/index";
import { ipBans } from "../../src/db/schema";
import { like } from "drizzle-orm";

// RFC 5737 TEST-NET-3 — guaranteed non-real public IPs.
const IP_A = "203.0.113.110";
const IP_B = "203.0.113.120";

beforeAll(async () => {
  await runMigrations();
});

afterAll(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function cleanupBans() {
  __resetBanCacheForTests();
  await db.delete(ipBans).where(like(ipBans.ip, "203.0.113.%"));
}

// ---------------------------------------------------------------------------
// effectiveClientIpFromParts — pure XFF/peer precedence (no DB involved).
// ---------------------------------------------------------------------------
describe("effectiveClientIpFromParts: peer/XFF precedence", () => {
  test("non-loopback peer always wins over any XFF header", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.9" });
    expect(effectiveClientIpFromParts(IP_A, headers)).toBe(IP_A);
  });

  test("non-loopback peer wins even when no XFF header is present", () => {
    expect(effectiveClientIpFromParts(IP_A, new Headers())).toBe(IP_A);
  });

  test("loopback peer (127.0.0.1) trusts the proxy-stamped XFF first entry", () => {
    const headers = new Headers({ "x-forwarded-for": `${IP_B}, 10.0.0.1` });
    expect(effectiveClientIpFromParts("127.0.0.1", headers)).toBe(IP_B);
  });

  test("loopback peer (::1) also trusts the stamped XFF", () => {
    const headers = new Headers({ "x-forwarded-for": IP_A });
    expect(effectiveClientIpFromParts("::1", headers)).toBe(IP_A);
  });

  test("loopback peer with no XFF falls back to the loopback peer itself", () => {
    expect(effectiveClientIpFromParts("127.0.0.1", new Headers())).toBe("127.0.0.1");
  });

  test("XFF first entry is trimmed of surrounding whitespace", () => {
    const headers = new Headers({ "x-forwarded-for": `   ${IP_A}   , 10.1.2.3` });
    expect(effectiveClientIpFromParts("127.0.0.1", headers)).toBe(IP_A);
  });

  test("null peer with TRUST_PROXY unset returns 'unknown' (realClientIp gate)", () => {
    delete process.env.TRUST_PROXY;
    const headers = new Headers({ "x-forwarded-for": IP_A });
    expect(effectiveClientIpFromParts(null, headers)).toBe("unknown");
  });

  test("null peer with TRUST_PROXY=true reads the first XFF entry", () => {
    process.env.TRUST_PROXY = "true";
    try {
      const headers = new Headers({ "x-forwarded-for": `${IP_B}, 10.9.9.9` });
      expect(effectiveClientIpFromParts(null, headers)).toBe(IP_B);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });
});

// ---------------------------------------------------------------------------
// effectiveClientIp — Hono-context wrapper around the pure resolver.
// ---------------------------------------------------------------------------
describe("effectiveClientIp: Hono-context wrapper", () => {
  function makeCtx(peerIp: string | null, headers: Headers) {
    return { env: { ip: peerIp }, req: { raw: { headers } } } as any;
  }

  test("uses c.env.ip peer when it is a non-loopback string", () => {
    const ctx = makeCtx(IP_A, new Headers({ "x-forwarded-for": IP_B }));
    expect(effectiveClientIp(ctx)).toBe(IP_A);
  });

  test("loopback c.env.ip peer falls through to the stamped XFF", () => {
    const ctx = makeCtx("127.0.0.1", new Headers({ "x-forwarded-for": IP_A }));
    expect(effectiveClientIp(ctx)).toBe(IP_A);
  });

  test("missing req.raw.headers degrades to an empty Headers (no throw)", () => {
    const ctx = { env: { ip: IP_B } } as any;
    expect(effectiveClientIp(ctx)).toBe(IP_B);
  });

  test("null peer with no headers and TRUST_PROXY unset returns 'unknown'", () => {
    delete process.env.TRUST_PROXY;
    const ctx = { env: {}, req: { raw: { headers: new Headers() } } } as any;
    expect(effectiveClientIp(ctx)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// banIp / unbanIp / isIpBanned — ban-cache coherency against a temp DB.
// ---------------------------------------------------------------------------
describe("banIp/unbanIp/isIpBanned: cache coherency", () => {
  beforeEach(cleanupBans);
  afterEach(cleanupBans);

  test("isIpBanned is false for an IP that was never banned", async () => {
    expect(await isIpBanned(IP_A)).toBe(false);
  });

  test("banIp makes isIpBanned true immediately (cache updated in-process)", async () => {
    const { banned } = await banIp(IP_A, 9999, "test-reason", "detail");
    expect(banned).toBe(true);
    // No cache reset — the write path must update the in-process cache itself.
    expect(await isIpBanned(IP_A)).toBe(true);
    expect(await isIpBanned(IP_B)).toBe(false);
  });

  test("unbanIp makes isIpBanned false immediately after a ban", async () => {
    await banIp(IP_A, 9999, "test-reason");
    expect(await isIpBanned(IP_A)).toBe(true);
    await unbanIp(IP_A);
    expect(await isIpBanned(IP_A)).toBe(false);
  });

  test("banIp on a loopback IP is refused (self-lockout guard)", async () => {
    const { banned } = await banIp("127.0.0.1", 9999, "test-reason");
    expect(banned).toBe(false);
    expect(await isIpBanned("127.0.0.1")).toBe(false);
  });

  test("banIp on 'unknown' / empty IP is refused", async () => {
    expect((await banIp("unknown", 9999, "test-reason")).banned).toBe(false);
    expect((await banIp("", 9999, "test-reason")).banned).toBe(false);
    expect(await isIpBanned("unknown")).toBe(false);
  });

  test("an expired ban row self-heals: isIpBanned false after cache reset", async () => {
    // Ban for 0 days → expiresAt is ~now; the next refresh reaps it.
    await banIp(IP_A, 0, "test-reason");
    // Force the cache to drop so the next lookup reloads from the DB and reaps.
    __resetBanCacheForTests();
    expect(await isIpBanned(IP_A)).toBe(false);
  });

  test("a fresh ban survives a cache reset (persisted in the DB)", async () => {
    await banIp(IP_A, 9999, "test-reason");
    __resetBanCacheForTests(); // simulate a TTL expiry / process reload
    expect(await isIpBanned(IP_A)).toBe(true);
  });
});
