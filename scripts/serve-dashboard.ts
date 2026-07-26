#!/usr/bin/env bun
/**
 * Lightweight static file server for dashboard/dist + same-origin API/WS proxy.
 *
 * The browser only talks to DASHBOARD_PORT. These paths are forwarded to the
 * backend on this machine (BACKEND_ORIGIN or http://127.0.0.1:PORT):
 *   /api/*           management + dashboard session
 *   /v1/*            OpenAI-compatible chat/models (admin Chat uses this)
 *   /backend-api/*   Codex HTTP alias
 *   /ws              live dashboard WebSocket (session cookie or ?api_key=)
 *
 * So:
 *   - custom ports (e.g. 8443 → 8880) work without a special Vite build
 *   - public admin Chat works without opening the backend port for REST
 *   - session cookies stay on the dashboard origin for /api/* and /ws
 *   - only DASHBOARD_PORT needs to be public for the admin UI (optional)
 *
 * Env:
 *   DASHBOARD_PORT  (default: 1931)
 *   PORT            (backend port, default: 1930)
 *   BACKEND_ORIGIN  (default: http://127.0.0.1:<PORT>)
 *   HOST            (bind address, default: 0.0.0.0 for public access)
 */

import type { ServerWebSocket } from "bun";
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
const backendWsOrigin = backendOrigin.replace(/^http/i, "ws");

const distDir = new URL("../dashboard/dist", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const indexFile = `${distDir}/index.html`;

if (!(await Bun.file(indexFile).exists())) {
  console.error("[dashboard] dashboard/dist not found. Run: cd dashboard && bun run build");
  process.exit(1);
}

// Kept for older dashboard builds that still read backendPort; new clients use
// same-origin /ws which this process proxies.
const ENV_SNIPPET = `<script>window.__POOL_ENV__=${JSON.stringify({
  backendPort,
})};</script>`;

type WsProxyData = {
  cookie: string;
  search: string;
  upstream: WebSocket | null;
  queue: Array<string | Buffer>;
};

async function loadIndexHtml(): Promise<string> {
  const html = await Bun.file(indexFile).text();
  if (html.includes("window.__POOL_ENV__")) return html;
  if (html.includes("<head>")) return html.replace("<head>", `<head>${ENV_SNIPPET}`);
  return ENV_SNIPPET + html;
}

/**
 * Forward /api/* to the pool backend (same machine).
 *
 * Stamps X-Forwarded-For with the REAL TCP peer, OVERWRITING any client-supplied
 * value. why: without it every proxied request reaches the backend from loopback,
 * so adminGuardFromPeer would classify a remote caller as local and hand them
 * /api/update/apply (RCE), /api/backup/* (.env + ENCRYPTION_KEY) and /api/mitm/*.
 * Same contract as scripts/serve-share.ts.
 */
async function proxyToBackend(req: Request, pathname: string, peerIp: string | null): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(pathname + incoming.search, backendOrigin);
  const headers = new Headers(req.headers);
  headers.delete("host");
  if (peerIp) headers.set("x-forwarded-for", peerIp);
  else headers.delete("x-forwarded-for");

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

function attachUpstream(ws: ServerWebSocket<WsProxyData>) {
  const target = `${backendWsOrigin}/ws${ws.data.search || ""}`;
  const headers: Record<string, string> = {};
  if (ws.data.cookie) headers.Cookie = ws.data.cookie;

  let upstream: WebSocket;
  try {
    // Bun supports custom headers on the client WebSocket (needed for session cookie).
    upstream = new WebSocket(target, { headers } as any);
  } catch (err) {
    console.error("[dashboard] WS upstream open failed:", err);
    try {
      ws.close(1011, "upstream failed");
    } catch {
      /* ignore */
    }
    return;
  }

  ws.data.upstream = upstream;

  upstream.addEventListener("open", () => {
    const q = ws.data.queue;
    ws.data.queue = [];
    for (const msg of q) {
      try {
        upstream.send(msg);
      } catch {
        /* ignore */
      }
    }
  });

  upstream.addEventListener("message", (ev) => {
    try {
      if (typeof ev.data === "string") {
        ws.send(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        ws.send(ev.data);
      } else {
        ws.send(ev.data as any);
      }
    } catch {
      /* client gone */
    }
  });

  upstream.addEventListener("close", () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });

  upstream.addEventListener("error", () => {
    try {
      ws.close(1011, "upstream error");
    } catch {
      /* ignore */
    }
  });
}

Bun.serve<WsProxyData>({
  port,
  hostname: host,
  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Same-origin WebSocket → backend /ws (forwards Cookie + query for auth).
    if (pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: {
          cookie: req.headers.get("cookie") || "",
          search: url.search,
          upstream: null,
          queue: [],
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Same-origin proxy → backend (public admin without CORS pain).
    // /v1/* is required for admin Chat streaming; without it the SPA fallback
    // returns index.html and the client shows "(empty response)".
    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname === "/v1" ||
      pathname.startsWith("/v1/") ||
      pathname === "/backend-api" ||
      pathname.startsWith("/backend-api/")
    ) {
      const sock = server.requestIP(req);
      const peerIp =
        typeof sock === "string"
          ? sock
          : ((sock as { address?: string } | null)?.address ?? null);
      return proxyToBackend(req, pathname, peerIp);
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
  websocket: {
    open(ws) {
      attachUpstream(ws);
    },
    message(ws, message) {
      const up = ws.data.upstream;
      if (up && up.readyState === WebSocket.OPEN) {
        try {
          up.send(message);
        } catch {
          /* ignore */
        }
        return;
      }
      ws.data.queue.push(message as string | Buffer);
    },
    close(ws) {
      const up = ws.data.upstream;
      ws.data.upstream = null;
      if (up) {
        try {
          up.close();
        } catch {
          /* ignore */
        }
      }
    },
  },
});

console.log(
  `[dashboard] http://${host}:${port}  →  API+WS proxy ${backendOrigin}`,
);
