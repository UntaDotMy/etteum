#!/usr/bin/env bun
/**
 * Public entry on SHARE_PORT (default 80):
 *   GET  /  or /index.html     → status board HTML
 *   *    /v1/*                 → backend (OpenAI + Anthropic + media + share board)
 *   *    /backend-api/*        → backend (Codex alias)
 *
 * This is the public API base for friends/clients when the cloud firewall only
 * allows 80/443. Admin /api/* is intentionally NOT proxied here.
 *
 * Env:
 *   SHARE_PORT, HOST, BACKEND_ORIGIN, SHARE_BASE_URL, SHARE_LOCK
 */

const sharePort = Number(process.env.SHARE_PORT) || 80;
const host = process.env.HOST || "0.0.0.0";
const backendOrigin =
  process.env.BACKEND_ORIGIN || `http://127.0.0.1:${Number(process.env.PORT) || 1930}`;
const shareBaseUrl = process.env.SHARE_BASE_URL || "";
const shareLock = process.env.SHARE_LOCK === "1" ? "1" : "0";

const htmlFile = new URL("../share/index.html", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");

const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:",
};

if (!(await Bun.file(htmlFile).exists())) {
  console.error("[share] share/index.html not found.");
  process.exit(1);
}

function isClientApiPath(pathname: string): boolean {
  return (
    pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname === "/backend-api" ||
    pathname.startsWith("/backend-api/")
  );
}

/**
 * Full reverse proxy to the pool backend for OpenAI/Anthropic/media/Codex routes.
 * Streams request/response bodies (required for chat SSE).
 *
 * Stamps X-Forwarded-For with the REAL TCP peer so the backend's IP-ban /
 * friend-key tripwire sees the actual caller instead of this proxy's loopback.
 * OVERWRITES any client-supplied XFF — a spoofed header must not get someone
 * else banned.
 */
async function proxyToBackend(req: Request, pathname: string, peerIp: string | null): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(pathname + incoming.search, backendOrigin);
  const headers = new Headers(req.headers);
  headers.delete("host");
  if (peerIp) headers.set("x-forwarded-for", peerIp);

  // CORS preflight for browser clients hitting this public origin.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
        "Access-Control-Allow-Headers":
          req.headers.get("access-control-request-headers") ||
          "Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, x-machine-id",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers,
      redirect: "manual",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }
    const upstream = await fetch(target.toString(), init);
    const out = new Headers(upstream.headers);
    // Allow browser tools from other origins when using the public status host as API base.
    const origin = req.headers.get("origin");
    if (origin) {
      out.set("Access-Control-Allow-Origin", origin);
      out.set("Vary", "Origin");
    } else if (!out.has("Access-Control-Allow-Origin")) {
      out.set("Access-Control-Allow-Origin", "*");
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    console.error("[share] proxy to backend failed:", err);
    return new Response(
      JSON.stringify({ error: { message: "Could not reach the pool backend", type: "server_error" } }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}

Bun.serve({
  port: sharePort,
  hostname: host,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Full client API surface (same routes as backend).
    if (isClientApiPath(pathname)) {
      const sock = server.requestIP(req);
      const peerIp =
        typeof sock === "string"
          ? sock
          : ((sock as { address?: string } | null)?.address ?? null);
      return proxyToBackend(req, pathname, peerIp);
    }

    // Status board UI only — never expose admin /api/* here.
    if (pathname !== "/" && pathname !== "/index.html") {
      return new Response(
        JSON.stringify({
          error: {
            message: "Not found. Client API lives under /v1/* (and /backend-api/*).",
            type: "invalid_request_error",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const html = (await Bun.file(htmlFile).text())
      .replaceAll("__BACKEND_ORIGIN__", backendOrigin)
      .replaceAll("__SHARE_BASE_URL__", shareBaseUrl)
      .replaceAll("__SHARE_LOCK__", shareLock);
    return new Response(html, { headers: PAGE_HEADERS });
  },
});

console.log(
  `[share] public entry http://${host}:${sharePort}  →  backend ${backendOrigin} (proxies /v1/* + /backend-api/*; status UI on /)`,
);
