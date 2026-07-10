/**
 * Per-model USD pricing + cost calculation (F6 — wires the previously-dead
 * `request_logs.cost` / `usage_summary.total_cost` columns).
 *
 * Ported from the reference proxy's `open-sse/providers/pricing.js` (MODEL_PRICING) +
 * `src/lib/db/repos/{pricingRepo,usageRepo}.js` (getPricingForModel /
 * calculateCost), adapted to our Hono/TS + drizzle stack and our existing
 * model-keyed `kv(pricing)` storage.
 *
 * Pricing rates are $/1M tokens. Fallback order (first match wins):
 *   1. User override — `kv(pricing)[model]` (dashboard-configured; 3 legacy
 *      fields inputPer1M/outputPer1M/cachedInputPer1M + 2 new fields
 *      reasoningPer1M/cacheCreationPer1M). Existing 3-field entries are
 *      preserved — the new fields default to sensible fallbacks when absent.
 *   2. Baseline constant — `MODEL_PRICING[model]` below (5 fields).
 *   3. None → cost 0 (unknown model; never crashes the recording path).
 *
 * No data deletion: the user KV shape is ADDITIVE — we read the 3 legacy
 * fields and fall back to baseline for the 2 we don't store yet.
 */
import { db } from "../db/index";
import { kv } from "../db/schema";
import { eq } from "drizzle-orm";

/** All rates in $/1M tokens. `cached` = cache-read, `cache_creation` = write. */
export interface ModelPricing {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  cacheCreation: number;
}

/**
 * Canonical baseline model pricing — provider-agnostic, model-keyed.
 * Ported from the reference proxy `open-sse/providers/pricing.js` MODEL_PRICING.
 * Covers the models reachable through our provider pool (Claude via
 * kiro/gitlab-duo, GPT-5 via codex/codebuddy, Gemini via antigravity, etc.).
 * Keep this curated; unknown models simply cost 0 until priced.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // === Anthropic / Claude ===
  "claude-opus-4-6":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4-5-20251101":     { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-sonnet-4-6":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-sonnet-4-5-20250929":   { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-haiku-4-5-20251001":    { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cacheCreation: 1.25  },
  "claude-sonnet-4-20250514":     { input: 3.00,  output: 15.00, cached: 1.50,  reasoning: 15.00,  cacheCreation: 3.00  },
  "claude-opus-4-20250514":       { input: 15.00, output: 25.00, cached: 7.50,  reasoning: 112.50, cacheCreation: 15.00 },
  "claude-3-5-sonnet-20241022":   { input: 3.00,  output: 15.00, cached: 1.50,  reasoning: 15.00,  cacheCreation: 3.00  },
  "claude-sonnet-4":              { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 22.50,  cacheCreation: 3.00  },
  "claude-sonnet-4.5":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 22.50,  cacheCreation: 3.00  },
  "claude-sonnet-4.6":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 22.50,  cacheCreation: 3.00  },
  "claude-opus-4.5":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cacheCreation: 5.00  },
  "claude-opus-4.6":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cacheCreation: 5.00  },
  "claude-opus-4.7":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cacheCreation: 5.00  },
  "claude-opus-4.8":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cacheCreation: 5.00  },
  "claude-sonnet-5":              { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 22.50,  cacheCreation: 3.00  },
  "claude-fable-5":               { input: 10.00, output: 50.00, cached: 1.00,  reasoning: 75.00,  cacheCreation: 12.50 },
  "claude-mythos-5":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cacheCreation: 5.00  },
  "claude-haiku-4.5":             { input: 0.50,  output: 2.50,  cached: 0.05,  reasoning: 3.75,   cacheCreation: 0.50  },

  // === OpenAI / GPT (codex / codebuddy upstreams) ===
  "gpt-5":                        { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cacheCreation: 3.00  },
  "gpt-5-mini":                   { input: 0.75,  output: 3.00,  cached: 0.375, reasoning: 4.50,   cacheCreation: 0.75  },
  "gpt-5-codex":                  { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cacheCreation: 3.00  },
  "gpt-5.1":                      { input: 4.00,  output: 16.00, cached: 2.00,  reasoning: 24.00,  cacheCreation: 4.00  },
  "gpt-5.1-codex":                { input: 4.00,  output: 16.00, cached: 2.00,  reasoning: 24.00,  cacheCreation: 4.00  },
  "gpt-5.1-codex-mini":           { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cacheCreation: 1.50  },
  "gpt-5.1-codex-max":            { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cacheCreation: 8.00  },
  "gpt-5.2":                      { input: 5.00,  output: 20.00, cached: 2.50,  reasoning: 30.00,  cacheCreation: 5.00  },
  "gpt-5.2-codex":                { input: 5.00,  output: 20.00, cached: 2.50,  reasoning: 30.00,  cacheCreation: 5.00  },
  "gpt-5.3-codex":                { input: 6.00,  output: 24.00, cached: 3.00,  reasoning: 36.00,  cacheCreation: 6.00  },
  "gpt-5.3-codex-high":           { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cacheCreation: 8.00  },
  "gpt-5.3-codex-xhigh":          { input: 10.00, output: 40.00, cached: 5.00,  reasoning: 60.00,  cacheCreation: 10.00 },
  // GPT-5.6 family — developers.openai.com (short-context rates; long-context ~2×)
  "gpt-5.6-sol":                  { input: 5.00,  output: 30.00, cached: 0.50,  reasoning: 30.00,  cacheCreation: 6.25  },
  "gpt-5.6-terra":                { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cacheCreation: 3.125 },
  "gpt-5.6-luna":                 { input: 1.00,  output: 6.00,  cached: 0.10,  reasoning: 6.00,   cacheCreation: 1.25  },
  "gpt-5.5-pro":                  { input: 30.00, output: 180.00, cached: 1.50, reasoning: 180.00, cacheCreation: 30.00 },
  "gpt-5.5":                      { input: 5.00,  output: 30.00, cached: 0.50,  reasoning: 30.00,  cacheCreation: 6.25  },
  "gpt-5.4-pro":                  { input: 30.00, output: 180.00, cached: 1.50, reasoning: 180.00, cacheCreation: 30.00 },
  "gpt-5.4":                      { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cacheCreation: 3.125 },
  "gpt-5.4-mini":                 { input: 0.75,  output: 4.50,  cached: 0.075, reasoning: 4.50,   cacheCreation: 0.75  },
  "gpt-5.4-nano":                 { input: 0.20,  output: 1.25,  cached: 0.02,  reasoning: 1.25,   cacheCreation: 0.20  },
  "gpt-5.3-codex":                { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 1.75  },
  "gpt-4o":                       { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cacheCreation: 2.50  },
  "gpt-4o-mini":                  { input: 0.15,  output: 0.60,  cached: 0.075, reasoning: 0.90,   cacheCreation: 0.15  },

  // === Gemini (antigravity upstream) ===
  "gemini-3-flash-preview":       { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cacheCreation: 0.50  },
  "gemini-3-pro-preview":         { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cacheCreation: 2.00  },
  "gemini-3-flash":               { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cacheCreation: 0.50  },
  "gemini-2.5-pro":               { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cacheCreation: 2.00  },
  "gemini-2.5-flash":             { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cacheCreation: 0.30  },
  "gemini-2.5-flash-lite":        { input: 0.15,  output: 1.25,  cached: 0.015, reasoning: 1.875,  cacheCreation: 0.15  },
  // Gemini 3.1 / 3.5 — ai.google.dev (latest, 2026)
  "gemini-3.1-pro":               { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 22.50,  cacheCreation: 2.50  },
  "gemini-3.5-flash":             { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cacheCreation: 0.30  },

  // === xAI Grok — docs.x.ai (latest: grok-4.5, grok-4.3) ===
  "grok-4.5":                     { input: 2.00,  output: 6.00,  cached: 0.20,  reasoning: 6.00,   cacheCreation: 2.00  },
  "grok-4.3":                     { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.25  },
  "grok-build-0.1":               { input: 1.00,  output: 2.00,  cached: 0.10,  reasoning: 2.00,   cacheCreation: 1.00  },

  // === F13 OpenAI-compatible catalog (verified per provider docs, 2026-07) ===
  // DeepSeek — api-docs.deepseek.com (deepseek-chat = v4-flash, deepseek-reasoner = thinking)
  "deepseek-chat":                { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.014 },
  "deepseek-reasoner":            { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.014 },
  "deepseek-coder":               { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.014 },
  "deepseek-v4-flash":            { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.014 },
  "deepseek-v4-pro":              { input: 0.435, output: 0.87,  cached: 0.0036, reasoning: 0.87,  cacheCreation: 0.0435 },
  // OpenAI legacy — developers.openai.com
  "gpt-4-turbo":                  { input: 10.00, output: 30.00, cached: 5.00,   reasoning: 30.00, cacheCreation: 10.00 },
  "gpt-4":                        { input: 30.00, output: 60.00, cached: 15.00,  reasoning: 60.00, cacheCreation: 30.00 },
  "gpt-3.5-turbo":                { input: 0.50,  output: 1.50,  cached: 0.25,   reasoning: 1.50,  cacheCreation: 0.50  },
  "o1":                           { input: 15.00, output: 60.00, cached: 7.50,   reasoning: 60.00, cacheCreation: 15.00 },
  "o1-mini":                      { input: 1.10,  output: 4.40,  cached: 0.55,   reasoning: 4.40,  cacheCreation: 1.10  },
  "o3-mini":                      { input: 1.10,  output: 4.40,  cached: 0.55,   reasoning: 4.40,  cacheCreation: 1.10  },
  // Mistral — mistral.ai/pricing/api
  "mistral-large-latest":         { input: 0.50,  output: 1.50,  cached: 0.25,   reasoning: 1.50,  cacheCreation: 0.50  },
  "mistral-small-latest":         { input: 0.15,  output: 0.60,  cached: 0.075,  reasoning: 0.60,  cacheCreation: 0.15  },
  "codestral-latest":             { input: 0.30,  output: 0.90,  cached: 0.15,   reasoning: 0.90,  cacheCreation: 0.30  },
  // Groq — groq.com/pricing
  "llama-3.3-70b-versatile":      { input: 0.59,  output: 0.79,  cached: 0.059,  reasoning: 0.79,  cacheCreation: 0.59  },
  "llama-3.1-70b-versatile":      { input: 0.59,  output: 0.79,  cached: 0.059,  reasoning: 0.79,  cacheCreation: 0.59  },
  "mixtral-8x7b-32768":           { input: 0.24,  output: 0.24,  cached: 0.024,  reasoning: 0.24,  cacheCreation: 0.24  },
  // xAI Grok — docs.x.ai (grok-2 legacy rates)
  "grok-2":                       { input: 2.00,  output: 10.00, cached: 0.20,   reasoning: 10.00, cacheCreation: 2.00  },
  "grok-2-latest":                { input: 2.00,  output: 10.00, cached: 0.20,   reasoning: 10.00, cacheCreation: 2.00  },
  "grok-beta":                    { input: 5.00,  output: 15.00, cached: 0.50,   reasoning: 15.00, cacheCreation: 5.00  },
  // Cohere — docs.cohere.com
  "command-r-plus":               { input: 2.50,  output: 10.00, cached: 0.25,   reasoning: 10.00, cacheCreation: 2.50  },
  "command-r":                    { input: 0.50,  output: 1.50,  cached: 0.05,   reasoning: 1.50,  cacheCreation: 0.50  },
  "command-r7b":                  { input: 0.0375, output: 0.15, cached: 0.00375, reasoning: 0.15,  cacheCreation: 0.0375 },
  // Qwen — alibabacloud.com/help/en/model-studio/billing (international USD, ≤32K tier)
  "qwen3-max":                    { input: 1.20,  output: 6.00,  cached: 0.12,   reasoning: 6.00,  cacheCreation: 1.20  },
  "qwen-turbo":                   { input: 0.05,  output: 0.20,  cached: 0.005,  reasoning: 0.50,  cacheCreation: 0.05  },
  "qwen3-coder":                  { input: 1.00,  output: 5.00,  cached: 0.10,   reasoning: 5.00,  cacheCreation: 1.00  },
  "qwen-vl-max":                  { input: 0.20,  output: 1.60,  cached: 0.02,   reasoning: 1.60,  cacheCreation: 0.20  },
  // MiniMax — platform.minimaxi.com (M3 flagship, standard tier; CNY→USD ~7.2)
  "minimax-m3":                   { input: 0.58,  output: 2.33,  cached: 0.058,  reasoning: 2.33,  cacheCreation: 0.58  },
  "minimax-m2.7":                 { input: 0.29,  output: 1.17,  cached: 0.029,  reasoning: 1.17,  cacheCreation: 0.29  },
  // Kimi (Moonshot) — platform.kimi.ai (k2.6 general, k2.7-code same price)
  "kimi-k2.6":                    { input: 0.95,  output: 4.00,  cached: 0.16,   reasoning: 4.00,  cacheCreation: 0.95  },
  "kimi-k2.7-code":               { input: 0.95,  output: 4.00,  cached: 0.19,   reasoning: 4.00,  cacheCreation: 0.95  },
  "moonshot-v1-8k":               { input: 0.20,  output: 2.00,  cached: 0.02,   reasoning: 2.00,  cacheCreation: 0.20  },
  "moonshot-v1-32k":              { input: 1.00,  output: 3.00,  cached: 0.10,   reasoning: 3.00,  cacheCreation: 1.00  },
  "moonshot-v1-128k":             { input: 2.00,  output: 5.00,  cached: 0.20,   reasoning: 5.00,  cacheCreation: 2.00  },
  // GLM (Zhipu) — docs.bigmodel.cn (glm-4-flash free; GLM-5.x paid, CNY→USD ~7.2)
  "glm-5.2":                      { input: 0.69,  output: 2.08,  cached: 0.069,  reasoning: 2.08,  cacheCreation: 0.69  },
  "glm-5.1":                      { input: 0.55,  output: 1.66,  cached: 0.055,  reasoning: 1.66,  cacheCreation: 0.55  },
  "glm-5":                        { input: 0.42,  output: 1.25,  cached: 0.042,  reasoning: 1.25,  cacheCreation: 0.42  },
  "glm-4-flash":                  { input: 0.00,  output: 0.00,  cached: 0.00,   reasoning: 0.00,  cacheCreation: 0.00  },
};

/** Token breakdown captured from the upstream `usage` object. */
export interface TokenBreakdown {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cache-read tokens (Anthropic `cache_read_input_tokens` / OpenAI `cached_tokens`). */
  cachedTokens: number;
  /** Cache-write tokens (Anthropic `cache_creation_input_tokens`). */
  cacheCreationTokens: number;
  /** Reasoning/thinking tokens (OpenAI `reasoning_tokens`). */
  reasoningTokens: number;
}

// --- User-override cache (mirrors pricingRepo.js 5s TTL) ---
const CACHE_TTL_MS = 5_000;
let userPricingCache: { value: Record<string, any> | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};

/** Invalidate the user-pricing cache. Call after a pricing CRUD mutation. */
export function invalidatePricingCache(): void {
  userPricingCache = { value: null, expiresAt: 0 };
}

/** Read all user pricing overrides from the `kv(pricing)` table (mirrors management.ts kvGet). */
async function getUserPricing(): Promise<Record<string, any>> {
  const now = Date.now();
  if (userPricingCache.value && userPricingCache.expiresAt > now) {
    return userPricingCache.value ?? {};
  }
  const rows = await db.select().from(kv).where(eq(kv.scope, "pricing"));
  const value: Record<string, any> = {};
  for (const r of rows) {
    try { value[r.key] = JSON.parse(r.value); } catch { value[r.key] = r.value; }
  }
  userPricingCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}
/**
 * Resolve a provider-prefixed alias to its CANONICAL model name.
 *
 * The catalog (MODEL_PRICING / MODEL_SPECS) is keyed by canonical model name
 * (e.g. "glm-5.2", "claude-opus-4.8") -- a model context/price is a property
 * of the MODEL, not the provider. But a request body.model can be a prefixed
 * alias (e.g. "cbc-glm-5.2", "kp-opus-4.8"). Without canonicalization,
 * pricing/spec lookups miss and cost is silently 0; dashboard edits stored
 * under the alias would not apply across providers.
 *
 * Prefixes mirror the providers own toCanonical maps + isNativeProviderId
 * (model-mapping.ts). This is a RESOLUTION layer for the shared catalog;
 * provider-specific canonicalization for routing still lives in each provider.
 */
export function toCanonicalModelName(model: string | undefined | null): string {
  if (!model) return "";
  let m = model;
  // Kiro Pro: kp-<anthropic> -> claude-<anthropic> (kp-opus-4.8 -> claude-opus-4.8).
  if (m.startsWith("kp-")) {
    m = "claude-" + m.slice(3);
  }
  // Provider routing prefixes (strip, do not swap):
  if (m.startsWith("cbc-")) m = m.slice(4);
  else if (m.startsWith("cb-")) m = m.slice(3);
  else if (m.startsWith("qd-")) m = m.slice(3);
  else if (m.startsWith("ym-")) m = m.slice(3);
  else if (m.startsWith("gitlab-duo:")) m = m.slice(11);
  // -thinking variant shares the base model pricing/spec.
  m = m.replace(/-thinking$/, "");
  // NOTE: date suffixes are NOT stripped here (some keys ARE dated).


  return m;
}


/**
 * Resolve pricing for a model. User override wins; baseline is the fallback.
 * Returns null when neither has an entry (cost → 0, never crashes).
 *
 * User KV stores up to 5 fields (3 legacy + 2 new). Legacy 3-field entries
 * are preserved: missing reasoning/cacheCreation fall back to output/input
 * respectively (matching reference calculateCost's `|| pricing.output` /
 * `|| pricing.input` defaults).
 */
export async function getPricingForModel(model: string): Promise<ModelPricing | null> {
  if (!model) return null;
  const canonical = toCanonicalModelName(model);
  const userPricing = await getUserPricing();
  const userEntry = userPricing[canonical];
  if (userEntry) {
    // User override — accept both legacy ($/1M named *Per1M) and baseline-named.
    const input = Number(userEntry.inputPer1M ?? userEntry.input ?? 0);
    const output = Number(userEntry.outputPer1M ?? userEntry.output ?? 0);
    const cached = Number(userEntry.cachedInputPer1M ?? userEntry.cached ?? input);
    const reasoning = Number(userEntry.reasoningPer1M ?? userEntry.reasoning ?? output);
    const cacheCreation = Number(userEntry.cacheCreationPer1M ?? userEntry.cacheCreation ?? input);
    if (input > 0 || output > 0) {
      return { input, output, cached, reasoning, cacheCreation };
    }
  }
  // Try the exact canonical key first; then a date-stripped fallback so a dated
  // request id (claude-sonnet-4-5-20250929) inherits its base entry when only the
  // dated key OR only the base key exists in the catalog.
  if (MODEL_PRICING[canonical]) return MODEL_PRICING[canonical];
  const dateless = canonical.replace(/-\d{4}-\d{2}-\d{2}.*$/, "").replace(/-\d{8}$/, "");
  return MODEL_PRICING[dateless] ?? null;
}

/**
 * Compute USD cost for a request from its token breakdown + model pricing.
 * Faithful port of the reference proxy usageRepo.js calculateCost (lines 113-151).
 *
 * Formula:
 *   nonCachedInput = max(0, prompt - cached)         × input   / 1M
 *   cached                                         × (cached  || input)  / 1M
 *   completion                                     × output  / 1M
 *   reasoning                                      × (reasoning || output) / 1M
 *   cacheCreation                                  × (cacheCreation || input) / 1M
 *
 * Never throws — returns 0 on any error so the recording path is unaffected.
 */
export async function calculateCost(model: string, tokens: TokenBreakdown): Promise<number> {
  if (!model || !tokens) return 0;
  try {
    const pricing = await getPricingForModel(model);
    if (!pricing) return 0;

    let cost = 0;
    const inputTokens = tokens.promptTokens || 0;
    const cachedTokens = tokens.cachedTokens || 0;
    const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
    cost += nonCachedInput * (pricing.input / 1_000_000);

    if (cachedTokens > 0) {
      const cachedRate = pricing.cached || pricing.input;
      cost += cachedTokens * (cachedRate / 1_000_000);
    }

    const outputTokens = tokens.completionTokens || 0;
    cost += outputTokens * (pricing.output / 1_000_000);

    const reasoningTokens = tokens.reasoningTokens || 0;
    if (reasoningTokens > 0) {
      const rate = pricing.reasoning || pricing.output;
      cost += reasoningTokens * (rate / 1_000_000);
    }

    const cacheCreationTokens = tokens.cacheCreationTokens || 0;
    if (cacheCreationTokens > 0) {
      const rate = pricing.cacheCreation || pricing.input;
      cost += cacheCreationTokens * (rate / 1_000_000);
    }

    return cost;
  } catch (err) {
    console.error("[Pricing] calculateCost error:", err);
    return 0;
  }
}
