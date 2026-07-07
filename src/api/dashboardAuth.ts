/**
 * Dashboard authentication routes — TS port of 9router's
 * src/app/api/auth/{login,logout,status,oidc/*,reset-password}/route.js.
 *
 * Establishes a server-side session via an httpOnly JWT cookie (replaces the
 * raw-api-key-in-localStorage model). Supports password login + optional OIDC
 * SSO. Progressive brute-force lockout protects the password endpoint.
 *
 * Closes the security/multi-tenancy HIGH gaps (Wave 5).
 */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { adminGuard } from "../utils/security";
import {
  createDashboardAuthToken,
  verifyDashboardAuthToken,
  verifyDashboardPassword,
  hashDashboardPassword,
  getStoredPasswordHash,
  sessionCookieOptions,
  SESSION_COOKIE,
  getOidcRuntimeConfig,
  fetchOidcDiscovery,
  buildOidcAuthorizationUrl,
  exchangeOidcCode,
  verifyOidcIdToken,
  pickOidcEmail,
  pickOidcDisplayName,
  createOidcState,
  createOidcNonce,
  createPkcePair,
  getPublicOrigin,
  shouldUseSecureCookie,
  OIDC_COOKIE_NAMES,
  checkLock,
  recordFail,
  recordSuccess,
  getClientIp,
} from "../auth/dashboardSecurity";

export const dashboardAuthRouter = new Hono();

/** GET /api/dashboard-auth/status — is there an active session? */
dashboardAuthRouter.get("/status", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const payload = await verifyDashboardAuthToken(token);
  const oidc = await getOidcRuntimeConfig();
  // Reflects real DB state — no `|| true`. When no password hash is stored yet,
  // the dashboard shows its first-run / initial-password setup flow.
  const hasPassword = !!(await getStoredPasswordHash());
  return c.json({
    authenticated: !!payload,
    user: payload ? { email: payload.email || "admin", method: payload.method || "password" } : null,
    oidcEnabled: oidc.enabled,
    passwordConfigured: hasPassword,
  });
});

/** POST /api/dashboard-auth/login — password login → httpOnly session cookie. */
dashboardAuthRouter.post("/login", async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  const lock = checkLock(ip);
  if (lock.locked) {
    return c.json({ error: `Too many attempts. Locked. Retry in ${lock.retryAfter}s.` }, 429, { "Retry-After": String(lock.retryAfter) });
  }
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  const password = body.password || "";
  const stored = await getStoredPasswordHash();
  if (!verifyDashboardPassword(password, stored || "")) {
    recordFail(ip);
    return c.json({ error: "Invalid password" }, 401);
  }
  recordSuccess(ip);
  const token = await createDashboardAuthToken({ email: "admin", method: "password" });
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.raw.headers) as any);
  return c.json({ success: true, user: { email: "admin", method: "password" } });
});

/** POST /api/dashboard-auth/logout — clear the session cookie. */
dashboardAuthRouter.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ success: true });
});

/** POST /api/dashboard-auth/reset-password — set a new password (requires active session). */
dashboardAuthRouter.post("/reset-password", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const payload = await verifyDashboardAuthToken(token);
  if (!payload) return c.json({ error: "Not authenticated" }, 401);
  // Privilege escalation: require local origin or CLI token even with a session.
  const guard = adminGuard(c.req.raw.headers, new URL(c.req.url).searchParams);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  const body = await c.req.json<{ current?: string; newPassword?: string }>().catch(() => ({ current: "", newPassword: "" }));
  const stored = await getStoredPasswordHash();
  if (stored && !verifyDashboardPassword(body.current || "", stored)) {
    return c.json({ error: "Current password incorrect" }, 401);
  }
  if (!body.newPassword || body.newPassword.length < 6) {
    return c.json({ error: "New password must be at least 6 characters" }, 400);
  }
  const hash = await hashDashboardPassword(body.newPassword);
  const [existing] = await db.select().from(settings).where(eq(settings.key, "password"));
  if (existing) {
    await db.update(settings).set({ value: hash }).where(eq(settings.key, "password"));
  } else {
    await db.insert(settings).values({ key: "password", value: hash });
  }
  return c.json({ success: true });
});

/** GET /api/dashboard-auth/oidc/start — begin OIDC redirect flow. */
dashboardAuthRouter.get("/oidc/start", async (c) => {
  const oidc = await getOidcRuntimeConfig();
  if (!oidc.enabled || !oidc.issuer || !oidc.clientId) {
    return c.json({ error: "OIDC not configured" }, 400);
  }
  const discovery = await fetchOidcDiscovery(oidc.issuer);
  const origin = getPublicOrigin(c.req.raw.headers);
  const redirectUri = `${origin}/api/dashboard-auth/oidc/callback`;
  const state = createOidcState();
  const nonce = createOidcNonce();
  const { verifier, challenge } = createPkcePair();
  const url = await buildOidcAuthorizationUrl({ discovery, clientId: oidc.clientId, redirectUri, state, nonce, challenge, scopes: oidc.scopes });

  // Stash state/nonce/verifier in short-lived cookies for the callback.
  // `secure` mirrors reference start/route.js:37-43 so the PKCE/nonce round-trip
  // is never exposed over plain HTTP when the dashboard is fronted by TLS.
  const secure = shouldUseSecureCookie(c.req.raw.headers);
  setCookie(c, OIDC_COOKIE_NAMES.state, state, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 600 });
  setCookie(c, OIDC_COOKIE_NAMES.nonce, nonce, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 600 });
  setCookie(c, OIDC_COOKIE_NAMES.verifier, verifier, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 600 });
  return c.redirect(url);
});

/** GET /api/dashboard-auth/oidc/callback — complete OIDC, issue session cookie. */
dashboardAuthRouter.get("/oidc/callback", async (c) => {
  const oidc = await getOidcRuntimeConfig();
  if (!oidc.enabled || !oidc.issuer || !oidc.clientId) {
    return c.json({ error: "OIDC not configured" }, 400);
  }
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, OIDC_COOKIE_NAMES.state);
  const nonce = getCookie(c, OIDC_COOKIE_NAMES.nonce);
  const verifier = getCookie(c, OIDC_COOKIE_NAMES.verifier);
  if (!code || !state || state !== cookieState || !verifier) {
    return c.json({ error: "Invalid OIDC callback (state mismatch)" }, 400);
  }
  const discovery = await fetchOidcDiscovery(oidc.issuer);
  const origin = getPublicOrigin(c.req.raw.headers);
  const redirectUri = `${origin}/api/dashboard-auth/oidc/callback`;
  const tokens = await exchangeOidcCode({ discovery, clientId: oidc.clientId, clientSecret: oidc.clientSecret, code, redirectUri, verifier });
  const idToken = tokens.id_token;
  if (!idToken) return c.json({ error: "OIDC provider did not return an id_token" }, 400);
  const payload = await verifyOidcIdToken(idToken, discovery, oidc.clientId);
  if (!payload) return c.json({ error: "OIDC id_token verification failed" }, 401);
  // Nonce is mandatory when we issued one (we always do in /oidc/start). A token
  // omitting `nonce`, or carrying a mismatched one, is rejected — closes the
  // bypass where an attacker-crafted token simply omits the claim.
  if (!nonce || payload.nonce !== nonce) {
    return c.json({ error: "OIDC nonce mismatch" }, 401);
  }
  const email = pickOidcEmail(payload);
  const name = pickOidcDisplayName(payload);
  // Clean up OIDC cookies.
  deleteCookie(c, OIDC_COOKIE_NAMES.state, { path: "/" });
  deleteCookie(c, OIDC_COOKIE_NAMES.nonce, { path: "/" });
  deleteCookie(c, OIDC_COOKIE_NAMES.verifier, { path: "/" });
  const token = await createDashboardAuthToken({ email, name, method: "oidc", sub: payload.sub });
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.raw.headers) as any);
  // Redirect back to the dashboard root.
  return c.redirect("/");
});

/** GET /api/dashboard-auth/oidc/test — validate the configured OIDC issuer. */
dashboardAuthRouter.get("/oidc/test", async (c) => {
  const oidc = await getOidcRuntimeConfig();
  if (!oidc.enabled || !oidc.issuer) return c.json({ error: "OIDC not configured" }, 400);
  try {
    const discovery = await fetchOidcDiscovery(oidc.issuer);
    return c.json({ success: true, issuer: discovery.issuer, hasAuthorization: !!discovery.authorization_endpoint, hasToken: !!discovery.token_endpoint, hasJwks: !!discovery.jwks_uri });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 400);
  }
});
