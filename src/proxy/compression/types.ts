/**
 * Compression module — shared types.
 *
 * The compression pipeline takes a (sanitized) ChatCompletionRequest and
 * returns a smaller equivalent request plus a CompressionStats record that
 * is attached to request_logs.compression_stats for telemetry.
 *
 * Pipeline order is intentional:
 *   1. DCP          — lossless dedup (cheapest savings, must run first so
 *                     subsequent steps don't compress already-removable text)
 *   2. RTK          — lossy tool-result truncation
 *   3. Caveman      — lossy system-prompt compaction (off by default)
 *   4. Image dedupe — lossless image block dedup
 *   5. Cache markers — final pass: insert cache_control on stable prefix
 */

export type CavemanLevel = "lite" | "full" | "ultra";

export interface RTKConfig {
  enabled: boolean;
  /** Cap (in chars) per tool_result block in older turns. */
  maxToolChars: number;
  /** How many trailing turns to leave fully untouched. */
  keepLastNTurnsFull: number;
  /** When true, recognise common command shapes (git diff, tree, ls -R, …). */
  smartTruncate: boolean;
}

export interface DCPConfig {
  enabled: boolean;
  /** Tool names whose outputs are safe to dedup (idempotent / read-only). */
  whitelist: string[];
}

export interface CavemanConfig {
  enabled: boolean;
  level: CavemanLevel;
}

export interface CacheMarkerConfig {
  enabled: boolean;
  /** Per-provider override, e.g. { codex: false } skips cache markers for codex. */
  providerOverrides: Record<string, boolean>;
}

export interface ImageDedupeConfig {
  enabled: boolean;
}

export interface TSCConfig {
  enabled: boolean;
  /** Strip whitespace from tool JSON-schema (lossless). */
  stripSchemaWhitespace: boolean;
  /** Trim repeated whitespace from tool descriptions (>= 2 spaces / blank lines). */
  trimDescriptions: boolean;
  /**
   * Drop $schema, $id, additionalProperties:false noise from tool input_schema.
   * Lossless w.r.t. tool semantics (model never reads these fields).
   */
  dropSchemaMeta: boolean;
}

export interface CompressionConfig {
  rtk: RTKConfig;
  dcp: DCPConfig;
  caveman: CavemanConfig;
  cacheMarkers: CacheMarkerConfig;
  imageDedupe: ImageDedupeConfig;
  tsc: TSCConfig;
}

export type CompressionTechnique =
  | "rtk"
  | "dcp"
  | "caveman"
  | "imageDedupe"
  | "cacheMarkers"
  | "tsc";

export interface CompressionStats {
  /** Estimated tokens before compression. */
  tokensBefore: number;
  /** Estimated tokens after compression. */
  tokensAfter: number;
  /** tokensBefore - tokensAfter (>= 0). */
  saved: number;
  /** Percentage saved, 0-100, rounded to 2 decimals. */
  savedPct: number;
  /** Per-technique tokens saved (only includes techniques that ran). */
  byTechnique: Partial<Record<CompressionTechnique, number>>;
  /**
   * Per-shape-filter savings inside RTK (e.g. "git-diff", "dedup-log",
   * "read-numbered", "generic"). Aggregated across all tool_result blocks
   * touched in this request.
   */
  rtkFilters?: Record<string, number>;
  /** Wall-clock duration of the pipeline in ms. */
  durationMs: number;
}

export const DEFAULT_DCP_WHITELIST = ["Read", "Glob", "Grep", "LS", "WebFetch"];

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  rtk: {
    // RTK on by default. Old tool results are the dominant cost in long
    // agentic sessions (hundreds of tool_result messages replayed every turn).
    // Truncating them is what keeps prompts small enough that reasoning models
    // (GLM-5.2 etc.) actually have output budget left to think. The last
    // `keepLastNTurnsFull` turns stay fully intact so active tool calls are
    // never touched.
    enabled: true,
    // Aggressive cap for OLD tool results. In long agentic sessions there are
    // hundreds of tool_result messages; the median is ~240 chars but the long
    // tail (p75 ~1.5K, p90 ~4K, max ~34K) dominates. A 300-char cap keeps the
    // gist (path, status, short result, error summary) while cutting the bulk
    // — for a 313-result session this takes tool results from ~116K tokens down
    // to ~13K, which is the difference between a reasoning model having output
    // budget left to think vs. silently skipping reasoning. The smart shape
    // filters (diff hunks, grep groupings, etc.) still run first within the cap,
    // and the last `keepLastNTurnsFull` turns stay fully intact.
    maxToolChars: 300,
    keepLastNTurnsFull: 2,
    smartTruncate: true,
  },
  dcp: {
    enabled: false,
    whitelist: [...DEFAULT_DCP_WHITELIST],
  },
  caveman: {
    enabled: false,
    level: "lite",
  },
  cacheMarkers: {
    enabled: false,
    providerOverrides: { codex: false },
  },
  imageDedupe: {
    enabled: false,
  },
  tsc: {
    enabled: false,
    stripSchemaWhitespace: true,
    trimDescriptions: true,
    dropSchemaMeta: true,
  },
};

/** Empty stats — used when compression is fully disabled or as initial value. */
export function emptyStats(): CompressionStats {
  return {
    tokensBefore: 0,
    tokensAfter: 0,
    saved: 0,
    savedPct: 0,
    byTechnique: {},
    durationMs: 0,
  };
}
