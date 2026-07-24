/**
 * Admin-surface tripwire: managed key or invalid dashboard login →
 * caller IP banned (9999d). Key is NEVER revoked. Loopback/unknown IPs
 * are never banned (self-lockout guard). IP identity is peer-first with
 * the share proxy's stamped XFF trusted only when the peer is loopback.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { runMigrations } from "../../src/db/migrate";
// Namespace import (not named): under bun's full-suite load order the DB-backed
// ip-ban barrel can be mid circular-evaluation when this test links, and named
// bindings resolved at link time then throw "Export named '…' not found". A
// namespace binds the whole module object; the destructure below runs at test
// evaluation time, after ip-ban has finished evaluating. why: fixes CI flake.
import * as ipBan from "../../src/utils/ip-ban";
const {
  banInvalidLoginIp,
  banIp,
  clientIdentityFromHeaders,
  effectiveClientIpFromParts,
  FRIEND_KEY_BAN_DAYS,
  isIpBanned,
  listBans,
  listSecurityEvents,
  logSecurityEvent,
  shouldTripwire,
  triggerFriendKeyTripwire,
  unbanIp,
  __resetBanCacheForTests,
} = ipBan;
// Pure helper: import from the side-effect-free module so full-suite load order
// cannot hit a half-evaluated DB-backed ip-ban barrel (CI flake).
import { isBannableIp } from "../../src/utils/ip-ban-pure";
import { resolveApiKey } from "../../src/api/keys";
import { db } from "../../src/db/index";
import { apiKeys, ipBans, securityEvents } from "../../src/db/schema";
import { eq, like } from "drizzle-orm";

// RFC 5737 TEST-NET-3 — guaranteed non-real public IPs.
const IP_A = "203.0.113.10";
const IP_B = "203.0.113.20";
const TEST_KEY_PREFIX = "etteum_tripwire_test_%";
const TEST_KEY = "etteum_tripwire_test_keyABC123";

// Tables are created by the boot migration path — tests must run it explicitly.
beforeAll(async () => {
  await runMigrations();
});

async function cleanup() {
  __resetBanCacheForTests();
  await db.delete(ipBans).where(like(ipBans.ip, "203.0.113.%"));
  await db.delete(securityEvents).where(like(securityEvents.ip, "203.0.113.%"));
  await db.delete(securityEvents).where(like(securityEvents.keyPreview, "etteum_tripwire%"));
  await db.delete(apiKeys).where(like(apiKeys.key, TEST_KEY_PREFIX));
}

describe("pure helpers", () => {
  test("shouldTripwire: only managed scope trips", () => {
    expect(shouldTripwire("managed")).toBe(true);
    expect(shouldTripwire("pool")).toBe(false);
    expect(shouldTripwire(undefined)).toBe(false);
  });

  test("isBannableIp: loopback/unknown/empty are never bannable", () => {
    expect(isBannableIp("127.0.0.1")).toBe(false);
    expect(isBannableIp("::1")).toBe(false);
    expect(isBannableIp("unknown")).toBe(false);
    expect(isBannableIp("")).toBe(false);
    expect(isBannableIp(null)).toBe(false);
    expect(isBannableIp(IP_A)).toBe(true);
  });

  test("effectiveClientIpFromParts: non-loopback peer wins (unspoofable)", () => {
    const h = new Headers({ "x-forwarded-for": "198.51.100.9" });
    expect(effectiveClientIpFromParts(IP_A, h)).toBe(IP_A);
  });

  test("effectiveClientIpFromParts: loopback peer trusts stamped XFF (share proxy)", () => {
    const h = new Headers({ "x-forwarded-for": `${IP_A}, 10.0.0.1` });
    expect(effectiveClientIpFromParts("127.0.0.1", h)).toBe(IP_A);
  });

  test("effectiveClientIpFromParts: loopback peer without XFF stays loopback (exempt)", () => {
    expect(effectiveClientIpFromParts("127.0.0.1", new Headers())).toBe("127.0.0.1");
  });

  test("clientIdentityFromHeaders: captures ua / machine / host when sent", () => {
    const h = new Headers({
      "user-agent": "TestAgent/1.0",
      "x-machine-id": "machine-abc",
      "x-client-hostname": "DESKTOP-FOO",
    });
    const id = clientIdentityFromHeaders(h);
    expect(id.userAgent).toBe("TestAgent/1.0");
    expect(id.machineId).toBe("machine-abc");
    expect(id.clientHost).toBe("DESKTOP-FOO");
  });
});

describe("ban store", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("banIp → isIpBanned; unbanIp lifts it; expired rows are not banned", async () => {
    expect(await isIpBanned(IP_A)).toBe(false);

    const { banned, expiresAt } = await banIp(IP_A, FRIEND_KEY_BAN_DAYS, "test", "detail");
    expect(banned).toBe(true);
    // ~9999 days out (allow a minute of execution slack).
    const days = (expiresAt!.getTime() - Date.now()) / (24 * 3600_000);
    expect(days).toBeGreaterThan(9998);
    expect(days).toBeLessThan(10000);

    expect(await isIpBanned(IP_A)).toBe(true);
    expect(await isIpBanned(IP_B)).toBe(false);

    const bans = await listBans();
    expect(bans.some((b) => b.ip === IP_A && b.reason === "test")).toBe(true);

    expect(await unbanIp(IP_A)).toBe(true);
    expect(await isIpBanned(IP_A)).toBe(false);
    expect(await unbanIp(IP_A)).toBe(false); // already gone
  });

  test("banIp refuses loopback (self-lockout guard)", async () => {
    const r = await banIp("127.0.0.1", 1, "test");
    expect(r.banned).toBe(false);
    expect(await isIpBanned("127.0.0.1")).toBe(false);
  });

  test("expired ban is ignored", async () => {
    await db.insert(ipBans).values({
      ip: IP_B,
      reason: "old",
      expiresAt: new Date(Date.now() - 1000),
    });
    __resetBanCacheForTests();
    expect(await isIpBanned(IP_B)).toBe(false);
  });
});

describe("triggerFriendKeyTripwire", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  async function insertFriendKey(): Promise<number> {
    const [row] = await db
      .insert(apiKeys)
      .values({ key: TEST_KEY, name: "Tripwire Test", isActive: true })
      .returning({ id: apiKeys.id });
    return row!.id;
  }

  test("bans the IP AND audits but NEVER revokes the key (other IPs keep working)", async () => {
    const id = await insertFriendKey();
    const before = await resolveApiKey(TEST_KEY, {});
    expect(before.valid).toBe(true);
    expect(before.valid && before.scope).toBe("managed");

    const headers = new Headers({
      "user-agent": "curl/8.0",
      "x-machine-id": "box-1",
      "x-client-hostname": "PC-ABUSER",
    });
    const r = await triggerFriendKeyTripwire({
      token: TEST_KEY,
      apiKeyId: id,
      surface: "api",
      path: "/api/keys/managed",
      ip: IP_A,
      headers,
    });
    expect(r.revoked).toBe(false);
    expect(r.banned).toBe(true);

    // Key remains active and still resolves for other callers.
    const [krow] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(krow!.isActive).toBe(true);
    expect((await resolveApiKey(TEST_KEY, {})).valid).toBe(true);

    // Abuser IP is banned (~9999 days); other IP is fine.
    expect(await isIpBanned(IP_A)).toBe(true);
    expect(await isIpBanned(IP_B)).toBe(false);

    // Audit event: action + preview + identity, NEVER the full key.
    const events = await listSecurityEvents(50);
    const evt = events.find((e) => e.action === "tripwire_ip_ban" && e.ip === IP_A);
    expect(evt).toBeDefined();
    expect(evt!.keyPreview).toBe(TEST_KEY.slice(0, 12) + "…");
    expect(JSON.stringify(evt)).not.toContain(TEST_KEY);
    expect(evt!.surface).toBe("api");
    expect(evt!.path).toBe("/api/keys/managed");
    expect(String(evt!.detail)).toContain("ua=curl/8.0");
    expect(String(evt!.detail)).toContain("machine=box-1");
    expect(String(evt!.detail)).toContain("host=PC-ABUSER");
  });

  test("loopback caller: key stays active and IP is NOT banned (operator safe)", async () => {
    const id = await insertFriendKey();
    const r = await triggerFriendKeyTripwire({
      token: TEST_KEY,
      apiKeyId: id,
      surface: "dashboard-login",
      path: "/api/dashboard-auth/login",
      ip: "127.0.0.1",
    });
    expect(r.revoked).toBe(false);
    expect(r.banned).toBe(false);
    expect(await isIpBanned("127.0.0.1")).toBe(false);
    const [krow] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(krow!.isActive).toBe(true);
  });
});

describe("banInvalidLoginIp", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("wrong password bans only that IP and does not touch keys", async () => {
    const [row] = await db
      .insert(apiKeys)
      .values({ key: TEST_KEY, name: "Stay Alive", isActive: true })
      .returning({ id: apiKeys.id });

    const r = await banInvalidLoginIp({
      ip: IP_A,
      keyPreview: "wrong_secret…",
      headers: new Headers({ "user-agent": "Browser/1.0" }),
      detail: "unresolved credential presented at dashboard login",
    });
    expect(r.banned).toBe(true);
    expect(await isIpBanned(IP_A)).toBe(true);
    expect(await isIpBanned(IP_B)).toBe(false);

    const [krow] = await db.select().from(apiKeys).where(eq(apiKeys.id, row!.id));
    expect(krow!.isActive).toBe(true);

    const events = await listSecurityEvents(20);
    expect(events.some((e) => e.action === "login_invalid_ban" && e.ip === IP_A)).toBe(true);
  });
});

describe("security event log", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("listSecurityEvents returns newest entries with redacted previews", async () => {
    await logSecurityEvent({
      ip: IP_A,
      surface: "dashboard-login",
      path: "/api/dashboard-auth/login",
      keyPreview: "etteum_ab12…",
      action: "login_invalid",
      detail: "test",
    });
    const events = await listSecurityEvents(10);
    expect(events.some((e) => e.action === "login_invalid" && e.ip === IP_A)).toBe(true);
  });
});
