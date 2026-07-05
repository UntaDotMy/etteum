import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config, validateSecurityConfig } from "./config";
import { runMigrations } from "./db/migrate";
import { apiRouter } from "./api/index";
import { authRouter } from "./auth/index";
import { proxyRouter } from "./proxy/index";
import { websocketHandler, getClientCount } from "./ws/index";
import { isValidApiKey } from "./api/keys";
import { extractApiKey } from "./utils/security";
import { autoWarmupScheduler } from "./auth/warmup-scheduler";
import { warmupQueue } from "./auth/warmup-queue";
import { db } from "./db/index";
import { filterRules } from "./db/schema";
import { sql, inArray } from "drizzle-orm";
import { PUDIDIL_FILTERS } from "./proxy/filters";
import { loadFilterCache } from "./proxy/filter-cache";
import { ensureModelMappingTable, seedModelMappings, loadModelMappingCache } from "./proxy/model-mapping";
import { refreshByokModels, refreshGitlabDuoModels, refreshAlibabaModels } from "./proxy/providers/registry";
import { setupLogRotation } from "./utils/log-rotation";

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

// Seed filter rules from PUDIDIL_FILTERS if table is empty (first boot only)
try {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(filterRules);
  if (Number(row?.count || 0) === 0) {
    await db.insert(filterRules).values(
      PUDIDIL_FILTERS.map((r, i) => ({
        ruleId: r.id,
        pattern: r.pattern,
        replacement: r.replacement,
        isActive: r.is_active,
        isRegex: r.is_regex,
        sortOrder: i,
      }))
    );
    console.log(`[DB] Seeded ${PUDIDIL_FILTERS.length} filter rules`);
  }

  // Purge deprecated filter rules with broken or over-broad regex patterns.
  await db.delete(filterRules).where(inArray(filterRules.ruleId, [
    "remove_claude_code_identity_variations",
    "remove_cline_identity",
    "remove_ai_coding_agent_pattern",
    "remove_mcp_server_ref",
    "remove_powered_by_anthropic",
    "remove_claude_code_mention",
  ]));


  // Disable the word-rewrite tier (the rules that rewrote common technical
  // words like {terminate, access, modify, tool, device, threat, ...} to
  // moderation-neutral synonyms). That tier mangled tool-call arguments,
  // tool results, commands, and file paths, which broke Codex tool
  // execution ("dumb" tool calls). Rules stay in the DB (is_active=false)
  // so they can be re-enabled per-provider from the dashboard; nothing is
  // deleted. The rule_ids below are the true upstream ids.
  await db.update(filterRules).set({ isActive: false }).where(
    inArray(filterRules.ruleId, [
    "neutralize_kill",
    "neutralize_kill_upper",
    "neutralize_kill_allcaps",
    "neutralize_exploit",
    "neutralize_exploit_upper",
    "neutralize_attack",
    "neutralize_attack_upper",
    "neutralize_attacker",
    "neutralize_attacker_upper",
    "neutralize_hack",
    "neutralize_hack_upper",
    "neutralize_weapon",
    "neutralize_weapon_upper",
    "neutralize_bomb",
    "neutralize_bomb_upper",
    "neutralize_terror",
    "neutralize_terror_upper",
    "neutralize_suicide",
    "neutralize_suicide_upper",
    "neutralize_violence",
    "neutralize_violence_upper",
    "neutralize_political",
    "neutralize_political_upper",
    "neutralize_kill_regex",
    "neutralize_exploit_regex",
    "neutralize_attack_regex",
    "neutralize_hack_regex",
    ])
  );


  // Disable the brand-neutralization tier (Claude->[AI-ASSISTANT],
  // [AI-LAB-B]->[AI-LAB-B], [AI-LAB-A]->[AI-LAB-A], ...). Per user request:
  // brand names must pass through verbatim, no rewriting at all. Only
  // telemetry stripping + identity-line neutralization remain active.
  // Rules stay in the DB (is_active=false); re-enable via dashboard.
  await db.update(filterRules).set({ isActive: false }).where(
    inArray(filterRules.ruleId, [
    "neutralize_anthropic",
    "neutralize_anthropic_lower",
    "neutralize_claude_code",
    "neutralize_claude_code_lower",
    "neutralize_openai",
    "neutralize_openai_lower",
    "neutralize_chatgpt",
    "neutralize_chatgpt_lower",
    "neutralize_gemini",
    "neutralize_gemini_lower",
    "neutralize_google_ai",
    "neutralize_google_ai_lower",
    "neutralize_llama",
    "neutralize_llama_lower",
    "neutralize_meta_ai",
    "neutralize_meta_ai_lower",
    ])
  );
  await loadFilterCache();
} catch (e) {
  console.error("[DB] Filter rules seed/load skipped:", e instanceof Error ? e.message : e);
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
// CORS — allowlist the dashboard origin(s) rather than a blanket "*".
  // Configurable via POOLPROX_CORS_ORIGINS (comma-separated); defaults to the
  // dashboard port on localhost. Set to "*" only for local dev if needed.
  const corsOrigins = (process.env.POOLPROX_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const dashboardOrigin = `http://localhost:${config.dashboardPort}`;
  const allowedOrigins = corsOrigins.length > 0 ? corsOrigins : [dashboardOrigin];
  app.use(
    "*",
    cors({
      origin: (origin) => {
        // Allow same-origin (no Origin header) and allowlisted origins.
        if (!origin) return null;
        return allowedOrigins.includes(origin) ? origin : null;
      },
      allowHeaders: ["Authorization", "Content-Type", "x-api-key"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );
app.use("*", logger());

// API Key authentication middleware for proxy endpoints
app.use("/v1/*", async (c, next) => {
  const token = extractApiKey(c.req.raw.headers, null, { allowQuery: false });

  if (!token) {
    return c.json(
      { error: { message: "Missing Authorization header", type: "auth_error" } },
      401
    );
  }

  if (!(await isValidApiKey(token))) {
    return c.json(
      { error: { message: "Invalid API key", type: "auth_error" } },
      401
    );
  }

  await next();
});

// API Key authentication for management API
app.use("/api/*", async (c, next) => {
  // Allow health check, info, and key validation without auth
  if (c.req.path === "/api/health" || c.req.path === "/api/info" || c.req.path === "/api/keys/test") {
    await next();
    return;
  }

  const token = extractApiKey(c.req.raw.headers, new URL(c.req.url).searchParams, { allowQuery: true });

  if (!token || !(await isValidApiKey(token))) {
    return c.json(
      { error: { message: "Unauthorized", type: "auth_error" } },
      401
    );
  }

  await next();
});

// Mount routes
app.route("/", proxyRouter); // /v1/chat/completions, /v1/models
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
  });
});

// Serve dashboard static files (SPA fallback)
const dashboardDist = new URL("../dashboard/dist", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const dashboardIndex = `${dashboardDist}/index.html`;

const staticMimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// Start server with WebSocket support
const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  async fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // Dashboard WebSocket — authenticate via ?api_key= query (browsers cannot
      // set Authorization headers on WS upgrades). Mirrors the /v1/responses
      // WS auth gate so unauthenticated clients cannot read live request
      // metadata (provider, model, account email, errors).
      const wsToken = url.searchParams.get("api_key");
      if (!wsToken || !(await isValidApiKey(wsToken))) {
        return new Response("Unauthorized", { status: 401 });
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
      const token = extractApiKey(req.headers, null, { allowQuery: false });
      if (!token || !(await isValidApiKey(token))) {
        return new Response("Unauthorized", { status: 401 });
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

    // Try Hono routes first (API, proxy, etc.)
    const response = await app.fetch(req, { ip: server.requestIP(req) });
    if (response.status !== 404) return response;

    // Fallback: serve dashboard static files
    const pathname = url.pathname;
    const filePath = `${dashboardDist}${pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = pathname.slice(pathname.lastIndexOf("."));
      // Hashed assets (e.g. Accounts-AbCd1234.js) can be cached forever.
      // index.html must never be cached so the browser picks up new hashes.
      const isHtml = ext === ".html";
      const cacheControl = isHtml
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=31536000, immutable";
      return new Response(file, {
        headers: {
          "Content-Type": staticMimeTypes[ext] || "application/octet-stream",
          "Cache-Control": cacheControl,
        },
      });
    }

    // SPA fallback: serve index.html for non-file routes
    const indexFile = Bun.file(dashboardIndex);
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
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

export default server;
