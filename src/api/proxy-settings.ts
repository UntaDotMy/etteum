import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { pool } from "../proxy/pool";
import { autoWarmupScheduler, isAutoWarmupSettingKey } from "../auth/warmup-scheduler";
import { invalidateProxySettingsCache } from "../services/proxy-pool";
import {
  invalidateCompressionCache,
  isCompressionSettingKey,
  DEFAULT_COMPRESSION_CONFIG,
} from "../proxy/compression";

function isProxyPoolSettingKey(key: string): boolean {
  return key === "proxy_pool_usage" || key === "proxy_pool_rotation";
}

export const proxySettingsRouter = new Hono();

/**
 * GET /api/settings/providers - List configured providers (source of truth: config.providers)
 */
proxySettingsRouter.get("/providers", async (c) => {
  return c.json({ data: config.providers });
});

/**
 * GET /api/settings - Get all settings (merged with backend defaults).
 *
 * Returns every known setting key — if a key has no DB value its backend
 * default is served so the dashboard never needs hardcoded fallbacks.
 */
proxySettingsRouter.get("/", async (c) => {
  const allSettings = await db.select().from(settings);
  const settingsMap: Record<string, string> = {};
  for (const s of allSettings) {
    settingsMap[s.key] = s.value;
  }

  // Merge backend defaults for any key not yet persisted in the DB.
  // This ensures the dashboard always sees the full configuration as the
  // backend understands it — no drift between UI preview and runtime.
  const df = DEFAULT_COMPRESSION_CONFIG;
  const defaults: Record<string, string> = {
    load_balancing_method: "round_robin",
    auto_warmup_interval_minutes: "15",
    warmup_concurrency: "50",
    proxy_pool_usage: "all",
    proxy_pool_rotation: "round_robin",
    compression_rtk_enabled: String(df.rtk.enabled),
    compression_rtk_max_tool_chars: String(df.rtk.maxToolChars),
    compression_rtk_keep_last_n_turns_full: String(df.rtk.keepLastNTurnsFull),
    compression_rtk_smart_truncate: String(df.rtk.smartTruncate),
    compression_dcp_enabled: String(df.dcp.enabled),
    compression_caveman_enabled: String(df.caveman.enabled),
    compression_caveman_level: df.caveman.level,
    compression_cache_markers_enabled: String(df.cacheMarkers.enabled),
    compression_image_dedupe_enabled: String(df.imageDedupe.enabled),
    compression_tsc_enabled: String(df.tsc.enabled),
    compression_tsc_strip_schema_whitespace: String(df.tsc.stripSchemaWhitespace),
    compression_tsc_trim_descriptions: String(df.tsc.trimDescriptions),
    compression_tsc_drop_schema_meta: String(df.tsc.dropSchemaMeta),
    compression_ponytail_enabled: String(df.ponytail.enabled),
    compression_caveman_injection_enabled: String(df.cavemanInjection.enabled),
    compression_caveman_injection_level: df.cavemanInjection.level,
    compression_ponytail_injection_enabled: String(df.ponytailInjection.enabled),
    compression_ponytail_injection_level: df.ponytailInjection.level,
    compression_headroom_enabled: String(df.headroom.enabled),
    compression_headroom_url: df.headroom.url,
    compression_headroom_compress_user_messages: String(df.headroom.compressUserMessages),
    compression_headroom_timeout_ms: String(df.headroom.timeoutMs),
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in settingsMap)) settingsMap[k] = v;
  }

  return c.json({ data: settingsMap, defaults: true });
});

/**
 * GET /api/settings/:key - Get a specific setting
 */
proxySettingsRouter.get("/:key", async (c) => {
  const key = c.req.param("key");
  const [setting] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key));

  if (!setting) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json(setting);
});

/**
 * PUT /api/settings/:key - Set a setting value
 */
proxySettingsRouter.put("/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{ value: string }>();

  if (body.value === undefined) {
    return c.json({ error: "value is required" }, 400);
  }

  // Upsert
  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key));

  if (existing.length > 0) {
    await db
      .update(settings)
      .set({ value: body.value, updatedAt: new Date() })
      .where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value: body.value });
  }

  if (key === "load_balancing_method" || /^provider_.+_lb_method$/.test(key) || /^byok_.+_lb_method$/.test(key)) {
    pool.invalidateLoadBalancingCache();
  }

  if (isProxyPoolSettingKey(key)) {
    invalidateProxySettingsCache();
  }

  if (isAutoWarmupSettingKey(key)) {
    void autoWarmupScheduler.reload();
  }

  if (isCompressionSettingKey(key)) {
    invalidateCompressionCache();
  }

  return c.json({ key, value: body.value });
});

/**
 * DELETE /api/settings/:key - Delete a setting
 */
proxySettingsRouter.delete("/:key", async (c) => {
  const key = c.req.param("key");
  const result = await db
    .delete(settings)
    .where(eq(settings.key, key))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json({ success: true, deleted: key });
});

/**
 * PUT /api/settings - Bulk update settings
 */
proxySettingsRouter.put("/", async (c) => {
  const body = await c.req.json<Record<string, string>>();

  let lbCacheTouched = false;
  let warmupTouched = false;
  let proxyPoolTouched = false;
  let compressionTouched = false;
  for (const [key, value] of Object.entries(body)) {
    const existing = await db
      .select()
      .from(settings)
      .where(eq(settings.key, key));

    if (existing.length > 0) {
      await db
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({ key, value });
    }

    if (key === "load_balancing_method" || /^provider_.+_lb_method$/.test(key) || /^byok_.+_lb_method$/.test(key)) {
      lbCacheTouched = true;
    }
    if (isProxyPoolSettingKey(key)) {
      proxyPoolTouched = true;
    }
    if (isAutoWarmupSettingKey(key)) {
      warmupTouched = true;
    }
    if (isCompressionSettingKey(key)) {
      compressionTouched = true;
    }
  }

  if (lbCacheTouched) pool.invalidateLoadBalancingCache();
  if (proxyPoolTouched) invalidateProxySettingsCache();
  if (warmupTouched) void autoWarmupScheduler.reload();
  if (compressionTouched) invalidateCompressionCache();

  return c.json({ success: true, updated: Object.keys(body).length });
});
