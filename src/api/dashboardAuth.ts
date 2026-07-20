/**
 * Dashboard authentication routes.
 *
 * Establishes a server-side session via an httpOnly JWT cookie. The primary
 * credential is the pool key (login form is labeled only "Password" — never
 * advertise that it is an API key). Optional OIDC SSO remains.
 * Progressive brute-force lockout still applies; wrong credentials and
 * friend keys ban the caller's IP for 9999 days without revoking any key.
 */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  createDashboardAuthToken,
  verifyDashboardAuthToken,
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
import { resolveApiKey } from "./keys";
import {
  banInvalidLoginIp,
  clientIdentityFromHeaders,
  effectiveClientIp,
  logSecurityEvent,
  triggerFriendKeyTripwire,
} from "../utils/ip-ban";

export const dashboardAuthRouter = new Hono();

/** GET /api/dashboard-auth/status — is there an active session? */
dashboardAuthRouter.get("/status", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const payload = await verifyDashboardAuthToken(token);
  const oidc = await getOidcRuntimeConfig();
  return c.json({
    authenticated: !!payload,
    user: payload ? { email: payload.email || "admin", method: payload.method || "api_key" } : null,
    oidcEnabled: oidc.enabled,
    // Password login was removed — the dashboard signs in with the pool API
    // key (field still labeled "password" in the UI).
    passwordConfigured: false,
  });
});

/**
 * POST /api/dashboard-auth/login — pool credential → httpOnly session cookie.
 * Field name stays "password". Pool key signs in; managed (friend) key bans
 * the caller IP only (key stays active for /v1); anything else bans the IP
 * for invalid login. Never advertise "API key" in client-facing errors.
 */
dashboardAuthRouter.post("/login", async (c) => {
  const headers = c.req.raw.headers;
  const headerIp = getClientIp(headers);
  const lock = checkLock(headerIp);
  if (lock.locked) {
    return c.json({ error: `Too many attempts. Locked. Retry in ${lock.retryAfter}s.` }, 429, { "Retry-After": String(lock.retryAfter) });
  }
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  const presented = (body.password || "").trim();
  const ip = effectiveClientIp(c);
  const identity = clientIdentityFromHeaders(headers);
  if (!presented) {
    recordFail(headerIp);
    await banInvalidLoginIp({
      ip,
      path: "/api/dashboard-auth/login",
      headers,
      detail: "empty password at dashboard login",
    });
    return c.json({ error: "Invalid password" }, 401);
  }

  const resolved = await resolveApiKey(presented, {});
  // TRIPWIRE — friend key on dashboard: ban this IP only; keep the key alive.
  if (resolved.valid && resolved.scope === "managed") {
    await triggerFriendKeyTripwire({
      token: presented,
      apiKeyId: resolved.apiKeyId,
      surface: "dashboard-login",
      path: "/api/dashboard-auth/login",
      ip,
      headers,
    });
    return c.json({ error: "Access denied." }, 403);
  }
  if (!resolved.valid) {
    recordFail(headerIp);
    await banInvalidLoginIp({
      ip,
      path: "/api/dashboard-auth/login",
      keyPreview: presented.slice(0, 12) + "…",
      headers,
      detail: "unresolved credential presented at dashboard login",
    });
    return c.json({ error: "Invalid password" }, 401);
  }

  recordSuccess(headerIp);
  await logSecurityEvent({
    ip,
    surface: "dashboard-login",
    path: "/api/dashboard-auth/login",
    keyPreview: presented.slice(0, 12) + "…",
    action: "login_pool_success",
    userAgent: identity.userAgent,
    machineId: identity.machineId,
    clientHost: identity.clientHost,
  });
  const token = await createDashboardAuthToken({ email: "admin", method: "api_key" });
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(headers) as any);
  return c.json({ success: true, user: { email: "admin", method: "api_key" } });
});

/** POST /api/dashboard-auth/logout — clear the session cookie. */
dashboardAuthRouter.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
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
