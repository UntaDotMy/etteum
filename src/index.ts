import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config, validateSecurityConfig } from "./config";
import { runMigrations } from "./db/migrate";
import { apiRouter } from "./api/index";
import { authRouter } from "./auth/index";
import { proxyRouter } from "./proxy/index";
import { mediaRouter } from "./proxy/media/router";
import { mcpRouter } from "./proxy/mcp/router";
import { searchRouter } from "./proxy/search/router";
import { websocketHandler, getClientCount } from "./ws/index";
import { authorizeDashboardWebSocket } from "./ws/dashboard-auth";
import { extractApiKey, isManagedKeyHttpRouteAllowed } from "./utils/security";
import {
  effectiveClientIp,
  effectiveClientIpFromParts,
  isIpBanned,
  triggerFriendKeyTripwire,
} from "./utils/ip-ban";
import { resolveApiKey, extractMachineId } from "./api/keys";
import { getCookie } from "hono/cookie";
import { verifyDashboardAuthToken, SESSION_COOKIE } from "./auth/dashboardSecurity";
import { autoWarmupScheduler } from "./auth/warmup-scheduler";
import { warmupQueue } from "./auth/warmup-queue";
import { autoRefreshScheduler } from "./auth/refresh-scheduler";
import { db, client as sqliteClient } from "./db/index";
import { apiKeys } from "./db/schema";
import { eq } from "drizzle-orm";
import { bootstrapFilterRules } from "./db/filter-bootstrap";
import { bootstrapCompressionSettings } from "./db/compression-bootstrap";
import { ensureModelMappingTable, seedModelMappings, loadModelMappingCache } from "./proxy/model-mapping";
import { refreshByokModels, refreshGitlabDuoModels, refreshAlibabaModels, refreshCompatibleNodes, refreshCustomModels } from "./proxy/providers/registry";
import { setupLogRotation } from "./utils/log-rotation";
import { recoverJobsOnBoot } from "./auth/automation/bulkImport";
import { disableMitm } from "./proxy/mitm/manager";
import { installConsoleBridge } from "./api/debug";
import {
  dashboardAssetCacheHeaders,
  dashboardAssetNotFoundResponse,
  dashboardIndexHeaders,
  isDashboardAssetPath,
} from "./utils/dashboard-static";

// Mirror console output into Live Console SSE ring buffer (dashboard /console).
installConsoleBridge();

// ── Security config gate ────────────────────────────────────────────────
const securityProblems = validateSecurityConfig();
if (securityProblems.length > 0) {
  console.error("╔══════════════════════════════════════════════════════════════════╗");
  console.error("║  SECURITY CONFIGURATION WARNING                                   ║");
  console.error("╚══════════════════════════════════════════════════════════════════╝");
  for (const p of securityProblems) {
    console.error(`  ! ${p}`);
  }
  if (process.env.POOLPROX_ALLOW_INSECURE === "1") {
    console.error("  (POOLPROX_ALLOW_INSECURE=1 set — continuing anyway. NOT for production.)");
  } else {
    console.error("  Refusing to start. Set the missing keys in .env, or set");
    console.error("  POOLPROX_ALLOW_INSECURE=1 for local development only.");
    process.exit(1);
  }
}

// Setup log rotation (runs in background, checks every 5 minutes)
setupLogRotation();

// Run database migrations on startup
await runMigrations();

// recover bulk-import jobs left running by a crash/restart (mark
// interrupted items as error + move the job to a terminal status).
recoverJobsOnBoot();

// Filter rules: seed once + apply policy once (not every boot).
try {
  await bootstrapFilterRules();
} catch (e) {
  console.error("[DB] Filter rules bootstrap skipped:", e instanceof Error ? e.message : e);
}

// Compression settings: clamp pathological RTK values (e.g. max_tool_chars=150).
try {
  await bootstrapCompressionSettings();
} catch (e) {
  console.error("[DB] Compression settings bootstrap skipped:", e instanceof Error ? e.message : e);
}

// Ensure model_mappings table exists (idempotent), seed Claude Code templates
// on first boot, then load the in-memory cache used by the proxy hot path.
try {
  ensureModelMappingTable();
  await seedModelMappings();
  await loadModelMappingCache();
} catch (e) {
  console.error("[DB] Model mapping init skipped:", e instanceof Error ? e.message : e);
}

// Pre-warm BYOK provider cache so ownsModel() works from the first request
try {
  console.log("[BYOK] Warming up cache...");
  await refreshByokModels();
  console.log("[BYOK] Cache warmed up successfully");
} catch (e) {
  console.error("[BYOK] Cache warm-up skipped:", e instanceof Error ? e.message : e);
}

// load dynamic compatible-node providers so their prefixes route from boot.
try {
  await refreshCompatibleNodes();
} catch (e) {
  console.error("[CompatibleNodes] load skipped:", e instanceof Error ? e.message : e);
}

// load dashboard-added custom + disabled models so they route + list from boot.
try {
  await refreshCustomModels();
} catch (e) {
  console.error("[CustomModels] load skipped:", e instanceof Error ? e.message : e);
}

// Pre-warm GitLab Duo provider cache (model list is per-account, queried at
// onboarding via GraphQL `aiChatAvailableModels` and stored in metadata).
try {
  console.log("[GitLab Duo] Warming up cache...");
  await refreshGitlabDuoModels();
  console.log("[GitLab Duo] Cache warmed up successfully");
} catch (e) {
  console.error("[GitLab Duo] Cache warm-up skipped:", e instanceof Error ? e.message : e);
}

// Discover the full Alibaba DashScope model catalog (GET /v1/models) so the
// /v1/models list shows every upstream model, not just the curated subset.
// Quota tracking still covers only the 6 KEY_PROBE_MODELS.
try {
  console.log("[Alibaba] Discovering model catalog...");
  await refreshAlibabaModels();
  console.log("[Alibaba] Model catalog refreshed");
} catch (e) {
  console.error("[Alibaba] Model discovery skipped:", e instanceof Error ? e.message : e);
}

// Start auto-warmup scheduler (reads settings from DB)
await autoWarmupScheduler.start();

// start proactive token-refresh scheduler (refreshes tokens before they
// expire; uses the F8 coordinator for dedup/lock/retry). .unref()'d internally
// so it never keeps the process alive.
await autoRefreshScheduler.start();

// One-shot startup warmup across ALL providers (independent of the dashboard
// auto-warmup enable flags). Syncs each account's quota/tokens with upstream
// so requests work immediately after boot — without this, the pool trusts
// stale DB quota (e.g. an Alibaba model whose free period reset upstream but
// still shows exhausted in the DB) and fails fast with "All accounts failed".
// Fire-and-forget: must not delay the server becoming reachable.
setTimeout(() => {
  void (async () => {
    try {
      const count = await warmupQueue.queueAll({}); // all providers, active+exhausted+error
      console.log(`[Warmup] Startup pass queued ${count} account(s) across all providers`);
    } catch (e) {
      console.error("[Warmup] Startup pass failed:", e instanceof Error ? e.message : e);
    }
  })();
}, 1500);

// Create Hono app
const app = new Hono();

// Middleware
// CORS — allowlist the dashboard + friend-share origins rather than a blanket "*".
  // Configurable via POOLPROX_CORS_ORIGINS (comma-separated, merged with defaults).
  // Browsers treat localhost and 127.0.0.1 as different origins; port 80/443 omit
  // the port in Origin (so http://localhost must be listed, not only :80).
  const corsOrigins = (process.env.POOLPROX_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const shareOrigins = [
    `http://localhost:${config.sharePort}`,
    `http://127.0.0.1:${config.sharePort}`,
  ];
  // Default HTTP/HTTPS origins without an explicit port (share on 80 / reverse proxy).
  if (config.sharePort === 80) {
    shareOrigins.push("http://localhost", "http://127.0.0.1");
  }
  if (config.sharePort === 443) {
    shareOrigins.push("https://localhost", "https://127.0.0.1");
  }
  const sharePublic = process.env.SHARE_PUBLIC_URL?.trim();
  if (sharePublic) {
    try {
      shareOrigins.push(new URL(sharePublic).origin);
    } catch {
      /* ignore malformed SHARE_PUBLIC_URL */
    }
  }
  const defaultOrigins = [
    `http://localhost:${config.dashboardPort}`,
    `http://127.0.0.1:${config.dashboardPort}`,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    ...shareOrigins,
  ];
  // Env list extends defaults (does not replace) so share/dashboard keep working.
  const allowedOrigins = [...new Set([...defaultOrigins, ...corsOrigins])];
  app.use(
    "*",
    cors({
      origin: (origin) => {
        // Allow same-origin (no Origin header) and allowlisted origins.
        if (!origin) return null;
        return allowedOrigins.includes(origin) ? origin : null;
      },
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "x-api-key",
        "x-machine-id",
        "x-etteum-machine-id",
        "x-9r-machine-id",
      ],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
app.use("*", logger());

// IP ban gate — abuser IPs (friend-key on admin / wrong dashboard login)
// are blocked from EVERY service. Keys stay active for other IPs.
app.use("*", async (c, next) => {
  const ip = effectiveClientIp(c);
  if (await isIpBanned(ip)) {
    return c.json(
      { error: { message: "This address is banned from using the service.", type: "auth_error" } },
      403
    );
  }
  return next();
});

// API Key authentication middleware for proxy endpoints
app.use("/v1/*", async (c, next) => {
  // Preflight must not require a bearer token (browser sends OPTIONS without it).
  if (c.req.method === "OPTIONS") {
    return next();
  }
  // Friend status page does its own auth/listing; skip the global gate so
  // /v1/share and /v1/share/board are reachable without a bearer token.
  const path = new URL(c.req.url).pathname;
  if (path === "/v1/share" || path === "/v1/share/" || path.startsWith("/v1/share/")) {
    return next();
  }

  const token = extractApiKey(c.req.raw.headers, null, { allowQuery: false });

  if (!token) {
    return c.json(
      { error: { message: "Missing Authorization header", type: "auth_error" } },
      401
    );
  }

  // resolveApiKey checks both the legacy single key and the multi-key table.
  // Machine-bound managed keys require a matching x-machine-id header.
  const machineId = extractMachineId(c.req.raw.headers, null);
  const resolved = await resolveApiKey(token, { machineId });
  if (!resolved.valid) {
    return c.json(
      {
        error: {
          message: resolved.reason === "machine_mismatch"
            ? "API key is bound to a different machine"
            : "Invalid API key",
          type: "auth_error",
        },
      },
      401
    );
  }
  // Pool/install key: no apiKeyId → full model catalog, no friend limits.
  // Managed key: apiKeyId set → allowlist / quota / rate apply.
  if (resolved.valid && resolved.scope === "managed") {
    if (!isManagedKeyHttpRouteAllowed(c.req.method, path)) {
      return c.json(
        {
          error: {
            message: "Managed API keys are limited to completion and model endpoints.",
            type: "permission_error",
            code: "managed_key_scope_denied",
          },
        },
        403,
      );
    }
    (c.req.raw as any).apiKeyId = resolved.apiKeyId;
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, resolved.apiKeyId))
      .then(() => {}, () => {});
  } else {
    delete (c.req.raw as any).apiKeyId;
  }

  await next();
});

// Also protect Codex HTTP alias (same as /v1/* API-key auth).
app.use("/backend-api/*", async (c, next) => {
  const token = extractApiKey(c.req.raw.headers, null, { allowQuery: false });
  if (!token) {
    return c.json(
      { error: { message: "Missing Authorization header", type: "auth_error" } },
      401
    );
  }
  const machineId = extractMachineId(c.req.raw.headers, null);
  const resolved = await resolveApiKey(token, { machineId });
  if (!resolved.valid) {
    return c.json(
      {
        error: {
          message: resolved.reason === "machine_mismatch"
            ? "API key is bound to a different machine"
            : "Invalid API key",
          type: "auth_error",
        },
      },
      401
    );
  }
  if (resolved.valid && resolved.scope === "managed") {
    const path = new URL(c.req.url).pathname;
    if (!isManagedKeyHttpRouteAllowed(c.req.method, path)) {
      return c.json(
        {
          error: {
            message: "Managed API keys are limited to completion and model endpoints.",
            type: "permission_error",
            code: "managed_key_scope_denied",
          },
        },
        403,
      );
    }
    (c.req.raw as any).apiKeyId = resolved.apiKeyId;
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, resolved.apiKeyId))
      .then(() => {}, () => {});
  } else {
    delete (c.req.raw as any).apiKeyId;
  }
  await next();
});

// Management API auth: valid pool API key OR dashboard JWT session cookie.
// Paths that may be reached WITHOUT either. These either carry their own
// auth (dashboard password / OIDC / key-test / brute-force lockout) or are
// non-sensitive public reads. The dashboard login flow MUST be reachable
// before the user has a key — otherwise login is impossible on a fresh
// install (OWASP API2:2023 Broken Authentication).
const AUTHLESS_API_PATHS = new Set([
  "/api/health",
  "/api/info",
  "/api/keys/test",
  "/api/dashboard-auth/status",
  "/api/dashboard-auth/login",
  "/api/dashboard-auth/logout",
  "/api/dashboard-auth/oidc/start",
  "/api/dashboard-auth/oidc/callback",
  "/api/dashboard-auth/oidc/test",
]);

app.use("/api/*", async (c, next) => {
  // Allow health check, info, key validation, and SSE frame streams without header auth
  // (EventSource cannot send custom headers, so SSE uses ?token= query param)
  if (AUTHLESS_API_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  // Dual gate: API key (existing clients) OR dashboard JWT cookie (password/OIDC).
  const token = extractApiKey(c.req.raw.headers, new URL(c.req.url).searchParams, { allowQuery: true });
  if (token) {
    const machineId = extractMachineId(c.req.raw.headers, new URL(c.req.url).searchParams);
    const resolved = await resolveApiKey(token, { machineId });
    if (resolved.valid) {
      // TRIPWIRE: managed (friend) key on an admin surface — ban this IP only.
      // Key stays active so other IPs can keep using /v1.
      if (resolved.scope === "managed") {
        const ip = effectiveClientIp(c);
        await triggerFriendKeyTripwire({
          token,
          apiKeyId: resolved.apiKeyId,
          surface: "api",
          path: c.req.path,
          ip,
          headers: c.req.raw.headers,
        });
        return c.json(
          { error: { message: "Access denied.", type: "auth_error" } },
          403
        );
      }
      delete (c.req.raw as any).apiKeyId;
      await next();
      return;
    }
  }

  const sessionToken = getCookie(c, SESSION_COOKIE);
  const session = await verifyDashboardAuthToken(sessionToken);
  if (session) {
    (c.req.raw as any).dashboardSession = session;
    await next();
    return;
  }

  return c.json(
    { error: { message: "Unauthorized", type: "auth_error" } },
    401
  );
});

// Mount routes
app.route("/", proxyRouter); // /v1/chat/completions, /v1/models
app.route("/", mediaRouter); // /v1/audio/*, /v1/images/*, /v1/embeddings 
app.route("/", mcpRouter); // /v1/mcp/* — MCP stdio↔SSE bridge 
app.route("/", searchRouter); // /v1/search — web search 
app.route("/api", apiRouter); // /api/accounts, /api/settings, /api/stats
app.route("/api/auth", authRouter); // /api/auth/login, /api/auth/queue

// Health/info endpoint (moved from / to /api/health)
app.get("/api/info", (c) => {
  return c.json({
    name: "pool-proxy",
    version: config.buildVersion,
    commit: config.buildCommit,
    status: "running",
    endpoints: {
      proxy: "/v1/chat/completions",
      anthropic: "/v1/messages",
      models: "/v1/models",
      accounts: "/api/accounts",
      stats: "/api/stats",
      settings: "/api/settings",
      auth: "/api/auth",
      health: "/api/health",
      websocket: "/ws",
    },
    wsClients: getClientCount(),
    // Friend-key status console: public base URL + link-only mode, so the
    // dashboard can build copyable per-key share links.
    share: {
      url: process.env.SHARE_PUBLIC_URL || null,
      port: config.sharePort,
      lock: process.env.SHARE_LOCK === "1",
    },
  });
});

// Serve dashboard static files (SPA fallback for app routes only — never for /assets/*)
const dashboardDist = new URL("../dashboard/dist", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const dashboardIndex = `${dashboardDist}/index.html`;

// Start server with WebSocket support
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 255,
  async fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // Dashboard live feed — dual auth like /api/*:
      //   ?api_key= (pool admin key) OR httpOnly session cookie (password/OIDC).
      // Browsers cannot set Authorization on WS upgrades. After password login
      // the SPA clears localStorage api_key and relies on the session cookie.
      const wsSockAddr = server.requestIP(req);
      const wsPeerIp =
        typeof wsSockAddr === "string"
          ? wsSockAddr
          : ((wsSockAddr as { address?: string } | null)?.address ?? null);
      const wsIp = effectiveClientIpFromParts(wsPeerIp, req.headers);
      if (await isIpBanned(wsIp)) {
        return new Response("Banned", { status: 403 });
      }
      const wsAuth = await authorizeDashboardWebSocket({
        apiKeyQuery: url.searchParams.get("api_key"),
        cookieHeader: req.headers.get("cookie"),
        ip: wsIp,
        headers: req.headers,
      });
      if (!wsAuth.ok) {
        return new Response(wsAuth.body, { status: wsAuth.status });
      }
      const upgraded = server.upgrade(req, { data: {} });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket Responses API (OpenAI Realtime-style). Same auth as the HTTP
    // /v1/* endpoints (Authorization: Bearer or x-api-key). Tagged via data.kind
    // so the shared websocketHandler can dispatch to the proxy handler instead
    // of the dashboard handler.
    //
    // Path matching tolerates a trailing slash. Only GET requests with an
    // Upgrade: websocket header take the WS branch. Everything else (the
    // Codex CLI HTTP POST, GET probes) falls through to Hono — do NOT 426.
    const isResponsesWsPath =
      url.pathname === "/v1/responses" ||
      url.pathname === "/v1/responses/" ||
      url.pathname === "/backend-api/codex/responses" ||
      url.pathname === "/backend-api/codex/responses/";
    const wantsWebSocket =
      req.method === "GET" &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (isResponsesWsPath && wantsWebSocket) {
      // Client request surface — ban gate applies (no tripwire: managed keys OK).
      const rwSockAddr = server.requestIP(req);
      const rwPeerIp =
        typeof rwSockAddr === "string"
          ? rwSockAddr
          : ((rwSockAddr as { address?: string } | null)?.address ?? null);
      if (await isIpBanned(effectiveClientIpFromParts(rwPeerIp, req.headers))) {
        return new Response("Banned", { status: 403 });
      }
      const token = extractApiKey(req.headers, null, { allowQuery: false });
      const resolved = token
        ? await resolveApiKey(token, { machineId: extractMachineId(req.headers, null) })
        : { valid: false as const };
      if (!resolved.valid) {
        return new Response("Unauthorized", { status: 401 });
      }
      // The WS passthrough path does not own friend-key quota accounting, so
      // managed keys use the fully-accounted HTTP Responses endpoint instead.
      if (resolved.scope === "managed") {
        return new Response("Managed API keys cannot use WebSocket transport", { status: 403 });
      }
      // Bun auto-negotiates Sec-WebSocket-Protocol; we just tag the socket.
      const upgraded = server.upgrade(req, {
        data: { kind: "responses-proxy", path: url.pathname.replace(/\/$/, "") },
      });
      if (upgraded) return undefined;
      // server.upgrade returned false — log the handshake headers so this is
      // debuggable (usual cause: a reverse proxy stripping Upgrade/Connection).
      console.warn(
        "[WS] /v1/responses upgrade rejected. upgrade=",
        req.headers.get("upgrade"),
        "connection=",
        req.headers.get("connection"),
        "hasKey=",
        !!req.headers.get("sec-websocket-key"),
        "version=",
        req.headers.get("sec-websocket-version"),
      );
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    // Non-upgrade requests to /v1/responses fall through to Hono (POST = HTTP
    // Responses API; GET = 404 -> SPA). Do NOT return 426 here — that breaks
    // the Codex CLI HTTP POST (wire_api=responses).

    // Try Hono routes first (API, proxy, etc.).
    // Pass both peer IP and the Bun server so adminGuard/peerIpFromHonoContext
    // can resolve loopback for local-only admin routes (e.g. /api/update/apply).
    const response = await app.fetch(req, {
      ip: server.requestIP(req),
      server,
    });
    if (response.status !== 404) return response;

    // Fallback: serve dashboard static files
    const pathname = url.pathname;
    const filePath = `${dashboardDist}${pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file, {
        headers: dashboardAssetCacheHeaders(pathname),
      });
    }

    // Missing hashed JS/CSS must NOT fall through to index.html — browsers
    // then report "Expected a JavaScript module but got text/html".
    if (isDashboardAssetPath(pathname)) {
      return dashboardAssetNotFoundResponse();
    }

    // SPA fallback: app routes only (e.g. /accounts/kiro)
    const indexFile = Bun.file(dashboardIndex);
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: dashboardIndexHeaders(),
      });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: websocketHandler,
});

console.log(`
╔══════════════════════════════════════════════════╗
║           🔄 Pool Proxy Server                   ║
╠══════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${config.port}               ║
║  WebSocket: ws://localhost:${config.port}/ws              ║
║  Database:  SQLite                              ║
║  Dashboard: http://localhost:${config.dashboardPort}              ║
╠══════════════════════════════════════════════════╣
║  Endpoints:                                      ║
║    POST /v1/chat/completions  (proxy)            ║
║    POST /v1/messages          (Anthropic)        ║
║    GET  /v1/models            (models)           ║
║    GET  /api/accounts         (management)       ║
║    GET  /api/stats            (statistics)       ║
║    WS   /ws                   (real-time)        ║
╚══════════════════════════════════════════════════╝
`);

// on shutdown, stop the MITM server + strip DNS hijack entries so the
// IDEs' hardcoded vendor hosts resolve normally again. Best-effort. Also
// drain the HTTP server (let in-flight requests finish) and checkpoint the
// SQLite WAL so recent writes aren't left unflushed.
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[shutdown] ${signal} received — cleaning up…`);
  try { disableMitm(); } catch { /* best effort */ }
  // Stop accepting new connections; allow in-flight requests a moment to finish.
  try { server.stop(true); } catch { /* best effort */ }
  // Flush the WAL to the main DB file so committed writes survive the exit.
  try { sqliteClient.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
  try { sqliteClient.close(); } catch { /* best effort */ }
  process.exit(0);
}
let shuttingDown = false;
process.on("SIGTERM", () => { if (!shuttingDown) { shuttingDown = true; void gracefulShutdown("SIGTERM"); } });
process.on("SIGINT", () => { if (!shuttingDown) { shuttingDown = true; void gracefulShutdown("SIGINT"); } });

export default server;
