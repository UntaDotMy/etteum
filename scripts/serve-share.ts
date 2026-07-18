#!/usr/bin/env bun
/**
 * Friend-key status server (etteum pool share card).
 *
 * Serves a single self-contained page (share/index.html) on SHARE_PORT
 * (default 80) and same-origin proxies GET /v1/share → BACKEND_ORIGIN so the
 * browser never hits a cross-origin fetch (localhost vs 127.0.0.1 CORS).
 *
 * The page shows one key's usable models + token quota. It NEVER touches
 * /api/*, so a friend key cannot enumerate accounts, settings, or the admin
 * dashboard. This process holds no DB, no provider tokens, no admin session.
 *
 * Env:
 *   SHARE_PORT      (default: 80)
 *   HOST            (default: 0.0.0.0 — the friend must reach this page)
 *   BACKEND_ORIGIN  (default: http://127.0.0.1:<PORT|1930>)
 *   SHARE_BASE_URL  (optional) absolute base URL shown for the /v1 route, e.g.
 *                   https://pool.example.com/v1 — when the friend reaches the
 *                   backend through a tunnel rather than this page's host.
 *   SHARE_LOCK      "1" = link-only (no manual paste). Always treated as link-first.
 */

const sharePort = Number(process.env.SHARE_PORT) || 80;
const host = process.env.HOST || "0.0.0.0";
const backendOrigin =
  process.env.BACKEND_ORIGIN || `http://127.0.0.1:${Number(process.env.PORT) || 1930}`;
const shareBaseUrl = process.env.SHARE_BASE_URL || "";
// "1" = link-only mode: the page only shows keys embedded in the share link
// (#k=…) and hides any manual paste box.
const shareLock = process.env.SHARE_LOCK === "1" ? "1" : "0";

const htmlFile = new URL("../share/index.html", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");

const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // Same-origin /v1/share proxy + Google Fonts only. No direct browser→backend.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:",
};

const PROXY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

if (!(await Bun.file(htmlFile).exists())) {
  console.error("[share] share/index.html not found.");
  process.exit(1);
}

/** Forward GET /v1/share to the pool backend (same-origin for the browser). */
async function proxyShare(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    return new Response(JSON.stringify({ error: { message: "Method not allowed", type: "invalid_request_error" } }), {
      status: 405,
      headers: { ...PROXY_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...PROXY_HEADERS,
        "Access-Control-Allow-Origin": "null", // same-origin only; preflight unused
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  const incoming = new URL(req.url);
  const target = new URL("/v1/share" + incoming.search, backendOrigin);
  const headers = new Headers();
  const auth = req.headers.get("authorization");
  if (auth) headers.set("Authorization", auth);
  // Loopback identity so the backend's local rate-limit bypass still applies.
  headers.set("X-Forwarded-For", "127.0.0.1");

  try {
    const upstream = await fetch(target.toString(), {
      method: "GET",
      headers,
      // why: never cache a key-scoped status payload
      cache: "no-store",
    });
    const body = await upstream.arrayBuffer();
    const out = new Headers(PROXY_HEADERS);
    out.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(body, { status: upstream.status, headers: out });
  } catch {
    return new Response(
      JSON.stringify({ error: { message: "Could not reach the pool backend", type: "server_error" } }),
      { status: 502, headers: { ...PROXY_HEADERS, "Content-Type": "application/json" } },
    );
  }
}

Bun.serve({
  port: sharePort,
  hostname: host,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/share") {
      return proxyShare(req);
    }

    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      return new Response("not found", { status: 404 });
    }

    const html = (await Bun.file(htmlFile).text())
      .replaceAll("__BACKEND_ORIGIN__", backendOrigin)
      .replaceAll("__SHARE_BASE_URL__", shareBaseUrl)
      .replaceAll("__SHARE_LOCK__", shareLock);
    return new Response(html, { headers: PAGE_HEADERS });
  },
});

console.log(`[share] etteum pool share on http://${host}:${sharePort}  →  backend ${backendOrigin} (proxies /v1/share)`);
