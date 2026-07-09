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

export interface PonytailConfig {
  enabled: boolean;
}

// --- F11: output-reducing prompt injections + Headroom LLM compression ---

export type CavemanInjectionLevel = "lite" | "full" | "ultra" | "wenyan-lite" | "wenyan" | "wenyan-ultra";
export type PonytailInjectionLevel = "lite" | "full" | "ultra";

export interface CavemanInjectionConfig {
  enabled: boolean;
  level: CavemanInjectionLevel;
}

export interface PonytailInjectionConfig {
  enabled: boolean;
  level: PonytailInjectionLevel;
}

export interface HeadroomConfig {
  enabled: boolean;
  /** URL of the headroom-ai compression proxy (default http://localhost:8787). */
  url: string;
  /** Compress user/assistant free-form messages, not just tool output. */
  compressUserMessages: boolean;
  /** Per-request timeout (ms). */
  timeoutMs: number;
}

export interface CompressionConfig {
  rtk: RTKConfig;
  dcp: DCPConfig;
  caveman: CavemanConfig;
  cacheMarkers: CacheMarkerConfig;
  imageDedupe: ImageDedupeConfig;
  tsc: TSCConfig;
  ponytail: PonytailConfig;
  /** F11: output-reducing caveman prompt injection (distinct from input-side caveman). */
  cavemanInjection: CavemanInjectionConfig;
  /** F11: output-reducing ponytail (YAGNI-ladder) prompt injection. */
  ponytailInjection: PonytailInjectionConfig;
  /** F11: LLM-based whole-message compression via an external headroom-ai proxy. */
  headroom: HeadroomConfig;
}

export type CompressionTechnique =
  | "rtk"
  | "dcp"
  | "caveman"
  | "imageDedupe"
  | "cacheMarkers"
  | "tsc"
  | "ponytail"
  | "cavemanInjection"
  | "ponytailInjection"
  | "headroom";

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
    // 500-char cap for OLD tool results. In long agentic sessions there are
    // hundreds of tool_result messages; the median is ~240 chars but the long
    // tail (p75 ~1.5K, p90 ~4K, max ~34K) dominates. A 500-char cap keeps the
    // gist (path, status, short result, error summary) while cutting the bulk.
    //
    // Note on the chars/token ratio: the proxy estimates tokens at chars/4, but
    // GLM/DeepSeek tokenizers are denser (~2.5 chars/token for code/markdown).
    // So a prompt the estimator calls "127K tokens" is really ~200K GLM tokens.
    // The cap must be aggressive enough that the REAL (GLM-counted) prompt
    // leaves room for reasoning. 500 + TSC gets a typical long session from
    // ~200K GLM tokens down toward ~150K; shorter sessions land in the
    // reasoning zone (~60-90K). The smart shape filters (diff hunks, grep
    // groupings, etc.) still run first within the cap, and the last
    // `keepLastNTurnsFull` turns stay fully intact.
    maxToolChars: 500,
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
    // TSC (Tool Schema Compaction) is LOSSLESS: it only strips whitespace and
    // JSON-schema metadata ($schema, title, examples, descriptions of unused
    // params) from the tools DEFINITION. It never touches tool_call arguments
    // or tool_result content, so it cannot break tool execution the way the
    // (now-removed) word-rewrite filter did. Long agentic sessions carry a
    // huge tools array every turn (100K+ chars for a 64-tool Codex/Claude Code
    // session); TSC reclaims 5-25% of that with zero semantic loss.
    enabled: true,
    stripSchemaWhitespace: true,
    trimDescriptions: true,
    dropSchemaMeta: true,
  },
  ponytail: {
    // Ponytail targets repetitive structure in tool results — repeated directory
    // prefixes, collapsed log spam, normalized line endings. OFF by default
    // because it is lossy (though low-risk: it never removes semantic content,
    // only the verbose scaffolding around it). Enable per-provider via settings.
    enabled: false,
  },
  // F11: output-reducing prompt injections. OFF by default — they change model
  // behavior (terser output / less code), which is a user opt-in. When enabled,
  // they APPEND to the system prompt (cache-aware) so the model emits fewer
  // OUTPUT tokens. Distinct from the input-side caveman/ponytail above.
  cavemanInjection: {
    enabled: false,
    level: "full",
  },
  ponytailInjection: {
    enabled: false,
    level: "full",
  },
  // F11: Headroom LLM whole-message compression. OFF by default — requires an
  // external headroom-ai proxy running at `url`. When enabled + reachable, it
  // compresses the conversation via Claude→OpenAI→compress→Claude round-trip.
  headroom: {
    enabled: false,
    url: "http://localhost:8787",
    compressUserMessages: false,
    timeoutMs: 3000,
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
