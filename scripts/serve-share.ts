#!/usr/bin/env bun
/**
 * Friend-key status server (the etteum key console).
 *
 * Serves a single self-contained page (share/index.html) on SHARE_PORT
 * (default 80). The page shows one key's usable models + token quota by calling
 * the backend's authless GET /v1/share — it NEVER touches /api/*, so a friend
 * key cannot enumerate accounts, settings, or the admin dashboard.
 *
 * This process is a dumb static file server; it holds no DB, no provider
 * tokens, no admin session. The backend origin the page calls is injected at
 * request time from BACKEND_ORIGIN (defaults to the backend on this host).
 *
 * Env:
 *   SHARE_PORT      (default: 80)
 *   HOST            (default: 0.0.0.0 — the friend must reach this page)
 *   BACKEND_ORIGIN  (default: http://127.0.0.1:<PORT|1930>)
 *   SHARE_BASE_URL  (optional) absolute base URL shown for the /v1 route, e.g.
 *                   https://pool.example.com/v1 — when the friend reaches the
 *                   backend through a tunnel rather than this page's host.
 */

const sharePort = Number(process.env.SHARE_PORT) || 80;
const host = process.env.HOST || "0.0.0.0";
const backendOrigin =
  process.env.BACKEND_ORIGIN || `http://127.0.0.1:${Number(process.env.PORT) || 1930}`;
const shareBaseUrl = process.env.SHARE_BASE_URL || "";

const htmlFile = new URL("../share/index.html", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // The page is self-contained (inline script/style) and only fetches the
  // backend's /v1/share + the JetBrains Mono font from Google Fonts.
  "Content-Security-Policy":
    `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src ${backendOrigin}; img-src data:`,
};

if (!(await Bun.file(htmlFile).exists())) {
  console.error("[share] share/index.html not found.");
  process.exit(1);
}

Bun.serve({
  port: sharePort,
  hostname: host,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      return new Response("not found", { status: 404 });
    }
    const html = (await Bun.file(htmlFile).text())
      .replaceAll("__BACKEND_ORIGIN__", backendOrigin)
      .replaceAll("__SHARE_BASE_URL__", shareBaseUrl);
    return new Response(html, { headers: SECURITY_HEADERS });
  },
});

console.log(`[share] etteum key console on http://${host}:${sharePort}  →  backend ${backendOrigin}`);
