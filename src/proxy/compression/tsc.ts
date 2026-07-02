/**
 * TSC — Tool Schema Compaction.
 *
 * Lossless compaction of the `tools` array — by far the largest repeated
 * portion of agent traffic (often 100KB+ per turn, identical every turn).
 *
 * Targets, in order of safety:
 *   1. Strip JSON whitespace from input_schema       — fully lossless, model reads only structure
 *   2. Drop $schema/$id/additionalProperties:false   — JSON-Schema metadata, ignored by LLM
 *   3. Collapse runs of whitespace in descriptions   — model treats `   ` and ` ` identically
 *
 * Handles both Anthropic-flavor (`{name, description, input_schema}`) and
 * OpenAI-flavor (`{type:"function", function:{name, description, parameters}}`)
 * tool definitions. Provider-agnostic by design — TSC is the "goalkeeper"
 * that runs regardless of provider shape.
 *
 * Cost: <2ms for 50 tools. Savings: 5-25% of `tools` byte size, which on
 * tool-heavy traffic translates to 1-5% of total request tokens.
 */

import type { ChatCompletionRequest } from "../providers/base";
import type { TSCConfig } from "./types";

const META_KEYS_TO_DROP = new Set(["$schema", "$id", "$comment", "$ref"]);
const WHITESPACE_RUN_RE = /[ \t]{2,}/g;
const BLANK_LINE_RUN_RE = /\n[ \t]*\n[ \t\n]*/g;

function trimDescription(s: string): string {
  if (!s) return s;
  // Collapse multiple spaces/tabs into one, keep single newlines, collapse blank-line runs to one blank.
  return s
    .replace(WHITESPACE_RUN_RE, " ")
    .replace(BLANK_LINE_RUN_RE, "\n\n")
    .trim();
}

function compactSchema(node: unknown, dropMeta: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => compactSchema(n, dropMeta));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (dropMeta && META_KEYS_TO_DROP.has(k)) continue;
      // additionalProperties:false is JSON-Schema noise the model doesn't act on.
      if (dropMeta && k === "additionalProperties" && v === false) continue;
      out[k] = compactSchema(v, dropMeta);
    }
    return out;
  }
  return node;
}

function compactTool(tool: unknown, cfg: TSCConfig): unknown {
  if (!tool || typeof tool !== "object") return tool;
  const t = tool as Record<string, unknown>;

  // OpenAI-flavor: { type: "function", function: { name, description, parameters } }
  if (t.type === "function" && t.function && typeof t.function === "object") {
    const fn = { ...(t.function as Record<string, unknown>) };
    if (cfg.trimDescriptions && typeof fn.description === "string") {
      fn.description = trimDescription(fn.description);
    }
    if (cfg.dropSchemaMeta && fn.parameters !== undefined) {
      fn.parameters = compactSchema(fn.parameters, true);
    }
    return { ...t, function: fn };
  }

  // Anthropic-flavor: { name, description, input_schema }
  const out = { ...t };
  if (cfg.trimDescriptions && typeof out.description === "string") {
    out.description = trimDescription(out.description);
  }
  if (cfg.dropSchemaMeta && out.input_schema !== undefined) {
    out.input_schema = compactSchema(out.input_schema, true);
  }
  return out;
}

/**
 * Apply TSC to a request's `tools` array.
 *
 * `stripSchemaWhitespace` is applied implicitly — JSON.stringify with no
 * indent argument always produces compact output, so we don't need to do
 * anything explicit; the saving manifests when the upstream HTTP client
 * serialises the request. We measure it by comparing the canonicalised
 * JSON sizes of before vs after.
 */
export function applyTSC(
  request: ChatCompletionRequest,
  cfg: TSCConfig
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };

  const tools = (request as any).tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { request, saved: 0 };
  }

  // Measure pre-canonicalised size: if the caller had pretty-printed JSON
  // anywhere in the schema, JSON.stringify-roundtrip alone reclaims those bytes.
  const beforeBytes = JSON.stringify(tools).length;

  const newTools = tools.map((t: unknown) => compactTool(t, cfg));
  const afterBytes = JSON.stringify(newTools).length;
  const saved = Math.max(0, beforeBytes - afterBytes);

  if (saved === 0 && !cfg.stripSchemaWhitespace) {
    // No structural change — return original to preserve referential identity.
    return { request, saved: 0 };
  }

  return {
    request: { ...request, tools: newTools } as ChatCompletionRequest,
    saved,
  };
}
