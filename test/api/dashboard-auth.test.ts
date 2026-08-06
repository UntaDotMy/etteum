/**
 * Unit tests for src/api/dashboardAuth.ts:
 *   GET  /api/dashboard-auth/status     enabled-check: no session → 200
 *                                       {authenticated:false}; valid session
 *                                       cookie → {authenticated:true}; OIDC
 *                                       gating surfaces as `oidcEnabled`.
 *   POST /api/dashboard-auth/login      pool key issues an httpOnly session
 *                                       cookie; bad/empty credentials → 401
 *                                       with no "API key" wording in the body;
 *                                       managed (friend) key → 403 tripwire.
 *   POST /api/dashboard-auth/logout     clears the session cookie (Max-Age=0).
 *   GET  /api/dashboard-auth/oidc/*     OIDC-config gating without a live
 *                                       provider: unconfigured → 400 before any
 *                                       network fetch; callback with no
 *                                       state/verifier cookies → 400 state
 *                                       mismatch before any upstream exchange.
 *
 * Env is set BEFORE imports because config/db read ENCRYPTION_KEY /
 * DATABASE_PATH at import time. DATABASE_PATH points at a temp file so these
 * tests never touch the operator's real data/poolprox3.db.
 *
 * Loopback safety: app.request has no TCP peer, so effectiveClientIp() is
 * loopback/unidentified and ip-ban.ts never bans it — the tripwire/invalid
 * login paths still execute (403/401 + security_events rows) but no ban rows
 * land, which also keeps the loginLimiter from ever seeing a banned test IP.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "dash-auth-"));

process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
process.env.DATABASE_PATH = join(tmpHome, "dash-auth-test.db");

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../src/db/migrate";
import { db } from "../../src/db/index";
import { apiKeys, securityEvents, settings } from "../../src/db/schema";
import { eq, like } from "drizzle-orm";
import { dashboardAuthRouter } from "../../src/api/dashboardAuth";
import { createDashboardAuthToken } from "../../src/auth/dashboardSecurity";
import { invalidateResolvedApiKeys } from "../../src/api/keys";
import { config } from "../../src/config";

// Mount the router under its real prefix so internal route paths resolve
// exactly as they do in the server.
const app = new Hono().route("/api/dashboard-auth", dashboardAuthRouter);

// Bun auto-loads the project .env into the test process, and its API_KEY
// entry overrides the placeholder we set above — so the effective pool
// credential is config.apiKey, NOT process.env.API_KEY. Read it from config
// (the same source resolveApiKey uses) so the test never hardcodes a secret
// and stays green whether or not a .env exists.
const POOL_KEY = config.apiKey;
const FRIEND_KEY = "etteum_dash-auth-friend-key-test";
const OIDC_KEY = "oidc_config";
const EVENT_LIKE = "%dash-auth-test%";

// RFC 5737 192.0.2.x would be BANNABLE (public) and pollute ip_bans; raw
// app.request has no peer so every failure would share ONE "unknown" limiter
// bucket and later tests would hit the lockout (429). Loopback 127.x.y.z is
// never banned (ip-ban self-lockout guard) and each distinct IP gets its own
// loginLimiter bucket — so inject a unique loopback peer per login call.
let ipSeq = 10;
function nextPeerIp(): string {
  ipSeq += 1;
  return `127.31.${(ipSeq >> 8) & 0xff}.${ipSeq & 0xff}`;
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    { ip: nextPeerIp() },
  );
}

function sessionCookieOf(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith("auth_token="));
}

beforeAll(async () => {
  await runMigrations();
});

afterEach(async () => {
  await db.delete(settings).where(eq(settings.key, OIDC_KEY));
  await db.delete(apiKeys).where(eq(apiKeys.key, FRIEND_KEY));
  invalidateResolvedApiKeys();
});

afterAll(async () => {
  await db.delete(securityEvents).where(like(securityEvents.detail, EVENT_LIKE));
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// GET /status — the dashboard's "is there a session?" probe.
// ---------------------------------------------------------------------------
describe("GET /api/dashboard-auth/status (enabled-check)", () => {
  test("no cookie → 200, unauthenticated, oidc disabled, password login off", async () => {
    const res = await app.request("/api/dashboard-auth/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.authenticated).toBe(false);
    expect(json.user).toBeNull();
    expect(json.oidcEnabled).toBe(false);
    // Password login was removed; the pool key field is only LABELED "password".
    expect(json.passwordConfigured).toBe(false);
  });

  test("garbage cookie → unauthenticated (bad JWT rejected, not an error)", async () => {
    const res = await app.request("/api/dashboard-auth/status", {
      headers: { cookie: "auth_token=not.a.jwt" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.authenticated).toBe(false);
    expect(json.user).toBeNull();
  });

  test("valid session cookie → authenticated with email/method claims", async () => {
    const token = await createDashboardAuthToken({ email: "op@example.com", method: "api_key" });
    const res = await app.request("/api/dashboard-auth/status", {
      headers: { cookie: `auth_token=${token}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { authenticated: boolean; user: { email: string; method: string } };
    expect(json.authenticated).toBe(true);
    expect(json.user.email).toBe("op@example.com");
    expect(json.user.method).toBe("api_key");
  });

  test("valid OIDC-config row flips oidcEnabled to true", async () => {
    await db.insert(settings).values({
      key: OIDC_KEY,
      value: JSON.stringify({ enabled: true, issuer: "https://issuer.example.com", clientId: "cid" }),
    });
    const res = await app.request("/api/dashboard-auth/status");
    const json = (await res.json()) as { oidcEnabled: boolean };
    expect(json.oidcEnabled).toBe(true);
  });

  test("unparseable oidc_config row falls back to disabled (no throw)", async () => {
    await db.insert(settings).values({ key: OIDC_KEY, value: "{not json" });
    const res = await app.request("/api/dashboard-auth/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { oidcEnabled: boolean };
    expect(json.oidcEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /login — pool credential → httpOnly session cookie.
// ---------------------------------------------------------------------------
describe("POST /api/dashboard-auth/login (cookie issuance)", () => {
  test("pool key → 200 + httpOnly auth_token session cookie", async () => {
    const res = await postJson("/api/dashboard-auth/login", { password: POOL_KEY });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; user: { email: string; method: string } };
    expect(json.success).toBe(true);
    expect(json.user.method).toBe("api_key");

    const setCookie = sessionCookieOf(res);
    expect(setCookie).toBeDefined();
    expect(setCookie!.toLowerCase()).toContain("httponly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=86400"); // SESSION_TTL_HOURS=24
    expect(setCookie!.toLowerCase()).toContain("samesite=lax");
    // Plain HTTP request (no x-forwarded-proto) → cookie must NOT be Secure.
    expect(setCookie!.toLowerCase()).not.toContain("secure");

    // The issued cookie is a real session: /status accepts it.
    const jwt = setCookie!.split(";")[0]!.slice("auth_token=".length);
    const status = await app.request("/api/dashboard-auth/status", {
      headers: { cookie: `auth_token=${jwt}` },
    });
    const sj = (await status.json()) as { authenticated: boolean; user: { email: string } };
    expect(sj.authenticated).toBe(true);
    expect(sj.user.email).toBe("admin");
  });

  test("TLS-forwarded request marks the session cookie Secure", async () => {
    const res = await postJson(
      "/api/dashboard-auth/login",
      { password: POOL_KEY },
      { "x-forwarded-proto": "https" },
    );
    expect(res.status).toBe(200);
    const setCookie = sessionCookieOf(res);
    expect(setCookie).toBeDefined();
    expect(setCookie!.toLowerCase()).toContain("secure");
  });

  test("unknown credential → 401 'Invalid password' (never says API key)", async () => {
    const res = await postJson("/api/dashboard-auth/login", { password: "definitely-wrong-credential" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid password");
    expect(json.error.toLowerCase()).not.toContain("api key");
    expect(sessionCookieOf(res)).toBeUndefined();
  });

  test("empty password → 401 Invalid password", async () => {
    const res = await postJson("/api/dashboard-auth/login", { password: "   " });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid password");
  });

  test("malformed JSON body → 401 (treated as empty password, no 500)", async () => {
    const res = await app.request(
      "/api/dashboard-auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
      { ip: nextPeerIp() },
    );
    expect(res.status).toBe(401);
  });

  test("managed (friend) key → 403 Access denied + tripwire security event, key NOT revoked", async () => {
    await db.insert(apiKeys).values({ key: FRIEND_KEY, name: "dash-auth-test friend", isActive: true });
    invalidateResolvedApiKeys();

    const res = await postJson("/api/dashboard-auth/login", { password: FRIEND_KEY });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Access denied.");
    expect(sessionCookieOf(res)).toBeUndefined();

    // Tripwire fired: a security_events row names the dashboard-login surface.
    const events = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.surface, "dashboard-login"));
    expect(events.length).toBeGreaterThan(0);

    // The friend key stays active — only the caller IP is punished, and
    // loopback test IPs are never banned.
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.key, FRIEND_KEY));
    expect(row?.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /logout — clear the session cookie.
// ---------------------------------------------------------------------------
describe("POST /api/dashboard-auth/logout (cookie clear)", () => {
  test("returns success and expires the auth_token cookie", async () => {
    const res = await app.request("/api/dashboard-auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);

    const setCookie = sessionCookieOf(res);
    expect(setCookie).toBeDefined();
    // deleteCookie writes an immediately-expired cookie.
    expect(setCookie).toContain("Max-Age=0");
  });

  test("after logout the old cookie value is overwritten (clear round-trip)", async () => {
    const login = await postJson("/api/dashboard-auth/login", { password: POOL_KEY });
    expect(login.status).toBe(200);
    const issued = sessionCookieOf(login)!;

    const logout = await app.request("/api/dashboard-auth/logout", {
      method: "POST",
      headers: { cookie: issued.split(";")[0]! },
    });
    const cleared = sessionCookieOf(logout)!;
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toMatch(/^auth_token=;/); // value emptied
  });
});

// ---------------------------------------------------------------------------
// OIDC gating — configuration checks that run BEFORE any network fetch.
// No live OIDC provider is ever contacted.
// ---------------------------------------------------------------------------
describe("OIDC-config gating (no live OIDC)", () => {
  test("GET /oidc/start without config → 400 OIDC not configured (no fetch)", async () => {
    const res = await app.request("/api/dashboard-auth/oidc/start");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OIDC not configured");
  });

  test("GET /oidc/start with enabled:true but no issuer/clientId → 400", async () => {
    await db.insert(settings).values({ key: OIDC_KEY, value: JSON.stringify({ enabled: true }) });
    const res = await app.request("/api/dashboard-auth/oidc/start");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OIDC not configured");
  });

  test("GET /oidc/test without config → 400 OIDC not configured", async () => {
    const res = await app.request("/api/dashboard-auth/oidc/test");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OIDC not configured");
  });

  test("GET /oidc/callback without config → 400 OIDC not configured", async () => {
    const res = await app.request("/api/dashboard-auth/oidc/callback?code=x&state=y");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("OIDC not configured");
  });

  test("GET /oidc/callback configured but missing state/verifier cookies → 400 state mismatch before any upstream call", async () => {
    await db.insert(settings).values({
      key: OIDC_KEY,
      value: JSON.stringify({ enabled: true, issuer: "https://issuer.example.com", clientId: "cid" }),
    });
    // code+state query params present, but no oidc_state/oidc_verifier cookies
    // were ever set by /oidc/start — the handler must reject before fetching
    // discovery or exchanging the code.
    const res = await app.request("/api/dashboard-auth/oidc/callback?code=abc&state=xyz");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid OIDC callback (state mismatch)");
  });

  test("GET /oidc/callback with forged state cookie that does not match query → 400", async () => {
    await db.insert(settings).values({
      key: OIDC_KEY,
      value: JSON.stringify({ enabled: true, issuer: "https://issuer.example.com", clientId: "cid" }),
    });
    const res = await app.request("/api/dashboard-auth/oidc/callback?code=abc&state=query-state", {
      headers: { cookie: "oidc_state=cookie-state; oidc_verifier=v; oidc_nonce=n" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid OIDC callback (state mismatch)");
  });
});
