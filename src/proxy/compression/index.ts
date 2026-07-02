/**
 * Compression orchestrator.
 *
 * Public API:
 *   compressRequest(req, cfg, providerName?) -> { request, stats }
 *
 * The pipeline is deliberately ordered:
 *   1. DCP          — lossless (cheapest savings, must run first so RTK
 *                     doesn't waste effort truncating soon-to-be-stubbed blocks)
 *   2. RTK          — lossy tool-result truncation
 *   3. Caveman      — lossy system-prompt compaction (off by default)
 *   4. Image dedupe — lossless image dedup
 *   5. Cache markers — structural; must run LAST because it tags the final
 *                      prefix shape that upstream providers will hash for caching
 */

import type { ChatCompletionRequest } from "../providers/base";
import type { CompressionConfig, CompressionStats, CompressionTechnique } from "./types";
import { applyRTK } from "./rtk";
import { applyDCP } from "./dcp";
import { applyCaveman } from "./caveman";
import { applyCacheMarkers } from "./cache-markers";
import { applyImageDedupe } from "./image-dedupe";
import { applyTSC } from "./tsc";
import { estimateRequestTokens } from "./token-estimate";

export type { CompressionConfig, CompressionStats, CompressionTechnique } from "./types";
export { DEFAULT_COMPRESSION_CONFIG, DEFAULT_DCP_WHITELIST, emptyStats } from "./types";
export { estimateRequestTokens, estimateTokensFromString } from "./token-estimate";
export {
  getCompressionConfig,
  getCachedCompressionConfig,
  invalidateCompressionCache,
  isCompressionSettingKey,
} from "./settings";

const CHARS_PER_TOKEN = 4;

function charsToTokens(c: number): number {
  return Math.ceil(c / CHARS_PER_TOKEN);
}

export interface CompressResult {
  request: ChatCompletionRequest;
  stats: CompressionStats;
}

export function compressRequest(
  request: ChatCompletionRequest,
  cfg: CompressionConfig,
  providerName?: string
): CompressResult {
  const t0 = Date.now();
  const tokensBefore = estimateRequestTokens(request);

  const byTechnique: Partial<Record<CompressionTechnique, number>> = {};
  let current = request;

  // 0. TSC — lossless tool-schema compaction. Runs first because it's cheap,
  //    provider-agnostic, and never interacts with messages/system.
  if (cfg.tsc?.enabled) {
    const r = applyTSC(current, cfg.tsc);
    if (r.saved > 0) byTechnique.tsc = charsToTokens(r.saved);
    current = r.request;
  }

  // 1. DCP
  if (cfg.dcp.enabled) {
    const r = applyDCP(current, cfg.dcp);
    if (r.saved > 0) byTechnique.dcp = charsToTokens(r.saved);
    current = r.request;
  }

  // 2. RTK
  let rtkFilters: Record<string, number> | undefined;
  if (cfg.rtk.enabled) {
    const r = applyRTK(current, cfg.rtk);
    if (r.saved > 0) byTechnique.rtk = charsToTokens(r.saved);
    if (r.hits.length > 0) {
      rtkFilters = {};
      for (const h of r.hits) {
        rtkFilters[h.filter] = (rtkFilters[h.filter] ?? 0) + charsToTokens(h.saved);
      }
    }
    current = r.request;
  }

  // 3. Caveman
  if (cfg.caveman.enabled) {
    const r = applyCaveman(current, cfg.caveman);
    if (r.saved > 0) byTechnique.caveman = charsToTokens(r.saved);
    current = r.request;
  }

  // 4. Image dedupe
  if (cfg.imageDedupe.enabled) {
    const r = applyImageDedupe(current, cfg.imageDedupe);
    if (r.saved > 0) byTechnique.imageDedupe = charsToTokens(r.saved);
    current = r.request;
  }

  // 5. Cache markers (structural only — saved=0)
  if (cfg.cacheMarkers.enabled) {
    const r = applyCacheMarkers(current, cfg.cacheMarkers, providerName);
    current = r.request;
  }

  const tokensAfter = estimateRequestTokens(current);
  const saved = Math.max(0, tokensBefore - tokensAfter);
  const savedPct = tokensBefore > 0 ? Math.round((saved / tokensBefore) * 10000) / 100 : 0;

  return {
    request: current,
    stats: {
      tokensBefore,
      tokensAfter,
      saved,
      savedPct,
      byTechnique,
      ...(rtkFilters ? { rtkFilters } : {}),
      durationMs: Date.now() - t0,
    },
  };
}
