/**
 * Shared dashboard static-file helpers for Bun.serve (API process) and
 * scripts/serve-dashboard.ts. Prevents SPA fallback from returning index.html
 * for missing hashed assets (which browsers reject with MIME "text/html").
 */

export const DASHBOARD_STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
};

/** True for Vite/Rollup asset URLs and any path that looks like a real file. */
export function isDashboardAssetPath(pathname: string): boolean {
  if (!pathname || pathname === "/") return false;
  if (pathname.startsWith("/assets/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/robots.txt") return true;
  const base = pathname.split("/").pop() || "";
  // e.g. AccountList-T9fan1ya.js, index-B6blkaPd.css
  return /\.[a-zA-Z0-9]{1,16}$/.test(base);
}

export function mimeForPath(pathname: string): string {
  const base = pathname.split("/").pop() || pathname;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  return DASHBOARD_STATIC_MIME[ext] || "application/octet-stream";
}

/** 404 for missing hashed chunks — never HTML (avoids strict MIME module errors). */
export function dashboardAssetNotFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, max-age=0, must-revalidate",
    },
  });
}

export function dashboardIndexHeaders(): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    // index.html must never be long-cached: it points at content-hashed assets.
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
  };
}

export function dashboardAssetCacheHeaders(pathname: string): HeadersInit {
  const base = pathname.split("/").pop() || "";
  const isHtml = base.endsWith(".html");
  // Hashed files under /assets/ are immutable; bare names stay short-cache.
  const hashed = pathname.startsWith("/assets/") && /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/i.test(base);
  return {
    "Content-Type": mimeForPath(pathname),
    "Cache-Control": isHtml
      ? "no-cache, no-store, must-revalidate"
      : hashed
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300",
  };
}
