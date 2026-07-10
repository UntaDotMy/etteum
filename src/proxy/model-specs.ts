/**
 * Canonical model-spec registry.
 *
 * A model's context window and max output are properties of the MODEL, not
 * the provider — `glm-5.2` is `glm-5.2` whether it's served by Alibaba
 * DashScope, Kiro, Qoder, or anyone else. This single registry is the source
 * of truth; every provider resolves from it so specs stay consistent across
 * the whole pool.
 *
 * Values are verified against official provider docs (DashScope, DeepSeek,
 * Moonshot, OpenAI, Google, Anthropic) as of 2026-06. When a provider exposes
 * a model under a different id, it still resolves here by canonical name.
 *
 * Key = the upstream / canonical model name (no provider prefix, no -thinking
 * suffix). The `-thinking` variant of a model shares the same context/max
 * output as its base — only `thinking: true` differs, which the provider sets.
 */

export interface ModelSpec {
  contextWindow: number;
  maxOutput: number;
  /** Default thinking support for the base model (a -thinking variant is true). */
  thinking?: boolean;
  vision?: boolean;
}

/**
 * Verified token/context specs, keyed by canonical model name.
 * Numbers in tokens. Sources: see comments per family.
 */
export const MODEL_SPECS: Record<string, ModelSpec> = {
  // ── Qwen (Alibaba DashScope) — help.aliyun.com/zh/model-studio/text-generation-model ──
  "qwen3.7-max":            { contextWindow: 1_000_000, maxOutput: 65_536, thinking: true,  vision: true },
  "qwen3.7-max-preview":    { contextWindow: 1_000_000, maxOutput: 65_536, thinking: true,  vision: true },
  "qwen3.7-plus":           { contextWindow: 1_000_000, maxOutput: 65_536, thinking: true,  vision: true },
  "qwen3.6-plus":           { contextWindow: 1_000_000, maxOutput: 65_536, thinking: false, vision: true },
  "qwen3.5-plus":           { contextWindow: 1_000_000, maxOutput: 65_536, thinking: false, vision: true },
  "qwen3.5-flash":          { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: true },
  "qwen3.6-flash":          { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: true },
  "qwen3-max":              { contextWindow: 256_000,   maxOutput: 65_536, thinking: true,  vision: true },
  "qwen3-max-preview":      { contextWindow: 256_000,   maxOutput: 65_536, thinking: true,  vision: true },
  "qwen3-coder-plus":       { contextWindow: 1_000_000, maxOutput: 65_536, thinking: true,  vision: false },
  "qwen3-coder-next":       { contextWindow: 256_000,   maxOutput: 65_536, thinking: false, vision: false },
  "qwen3-coder-flash":      { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: false },
  "qwen3-vl-plus":          { contextWindow: 1_000_000, maxOutput: 65_536, thinking: false, vision: true },
  "qwen3-vl-flash":         { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: true },
  "qwen-plus":              { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: true },
  "qwen-plus-latest":       { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: true },
  "qwen-max":               { contextWindow: 32_000,    maxOutput: 8_192,  thinking: false, vision: true },
  "qwen-turbo":             { contextWindow: 128_000,   maxOutput: 8_192,  thinking: false, vision: false },
  "qwen-flash":             { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: false },
  "qwen-vl-max":            { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: true },
  "qwen-vl-plus":           { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: true },
  "qwq-plus":               { contextWindow: 128_000,   maxOutput: 16_384, thinking: true,  vision: false },
  "qvq-max":                { contextWindow: 128_000,   maxOutput: 8_192,  thinking: true,  vision: true },
  "qwen-coder-plus":        { contextWindow: 1_000_000, maxOutput: 8_192,  thinking: false, vision: false },

  // ── DeepSeek — api-docs.deepseek.com + DashScope ──
  "deepseek-v4-flash":      { contextWindow: 1_000_000, maxOutput: 384_000, thinking: true,  vision: false },
  "deepseek-v4-pro":        { contextWindow: 1_000_000, maxOutput: 384_000, thinking: true,  vision: false },
  "deepseek-v3.2":          { contextWindow: 128_000,   maxOutput: 8_192,   thinking: false, vision: false },
  "deepseek-3.2":           { contextWindow: 164_000,   maxOutput: 8_192,   thinking: false, vision: false },
  // DeepSeek F13 API aliases — deepseek-chat = v4-flash (non-thinking),
  // deepseek-reasoner = v4-flash thinking mode. Verified api-docs.deepseek.com.
  "deepseek-chat":          { contextWindow: 1_000_000, maxOutput: 8_192,   thinking: false, vision: false },
  "deepseek-reasoner":      { contextWindow: 1_000_000, maxOutput: 384_000, thinking: true,  vision: false },
  "deepseek-coder":         { contextWindow: 128_000,   maxOutput: 8_192,   thinking: false, vision: false },

  // ── GLM (Zhipu) — docs.z.ai + DashScope ──
  "glm-5.2":                { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "glm-5.1":                { contextWindow: 198_000,   maxOutput: 8_192,   thinking: true,  vision: true },
  "glm-5":                  { contextWindow: 200_000,   maxOutput: 8_192,   thinking: false, vision: false },

  // ── Kimi (Moonshot) — platform.kimi.ai + DashScope ──
  "kimi-k2.7-code":         { contextWindow: 262_144,   maxOutput: 98_304,  thinking: false, vision: false },
  "kimi-k2.6":              { contextWindow: 262_144,   maxOutput: 65_536,  thinking: false, vision: true },

  // ── MiniMax — platform.minimaxi.com (M3 is current flagship, June 2026) ──
  "minimax-m3":             { contextWindow: 1_000_000, maxOutput: 65_536,  thinking: true,  vision: true },
  "minimax-m2.7":           { contextWindow: 1_000_000, maxOutput: 65_536,  thinking: false, vision: true },
  "minimax-m2.5":           { contextWindow: 196_000,   maxOutput: 65_536,  thinking: false, vision: false },
  "minimax-m2.1":           { contextWindow: 196_000,   maxOutput: 65_536,  thinking: false, vision: false },

  // ── Claude (Anthropic) — docs.claude.com / platform.claude.com ──
  "claude-fable-5":         { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "claude-mythos-5":        { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "claude-sonnet-5":        { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "claude-opus-4.8":        { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "claude-opus-4.7":        { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "claude-opus-4.6":        { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "claude-opus-4.5":        { contextWindow: 200_000,   maxOutput: 65_536,  thinking: true,  vision: true },
  "claude-sonnet-4.6":      { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "claude-sonnet-4.5":      { contextWindow: 200_000,   maxOutput: 65_536,  thinking: true,  vision: true },
  "claude-sonnet-4":        { contextWindow: 200_000,   maxOutput: 65_536,  thinking: true,  vision: true },
  "claude-haiku-4.5":       { contextWindow: 200_000,   maxOutput: 65_536,  thinking: true,  vision: true },

  // ── OpenAI GPT — developers.openai.com ──
  "gpt-5.6-sol":            { contextWindow: 1_050_000, maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.6-terra":          { contextWindow: 1_050_000, maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.6-luna":           { contextWindow: 1_050_000, maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.5-pro":            { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.5":                { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.4-pro":            { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.4":                { contextWindow: 1_000_000, maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.4-mini":           { contextWindow: 400_000,   maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.4-nano":           { contextWindow: 400_000,   maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.3":                { contextWindow: 400_000,   maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-5.2":                { contextWindow: 400_000,   maxOutput: 131_072, thinking: true,  vision: true },
  "gpt-4o":                 { contextWindow: 128_000,   maxOutput: 16_384,  thinking: false, vision: true },

  // ── Google Gemini — ai.google.dev ──
  "gemini-2.5-pro":         { contextWindow: 1_048_576, maxOutput: 65_536,  thinking: true,  vision: true },
  "gemini-2.5-flash":       { contextWindow: 1_048_576, maxOutput: 65_536,  thinking: true,  vision: true },
  // Gemini 3 — served via Antigravity (Cloud Code Assist). Context/output per
  // Google's Gemini 3 docs; verified model slugs via Antigravity fetchAvailableModels.
  "gemini-3-pro":           { contextWindow: 1_048_576, maxOutput: 65_536,  thinking: true,  vision: true },
  "gemini-3-pro-high":      { contextWindow: 1_048_576, maxOutput: 65_536,  thinking: true,  vision: true },
  "gemini-3-flash":         { contextWindow: 1_048_576, maxOutput: 65_536,  thinking: true,  vision: true },
  "gemini-3.1-pro":         { contextWindow: 2_000_000, maxOutput: 65_536,  thinking: true,  vision: true },
  "gemini-3.5-flash":       { contextWindow: 1_048_576, maxOutput: 65_536,  thinking: true,  vision: true },
  "gemini-2.5-flash-lite":  { contextWindow: 1_048_576, maxOutput: 65_536,  thinking: true,  vision: true },

  // ── xAI Grok — docs.x.ai (latest: grok-4.5, grok-4.3) ──
  "grok-4.5":               { contextWindow: 500_000,   maxOutput: 65_536,  thinking: true,  vision: true },
  "grok-4.3":               { contextWindow: 1_000_000, maxOutput: 65_536,  thinking: true,  vision: true },
  "grok-build-0.1":         { contextWindow: 256_000,   maxOutput: 65_536,  thinking: false, vision: false },

  // ── OpenAI legacy / F13 catalog — developers.openai.com ──
  "gpt-4o-mini":            { contextWindow: 128_000,   maxOutput: 16_384,  thinking: false, vision: true },
  "gpt-4-turbo":            { contextWindow: 128_000,   maxOutput: 4_096,   thinking: false, vision: true },
  "gpt-4":                  { contextWindow: 8_192,     maxOutput: 4_096,   thinking: false, vision: false },
  "gpt-3.5-turbo":          { contextWindow: 16_384,    maxOutput: 4_096,   thinking: false, vision: false },
  "o1":                     { contextWindow: 200_000,   maxOutput: 100_000, thinking: true,  vision: false },
  "o1-mini":                { contextWindow: 128_000,   maxOutput: 65_536,  thinking: true,  vision: false },
  "o3-mini":                { contextWindow: 200_000,   maxOutput: 100_000, thinking: true,  vision: false },

  // ── Mistral — docs.mistral.ai (Large 3 / Small 4 / Codestral) ──
  "mistral-large-latest":   { contextWindow: 256_000,   maxOutput: 8_192,   thinking: false, vision: true },
  "mistral-small-latest":   { contextWindow: 256_000,   maxOutput: 8_192,   thinking: true,  vision: true },
  "codestral-latest":       { contextWindow: 128_000,   maxOutput: 8_192,   thinking: false, vision: false },

  // ── Groq-hosted open models — groq.com/pricing ──
  "llama-3.3-70b-versatile":  { contextWindow: 128_000, maxOutput: 32_768,  thinking: false, vision: false },
  "llama-3.1-70b-versatile":  { contextWindow: 128_000, maxOutput: 32_768,  thinking: false, vision: false },
  "mixtral-8x7b-32768":       { contextWindow: 32_768,  maxOutput: 32_768,  thinking: false, vision: false },

  // ── xAI Grok — docs.x.ai (grok-2 legacy; current is grok-4.x) ──
  "grok-2":                 { contextWindow: 131_072,   maxOutput: 8_192,   thinking: false, vision: false },
  "grok-2-latest":          { contextWindow: 131_072,   maxOutput: 8_192,   thinking: false, vision: false },
  "grok-beta":              { contextWindow: 131_072,   maxOutput: 8_192,   thinking: false, vision: false },

  // ── Cohere — docs.cohere.com ──
  "command-r-plus":         { contextWindow: 128_000,   maxOutput: 4_096,   thinking: false, vision: false },
  "command-r":              { contextWindow: 128_000,   maxOutput: 4_096,   thinking: false, vision: false },
  "command-r7b":            { contextWindow: 128_000,   maxOutput: 4_096,   thinking: false, vision: false },
};

/**
 * Resolve the canonical spec for a model. Accepts the upstream/canonical
 * name (e.g. "glm-5.2") or a `-thinking` variant (e.g. "claude-opus-4.8-thinking").
 * Returns undefined if the model isn't in the registry (caller keeps its own
 * fallback). `thinking` is forced true for `-thinking` variants regardless of
 * the base spec.
 */
export function resolveModelSpec(canonicalName: string | undefined): ModelSpec | undefined {
  if (!canonicalName) return undefined;
  // Strip a trailing -thinking variant flag.
  const noThinking = canonicalName.replace(/-thinking$/, "");
  const isThinkingVariant = canonicalName !== noThinking;
  // Direct hit.
  let spec = MODEL_SPECS[noThinking];
  // Fallback: strip a trailing date snapshot suffix (-YYYY-MM-DD or -YYYY-MM-DD-<tag>)
  // so dated variants (qwen3.7-max-2026-06-08) inherit their base model's spec.
  if (!spec) {
    const dateless = noThinking.replace(/-\d{4}-\d{2}-\d{2}.*$/, "");
    if (dateless !== noThinking) spec = MODEL_SPECS[dateless];
  }
  if (!spec) return undefined;
  return {
    contextWindow: spec.contextWindow,
    maxOutput: spec.maxOutput,
    thinking: isThinkingVariant ? true : spec.thinking,
    vision: spec.vision,
  };
}

import type { ModelInfo } from "./providers/base";

/**
 * Apply the canonical registry to a provider's model list. For each model,
 * `toCanonical` derives the canonical/upstream name (e.g. stripping a `qd-`
 * prefix or mapping `kp-opus-4.8` → `claude-opus-4.8`); the resolved
 * context_window/max_output/thinking/vision override the provider's hardcoded
 * values. Models not in the registry keep their original spec.
 *
 * This makes specs a property of the model, not the provider: a `glm-5.2`
 * served by Alibaba, Kiro, or Qoder all resolves to the same verified spec.
 */
export function applyModelSpecs(
  models: ModelInfo[],
  toCanonical: (m: ModelInfo) => string | undefined,
): ModelInfo[] {
  return models.map((m) => {
    const spec = resolveModelSpec(toCanonical(m));
    if (!spec) return m;
    return {
      ...m,
      context_window: spec.contextWindow,
      max_output: spec.maxOutput,
      thinking: spec.thinking ?? m.thinking,
      vision: spec.vision ?? m.vision,
    };
  });
}
