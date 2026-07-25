/**
 * Auth gate for the dashboard live-feed WebSocket (`/ws`).
 *
 * Browsers cannot set Authorization on WS upgrades, so we accept:
 *   1) `?api_key=` (pool admin key) — legacy / API-key login mode
 *   2) dashboard JWT session cookie (`auth_token`) — password/OIDC login
 *
 * Matches management `/api/*` dual-gate semantics. Managed (friend) keys are
 * tripwired and rejected; sessions are always admin-scoped.
 */
import { resolveApiKey } from "../api/keys";
import { SESSION_COOKIE, verifyDashboardAuthToken } from "../auth/dashboardSecurity";
import { triggerFriendKeyTripwire } from "../utils/ip-ban";
import { getCookieValue } from "../utils/security";

export type DashboardWsAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; body: string };

/** Optional deps for unit tests — avoid process-wide mock.module pollution. */
export type DashboardWsAuthDeps = {
  resolveApiKey?: typeof resolveApiKey;
  triggerFriendKeyTripwire?: typeof triggerFriendKeyTripwire;
  verifyDashboardAuthToken?: typeof verifyDashboardAuthToken;
  sessionCookie?: string;
};

export async function authorizeDashboardWebSocket(args: {
  apiKeyQuery: string | null;
  cookieHeader: string | null | undefined;
  ip: string;
  headers: Headers;
  deps?: DashboardWsAuthDeps;
}): Promise<DashboardWsAuthResult> {
  const resolve = args.deps?.resolveApiKey ?? resolveApiKey;
  const tripwire = args.deps?.triggerFriendKeyTripwire ?? triggerFriendKeyTripwire;
  const verifySession = args.deps?.verifyDashboardAuthToken ?? verifyDashboardAuthToken;
  const cookieName = args.deps?.sessionCookie ?? SESSION_COOKIE;

  const presented = (args.apiKeyQuery || "").trim();
  if (presented) {
    const resolved = await resolve(presented, {});
    if (resolved.valid) {
      if (resolved.scope === "managed") {
        await tripwire({
          token: presented,
          apiKeyId: resolved.apiKeyId,
          surface: "ws",
          path: "/ws",
          ip: args.ip,
          headers: args.headers,
        });
        return { ok: false, status: 403, body: "Access denied." };
      }
      return { ok: true };
    }
    // Invalid non-empty key: do not fall through to cookie (wrong key must fail).
    return { ok: false, status: 401, body: "Unauthorized" };
  }

  const sessionToken = getCookieValue(args.cookieHeader, cookieName);
  const session = await verifySession(sessionToken || undefined);
  if (session) {
    return { ok: true };
  }

  return { ok: false, status: 401, body: "Unauthorized" };
}
