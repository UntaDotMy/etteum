#!/usr/bin/env bun
/**
 * Lightweight static file server for dashboard/dist + same-origin API proxy.
 *
 * The browser only talks to DASHBOARD_PORT. /api/* is forwarded to the backend
 * on this machine (BACKEND_ORIGIN or http://127.0.0.1:PORT) so:
 *   - custom ports (e.g. 2891 → 2890) work without a special Vite build
 *   - public admin access needs only the dashboard port open for REST
 *   - session cookies stay on the dashboard origin
 *
 * WebSocket live updates still go to the backend port (injected as
 * window.__POOL_ENV__.backendPort) — open PORT in the firewall for WS.
 *
 * Env:
 *   DASHBOARD_PORT  (default: 1931)
 *   PORT            (backend port, default: 1930)
 *   BACKEND_ORIGIN  (default: http://127.0.0.1:<PORT>)
 *   HOST            (bind address, default: 0.0.0.0 for public access)
 */

import {
  dashboardAssetCacheHeaders,
  dashboardAssetNotFoundResponse,
  dashboardIndexHeaders,
  isDashboardAssetPath,
} from "../src/utils/dashboard-static";

const port = Number(process.env.DASHBOARD_PORT) || 1931;
const backendPort = Number(process.env.PORT) || 1930;
const host = process.env.HOST || "0.0.0.0";
const backendOrigin =
  process.env.BACKEND_ORIGIN || `http://127.0.0.1:${backendPort}`;

const distDir = new URL("../dashboard/dist", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const indexFile = `${distDir}/index.html`;

if (!(await Bun.file(indexFile).exists())) {
  console.error("[dashboard] dashboard/dist not found. Run: cd dashboard && bun run build");
  process.exit(1);
}

const ENV_SNIPPET = `<script>window.__POOL_ENV__=${JSON.stringify({
  backendPort,
})};</script>`;

async function loadIndexHtml(): Promise<string> {
  const html = await Bun.file(indexFile).text();
  if (html.includes("window.__POOL_ENV__")) return html;
  if (html.includes("<head>")) return html.replace("<head>", `<head>${ENV_SNIPPET}`);
  return ENV_SNIPPET + html;
}

/** Forward /api/* to the pool backend (same machine). */
async function proxyToBackend(req: Request, pathname: string): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(pathname + incoming.search, backendOrigin);
  const headers = new Headers(req.headers);
  headers.delete("host");
  // Prefer real client IP for rate limits / auth locality checks.
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) {
    // Bun may not expose peer; leave unset for loopback proxy.
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
    // Pass through status + headers (incl. Set-Cookie for dashboard login).
    const out = new Headers(upstream.headers);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    console.error("[dashboard] proxy to backend failed:", err);
    return new Response(JSON.stringify({ error: "Backend unreachable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

Bun.serve({
  port,
  hostname: host,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Same-origin API proxy → backend (public admin without CORS pain).
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return proxyToBackend(req, pathname);
    }

    const filePathname = pathname === "/" ? "/index.html" : pathname;

    // Exact file
    let filePath = `${distDir}${filePathname}`;
    let file = Bun.file(filePath);

    if (await file.exists()) {
      if (filePathname === "/index.html" || filePathname.endsWith("/index.html")) {
        return new Response(await loadIndexHtml(), { headers: dashboardIndexHeaders() });
      }
      return new Response(file, {
        headers: dashboardAssetCacheHeaders(filePathname),
      });
    }

    // Directory index
    if (!pathname.includes(".")) {
      filePath = `${distDir}${pathname}/index.html`;
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(await loadIndexHtml(), { headers: dashboardIndexHeaders() });
      }
    }

    if (isDashboardAssetPath(pathname)) {
      return dashboardAssetNotFoundResponse();
    }

    // SPA fallback
    return new Response(await loadIndexHtml(), {
      headers: dashboardIndexHeaders(),
    });
  },
});

console.log(
  `[dashboard] http://${host}:${port}  →  API proxy ${backendOrigin}  (WS clients use public host:${backendPort})`,
);
