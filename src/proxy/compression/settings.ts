/**
 * Compression settings loader — reads keys from the `settings` table with a
 * 10s TTL cache. Mirrors the pattern used by services/proxy-pool.ts.
 *
 * Keys read (all optional; defaults from DEFAULT_COMPRESSION_CONFIG):
 *   compression_rtk_enabled                 "true" | "false"
 *   compression_rtk_max_tool_chars          int (string)
 *   compression_rtk_keep_last_n_turns_full  int (string)
 *   compression_rtk_smart_truncate          "true" | "false"
 *   compression_dcp_enabled                 "true" | "false"
 *   compression_dcp_whitelist               JSON array of strings
 *   compression_caveman_enabled             "true" | "false"
 *   compression_caveman_level               "lite" | "full" | "ultra"
 *   compression_cache_markers_enabled       "true" | "false"
 *   compression_cache_markers_overrides     JSON object {provider: bool}
 *   compression_image_dedupe_enabled        "true" | "false"
 *   compression_tsc_enabled                 "true" | "false"
 *   compression_tsc_strip_schema_whitespace "true" | "false"
 *   compression_tsc_trim_descriptions       "true" | "false"
 *   compression_tsc_drop_schema_meta        "true" | "false"
 */

import { db } from "../../db/index";
import { settings } from "../../db/schema";
import { eq, like } from "drizzle-orm";
import {
  DEFAULT_COMPRESSION_CONFIG,
  DEFAULT_DCP_WHITELIST,
  type CavemanLevel,
  type CompressionConfig,
} from "./types";

const TTL_MS = 10_000;

let cache: { config: CompressionConfig; loadedAt: number } | null = null;

function parseBool(v: string | null | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return dflt;
}

function parseInt10(v: string | null | undefined, dflt: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function parseCavemanLevel(v: string | null | undefined): CavemanLevel {
  const s = (v || "").trim().toLowerCase();
  if (s === "full" || s === "ultra") return s;
  return "lite";
}

function parseStringArray(v: string | null | undefined, dflt: string[]): string[] {
  if (v == null) return dflt;
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
  } catch {
    /* ignore */
  }
  return dflt;
}

function parseBoolMap(v: string | null | undefined, dflt: Record<string, boolean>): Record<string, boolean> {
  if (v == null) return dflt;
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, val] of Object.entries(parsed)) {
        if (typeof val === "boolean") out[k] = val;
      }
      return { ...dflt, ...out };
    }
  } catch {
    /* ignore */
  }
  return dflt;
}

async function loadFromDb(): Promise<CompressionConfig> {
  const rows = await db.select().from(settings).where(like(settings.key, "compression_%"));
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.key, r.value);

  const dflt = DEFAULT_COMPRESSION_CONFIG;
  return {
    rtk: {
      enabled: parseBool(map.get("compression_rtk_enabled"), dflt.rtk.enabled),
      maxToolChars: parseInt10(
        map.get("compression_rtk_max_tool_chars"),
        dflt.rtk.maxToolChars,
        500,
        50_000
      ),
      keepLastNTurnsFull: parseInt10(
        map.get("compression_rtk_keep_last_n_turns_full"),
        dflt.rtk.keepLastNTurnsFull,
        0,
        20
      ),
      smartTruncate: parseBool(
        map.get("compression_rtk_smart_truncate"),
        dflt.rtk.smartTruncate
      ),
    },
    dcp: {
      enabled: parseBool(map.get("compression_dcp_enabled"), dflt.dcp.enabled),
      whitelist: parseStringArray(map.get("compression_dcp_whitelist"), DEFAULT_DCP_WHITELIST),
    },
    caveman: {
      enabled: parseBool(map.get("compression_caveman_enabled"), dflt.caveman.enabled),
      level: parseCavemanLevel(map.get("compression_caveman_level")),
    },
    cacheMarkers: {
      enabled: parseBool(map.get("compression_cache_markers_enabled"), dflt.cacheMarkers.enabled),
      providerOverrides: parseBoolMap(
        map.get("compression_cache_markers_overrides"),
        dflt.cacheMarkers.providerOverrides
      ),
    },
    imageDedupe: {
      enabled: parseBool(map.get("compression_image_dedupe_enabled"), dflt.imageDedupe.enabled),
    },
    tsc: {
      enabled: parseBool(map.get("compression_tsc_enabled"), dflt.tsc.enabled),
      stripSchemaWhitespace: parseBool(
        map.get("compression_tsc_strip_schema_whitespace"),
        dflt.tsc.stripSchemaWhitespace
      ),
      trimDescriptions: parseBool(
        map.get("compression_tsc_trim_descriptions"),
        dflt.tsc.trimDescriptions
      ),
      dropSchemaMeta: parseBool(map.get("compression_tsc_drop_schema_meta"), dflt.tsc.dropSchemaMeta),
    },
  };
}

export async function getCompressionConfig(): Promise<CompressionConfig> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < TTL_MS) return cache.config;
  try {
    const config = await loadFromDb();
    cache = { config, loadedAt: now };
    return config;
  } catch (err) {
    console.error("[Compression] Failed to load settings, using defaults:", err);
    return DEFAULT_COMPRESSION_CONFIG;
  }
}

/** Return cached config synchronously, or null if not yet loaded. */
export function getCachedCompressionConfig(): CompressionConfig | null {
  if (!cache) return null;
  if (Date.now() - cache.loadedAt > TTL_MS) return null;
  return cache.config;
}

export function invalidateCompressionCache(): void {
  cache = null;
}

export function isCompressionSettingKey(key: string): boolean {
  return key.startsWith("compression_");
}
