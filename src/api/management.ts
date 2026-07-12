/**
 * Management API — TS port of 9router's model/pricing/sync/tunnel/system routes.
 *
 * Closes the remaining API-surface gaps :
 *   - /api/models/{disabled,custom,availability,test} — model management
 *   - /api/pricing                              — per-model USD pricing CRUD
 *   - /api/sync/merge-to-target                 — config sync/migration
 *   - /api/tunnel/{enable,disable,status}       — Cloudflare/Tailscale tunnel
 *   - /api/system/specs                         — host system specs
 *
 * Backed by the `kv` table  for customModels / disabledModels / pricing.
 */
import { Hono } from "hono";
import { db } from "../db/index";
import { kv } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { getAllModels } from "../proxy/router";
import { pool } from "../proxy/pool";
import { adminGuard } from "../utils/security";
import { invalidatePricingCache, getPricingForModel } from "../proxy/pricing";
import { refreshCustomModels } from "../proxy/providers/registry";
import { routeRequest } from "../proxy/router";
import type { ChatCompletionRequest } from "../proxy/providers/base";

export const managementRouter = new Hono();

/**
 * Attach resolved pricing (from the catalog + user overrides) to each model.
 * The `cbc-`/`qd-`/etc. prefixes are provider aliases; getPricingForModel
 * resolves them to the canonical model name and looks up the rate, so the
 * "all models" list shows cost even for aliased entries.
 */
async function attachPricing(models: any[]): Promise<any[]> {
  return Promise.all(models.map(async (m) => {
    const pricing = await getPricingForModel(m.id).catch(() => null);
    return { ...m, pricing: pricing ?? null };
  }));
}

// --- KV helpers (scope = customModels | disabledModels | pricing | mitmAlias) ---
async function kvGet(scope: string): Promise<Record<string, any>> {
  const rows = await db.select().from(kv).where(eq(kv.scope, scope));
  const out: Record<string, any> = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}
async function kvSet(scope: string, key: string, value: any): Promise<void> {
  const val = typeof value === "string" ? value : JSON.stringify(value);
  const [existing] = await db.select().from(kv).where(and(eq(kv.scope, scope), eq(kv.key, key))).limit(1);
  if (existing) {
    await db.update(kv).set({ value: val, updatedAt: new Date() }).where(and(eq(kv.scope, scope), eq(kv.key, key)));
  } else {
    await db.insert(kv).values({ scope, key, value: val, updatedAt: new Date() });
  }
}
async function kvDelete(scope: string, key: string): Promise<void> {
  await db.delete(kv).where(and(eq(kv.scope, scope), eq(kv.key, key)));
}

// --- Models: list + availability ---
managementRouter.get("/models/all", async (c) => {
  const models = await attachPricing(getAllModels());
  return c.json({ models });
});

/**
 * GET /api/models/active — only models backed by an active+enabled account.
 * Lighter than /models/all (which returns the entire catalog incl. models no
 * account can serve). The dashboard can call this to avoid fetching everything.
 */
managementRouter.get("/models/active", async (c) => {
  const models = getAllModels();
  const filtered: typeof models = [];
  await Promise.all(models.map(async (m) => {
    const acct = await pool.getAccountForModel(m.id).catch(() => null);
    if (acct) filtered.push(m);
  }));
  return c.json({ models: await attachPricing(filtered) });
});

managementRouter.get("/models/availability", async (c) => {
  // Per-model availability: whether an active+enabled account can serve it.
  const models = getAllModels();
  const availability: Record<string, { available: boolean }> = {};
  for (const m of models) {
    const acct = await pool.getAccountForModel(m.id).catch(() => null);
    availability[m.id] = { available: !!acct };
  }
  return c.json({ availability });
});

// --- Disabled models (per-provider persistence) ---
managementRouter.get("/models/disabled", async (c) => {
  return c.json({ disabled: await kvGet("disabledModels") });
});
managementRouter.post("/models/disabled", async (c) => {
  const body = await c.req.json<{ provider: string; model: string; disabled?: boolean }>();
  if (!body.provider || !body.model) return c.json({ error: "provider and model required" }, 400);
  const key = `${body.provider}:${body.model}`;
  if (body.disabled === false) {
    await kvDelete("disabledModels", key);
  } else {
    await kvSet("disabledModels", key, { provider: body.provider, model: body.model, disabledAt: Date.now() });
  }
  await refreshCustomModels();
  return c.json({ success: true });
});

// --- Custom model definitions (register model ids not in upstream /models) ---
// A custom entry MAY carry a `spec` override (context_window / max_output /
// thinking / vision). When absent, the model-specs.ts canonical default applies.
// The spec is persisted here and overrides the source defaults at list time
// (the model-specs.ts file is never mutated).
managementRouter.get("/models/custom", async (c) => {
  return c.json({ custom: await kvGet("customModels") });
});
managementRouter.post("/models/custom", async (c) => {
  const body = await c.req.json<{
    model: string;
    provider: string;
    displayName?: string;
    spec?: { context_window?: number; max_output?: number; thinking?: boolean; vision?: boolean };
    /** When renaming an existing catalog model: the old id being replaced. */
    renameFrom?: string;
    /** The upstream API model name to send to the provider (override). */
    upstreamName?: string;
  }>();
  if (!body.model || !body.provider) return c.json({ error: "model and provider required" }, 400);
  await kvSet("customModels", body.model, {
    provider: body.provider,
    displayName: body.displayName || body.model,
    ...(body.spec ? { spec: body.spec } : {}),
    ...(body.renameFrom ? { renameFrom: body.renameFrom } : {}),
    ...(body.upstreamName ? { upstreamName: body.upstreamName } : {}),
  });
  await refreshCustomModels();
  return c.json({ success: true });
});
managementRouter.delete("/models/custom/:model", async (c) => {
  await kvDelete("customModels", c.req.param("model"));
  await refreshCustomModels();
  return c.json({ success: true });
});

// --- Per-model connectivity test ---
// Routes through the REAL proxy path (routeRequest), so the test exercises the
// exact same model resolution, account selection, sanitization, and compression
// as a live client request — not a bypassed direct provider call. This means
// an aliased id (cbc-hy3-preview) is resolved by the provider exactly as a real
// request would, and account/token selection matches production behavior.
managementRouter.post("/models/test", async (c) => {
  const body = await c.req.json<{ provider: string; model: string; accountId?: number }>();
  if (!body.model) return c.json({ error: "model required" }, 400);

  try {
    // Build a minimal probe request and route it through the full pipeline.
    // stream:false → routeRequest returns a fully-assembled (non-stream) result.
    const probe: ChatCompletionRequest = {
      model: body.model,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1,
    } as any;
    const { result, account, provider, durationMs } = await routeRequest(probe, false);
    return c.json({
      ok: !!result.success,
      error: result.error,
      account: account ? { id: account.id, email: account.email, provider: account.provider } : undefined,
      routedProvider: provider,
      durationMs,
    });
  } catch (err: any) {
    // routeRequest throws when no account is available / all accounts fail.
    const msg = err?.message || String(err);
    return c.json({ ok: false, error: msg });
  }
});

// --- Pricing CRUD (per-model USD pricing) ---
managementRouter.get("/pricing", async (c) => {
  return c.json({ pricing: await kvGet("pricing") });
});
managementRouter.post("/pricing", async (c) => {
  const body = await c.req.json<{ model: string; inputPer1M?: number; outputPer1M?: number; cachedInputPer1M?: number; reasoningPer1M?: number; cacheCreationPer1M?: number }>();
  if (!body.model) return c.json({ error: "model required" }, 400);
  await kvSet("pricing", body.model, {
    inputPer1M: body.inputPer1M ?? 0,
    outputPer1M: body.outputPer1M ?? 0,
    cachedInputPer1M: body.cachedInputPer1M ?? 0,
    reasoningPer1M: body.reasoningPer1M ?? 0,
    cacheCreationPer1M: body.cacheCreationPer1M ?? 0,
    updatedAt: Date.now(),
  });
  invalidatePricingCache();
  return c.json({ success: true });
});
managementRouter.delete("/pricing/:model", async (c) => {
  await kvDelete("pricing", c.req.param("model"));
  invalidatePricingCache();
  return c.json({ success: true });
});

// --- Config sync (merge-to-target: export/import configuration) ---
managementRouter.get("/sync/export", async (c) => {
  // Export can include provider config/secrets → admin-guard it.
  const guard = adminGuard(c.req.raw.headers, new URL(c.req.url).searchParams);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  const [customModels, disabledModels, pricing] = await Promise.all([
    kvGet("customModels"), kvGet("disabledModels"), kvGet("pricing"),
  ]);
  return c.json({ customModels, disabledModels, pricing, exportedAt: Date.now() });
});
managementRouter.post("/sync/merge-to-target", async (c) => {
  const body = await c.req.json<{ customModels?: Record<string, any>; disabledModels?: Record<string, any>; pricing?: Record<string, any> }>();
  let merged = 0;
  for (const [scope, data] of Object.entries({ customModels: body.customModels, disabledModels: body.disabledModels, pricing: body.pricing })) {
    if (!data || typeof data !== "object") continue;
    for (const [key, value] of Object.entries(data)) {
      await kvSet(scope, key, value);
      merged++;
    }
  }
  return c.json({ success: true, merged });
});

// --- Tunnel management (Cloudflare / Tailscale sidecar) ---
managementRouter.get("/tunnel/status", async (c) => {
  return c.json({
    cloudflare: { enabled: !!process.env.CLOUDFLARE_TUNNEL_TOKEN, running: false },
    tailscale: { enabled: !!process.env.TAILSCALE_AUTH_KEY, running: false },
  });
});
managementRouter.post("/tunnel/enable", async (c) => {
  // Tunnel enable may spawn a sidecar process → admin-guard it.
  const guard = adminGuard(c.req.raw.headers, new URL(c.req.url).searchParams);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  const body = await c.req.json<{ provider: "cloudflare" | "tailscale"; token?: string }>().catch(() => ({}) as any);
  if (!body?.provider) return c.json({ error: "provider required (cloudflare|tailscale)" }, 400);
  // Tunnel provisioning is environment-dependent; we record the intent and
  // surface a clear action for the operator. Actual tunnel bring-up happens in
  // the entrypoint/container layer.
  return c.json({
    success: true,
    message: `Tunnel enable requested for ${body.provider}. Set ${body.provider === "cloudflare" ? "CLOUDFLARE_TUNNEL_TOKEN" : "TAILSCALE_AUTH_KEY"} and restart to activate.`,
  });
});
managementRouter.post("/tunnel/disable", async (c) => {
  const body = await c.req.json<{ provider: "cloudflare" | "tailscale" }>().catch(() => ({}) as any);
  return c.json({ success: true, message: `Tunnel ${body?.provider || "all"} disable requested.` });
});

// --- System specs (host capabilities for automation concurrency decisions) ---
managementRouter.get("/system/specs", (c) => {
  const cpus = (typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency) || 4;
  const mem = (process as any).memoryUsage?.()?.rss || 0;
  return c.json({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpuCores: cpus,
    optimalWorkers: Math.min(8, Math.max(1, Math.floor(cpus / 2))),
    rssBytes: mem,
    uptime: Math.floor(process.uptime()),
  });
});

// --- Settings upsert (for dashboard config like oidc_config) ---
// Generic key/value settings store (mirrors 9router settings). Admin-guarded
// because oidc_config can carry a client secret.
managementRouter.post("/settings", async (c) => {
  const guard = adminGuard(c.req.raw.headers, new URL(c.req.url).searchParams);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  const body = await c.req.json<{ key: string; value: string }>();
  if (!body.key) return c.json({ error: "key required" }, 400);
  const { settings } = await import("../db/schema");
  const [existing] = await db.select().from(settings).where(eq(settings.key, body.key));
  if (existing) {
    await db.update(settings).set({ value: body.value }).where(eq(settings.key, body.key));
  } else {
    await db.insert(settings).values({ key: body.key, value: body.value });
  }
  return c.json({ success: true });
});
managementRouter.get("/settings/:key", async (c) => {
  const { settings } = await import("../db/schema");
  const [row] = await db.select().from(settings).where(eq(settings.key, c.req.param("key")));
  return c.json({ value: row?.value ?? null });
});

// --- Media provider catalog (vendor list for the dashboard Media page) ---
managementRouter.get("/media/catalog", async (c) => {
  const { listMediaProviders } = await import("../proxy/media/catalog");
  const modality = c.req.query("modality") as any;
  return c.json({ providers: listMediaProviders(modality) });
});
