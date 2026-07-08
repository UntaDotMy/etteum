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
  "gpt-4o":                       { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cacheCreation: 2.50  },
  "gpt-4o-mini":                  { input: 0.15,  output: 0.60,  cached: 0.075, reasoning: 0.90,   cacheCreation: 0.15  },

  // === Gemini (antigravity upstream) ===
  "gemini-3-flash-preview":       { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cacheCreation: 0.50  },
  "gemini-3-pro-preview":         { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cacheCreation: 2.00  },
  "gemini-3-flash":               { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cacheCreation: 0.50  },
  "gemini-2.5-pro":               { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cacheCreation: 2.00  },
  "gemini-2.5-flash":             { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cacheCreation: 0.30  },
  "gemini-2.5-flash-lite":        { input: 0.15,  output: 1.25,  cached: 0.015, reasoning: 1.875,  cacheCreation: 0.15  },
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
  const userPricing = await getUserPricing();
  const userEntry = userPricing[model];
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
  return MODEL_PRICING[model] ?? null;
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
