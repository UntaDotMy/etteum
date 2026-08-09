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
import { invalidateRetryConfigCache, isRetrySettingKey } from "../proxy/retry-config";
import { redactSettingsValue } from "./management";

/** Redaction marker redactSettingsValue substitutes for secret fields. */
const REDACTED_MARKER = "***";

/**
 * Round-trip guard: GET masks oidc_config secrets, and the Settings page PUTs
 * the whole fetched map back on save. If the incoming value still carries the
 * redaction marker, merge the stored secret back in — otherwise a save from
 * the dashboard would overwrite the real clientSecret with "***".
 */
async function mergeRedactedSecrets(key: string, incoming: string): Promise<string> {
  if (key !== "oidc_config" || typeof incoming !== "string") return incoming;
  try {
    const parsed = JSON.parse(incoming) as Record<string, unknown>;
    if (!Object.values(parsed).some((v) => v === REDACTED_MARKER)) return incoming;
    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    if (!row?.value) return incoming;
    const stored = JSON.parse(row.value) as Record<string, unknown>;
    for (const [field, v] of Object.entries(parsed)) {
      if (v === REDACTED_MARKER && typeof stored[field] === "string" && stored[field] !== REDACTED_MARKER) {
        parsed[field] = stored[field];
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return incoming;
  }
}

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
    // settings.value is nullable; keep the key present (the defaults merge below
    // only fills keys that are ABSENT) but emit a string, as the type promises.
    settingsMap[s.key] = redactSettingsValue(s.key, s.value ?? "");
  }

  // Merge backend defaults for any key not yet persisted in the DB.
  // This ensures the dashboard always sees the full configuration as the
  // backend understands it — no drift between UI preview and runtime.
  const df = DEFAULT_COMPRESSION_CONFIG;
  const defaults: Record<string, string> = {
    load_balancing_method: "round_robin",
    retry_max_account_attempts: "3",
    retry_max_inner_retries: "3",
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
  // Mask secret-bearing fields (oidc_config clientSecret) — mirrors the
  // management read route's contract so the pool-key-gated read cannot pull
  // a stored credential back out.

  if (!setting) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json({ ...setting, value: redactSettingsValue(setting.key, setting.value ?? "") });
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
  body.value = await mergeRedactedSecrets(key, body.value);

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

  if (isRetrySettingKey(key)) {
    invalidateRetryConfigCache();
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
  let retryTouched = false;
  for (const [key, rawValue] of Object.entries(body)) {
    const value = await mergeRedactedSecrets(key, rawValue);
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
    if (isRetrySettingKey(key)) {
      retryTouched = true;
    }
  }

  if (lbCacheTouched) pool.invalidateLoadBalancingCache();
  if (proxyPoolTouched) invalidateProxySettingsCache();
  if (warmupTouched) void autoWarmupScheduler.reload();
  if (compressionTouched) invalidateCompressionCache();
  if (retryTouched) invalidateRetryConfigCache();

  return c.json({ success: true, updated: Object.keys(body).length });
});
