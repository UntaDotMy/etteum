/**
 * Cache Markers — Anthropic prompt caching helper.
 *
 * Inserts `cache_control: { type: "ephemeral" }` on the LAST stable element
 * of the prompt prefix (system OR tools OR last assistant message) so the
 * upstream provider can cache that prefix and we pay 90% less on cached
 * input tokens.
 *
 * This module is purely structural: it never touches text content. It bails
 * out (and emits 0 savings) if the prefix is non-deterministic — see
 * `looksUnstable()`.
 *
 * Note: estimated savings reported here are SPECULATIVE — actual savings
 * arrive from the provider's `usage.cache_read_input_tokens` field. We
 * report 0 from this stage so dashboard numbers stay honest; the cache hit
 * rate will show up in upstream usage.
 */

import type { ChatCompletionRequest } from "../providers/base";
import type { CacheMarkerConfig } from "./types";

const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function looksUnstable(text: string | undefined | null): boolean {
  if (!text) return false;
  return TIMESTAMP_RE.test(text) || UUID_RE.test(text);
}

function tagBlockEphemeral(block: any): any {
  if (!block || typeof block !== "object") return block;
  if (block.cache_control) return block; // already tagged
  return { ...block, cache_control: { type: "ephemeral" } };
}

/**
 * @param providerName provider routing name (e.g. "codebuddy", "kiro", "codex").
 *                     If providerOverrides[providerName] === false, we no-op.
 */
export function applyCacheMarkers(
  request: ChatCompletionRequest,
  cfg: CacheMarkerConfig,
  providerName?: string
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };
  if (providerName && cfg.providerOverrides[providerName] === false) {
    return { request, saved: 0 };
  }

  const next: any = { ...request };

  // Try system prompt first — biggest stable block.
  const sys = (next as any).system;
  let tagged = false;

  if (typeof sys === "string" && sys.length > 1024 && !looksUnstable(sys)) {
    // Convert to block form so we can attach cache_control.
    next.system = [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }];
    tagged = true;
  } else if (Array.isArray(sys) && sys.length > 0) {
    // Tag the last text block.
    let lastTextIdx = -1;
    for (let i = sys.length - 1; i >= 0; i--) {
      const b = sys[i];
      if (b?.type === "text" && typeof b.text === "string" && !looksUnstable(b.text)) {
        lastTextIdx = i;
        break;
      }
    }
    if (lastTextIdx >= 0) {
      next.system = sys.map((b: any, i: number) => (i === lastTextIdx ? tagBlockEphemeral(b) : b));
      tagged = true;
    }
  }

  // Tools as cache anchor — Anthropic spec: cache_control on the LAST tool tags
  // the entire `tools` array prefix. So we always try to tag tools too (in addition
  // to system), because the Anthropic cache breakpoint logic treats the prefix
  // up-to-and-including the marker as one cacheable chunk.
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    const last = next.tools[next.tools.length - 1];
    const stableJson = JSON.stringify(last || {});
    if (!looksUnstable(stableJson)) {
      // Skip if the tool already has cache_control or is OpenAI-flavor
      // wrapped in {type:"function", function:{...}} — for OpenAI shape, upstream
      // (Codebuddy/Codex) translate to Anthropic at their edge, but cache_control
      // belongs at the Anthropic-shape level. Tag the outer object — providers
      // that don't care will silently ignore.
      const lastObj = last as any;
      if (!lastObj?.cache_control) {
        next.tools = [...next.tools.slice(0, -1), tagBlockEphemeral(last)];
        tagged = true;
      }
    }
  }

  return { request: tagged ? next : request, saved: 0 };
}
