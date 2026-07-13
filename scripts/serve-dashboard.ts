#!/usr/bin/env bun
/**
 * Lightweight static file server for dashboard/dist.
 * No Vite, no HMR, no dev overhead. Just serves pre-built files.
 *
 * Usage:
 *   bun run scripts/serve-dashboard.ts
 *
 * Env:
 *   DASHBOARD_PORT (default: 1931)
 */

import {
  dashboardAssetCacheHeaders,
  dashboardAssetNotFoundResponse,
  dashboardIndexHeaders,
  isDashboardAssetPath,
} from "../src/utils/dashboard-static";

const port = Number(process.env.DASHBOARD_PORT) || 1931;
const distDir = new URL("../dashboard/dist", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const indexFile = `${distDir}/index.html`;

// Check if dashboard is built
if (!(await Bun.file(indexFile).exists())) {
  console.error("[dashboard] dashboard/dist not found. Run: cd dashboard && bun run build");
  process.exit(1);
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    // Exact file
    let filePath = `${distDir}${pathname}`;
    let file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file, {
        headers: dashboardAssetCacheHeaders(pathname === "/index.html" ? "/index.html" : pathname),
      });
    }

    // Directory index
    if (!pathname.includes(".")) {
      filePath = `${distDir}${pathname}/index.html`;
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: dashboardIndexHeaders() });
      }
    }

    // Missing /assets/*.js must never become SPA HTML (MIME module errors).
    if (isDashboardAssetPath(pathname)) {
      return dashboardAssetNotFoundResponse();
    }

    // SPA fallback for client routes
    return new Response(Bun.file(indexFile), {
      headers: dashboardIndexHeaders(),
    });
  },
});

console.log(`[dashboard] Serving production build on http://localhost:${port}`);
