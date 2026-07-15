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
 * Baseline USD rates ($/1M tokens). Researched 2026-07 against:
 * - Anthropic platform.claude.com/docs pricing (Opus/Sonnet/Haiku/Fable)
 * - OpenAI developers.openai.com/api/docs/pricing (GPT-5.4/5.5/5.6, Codex)
 * - xAI docs.x.ai (Grok 4.5 / 4.3 / Build)
 * - DeepSeek api-docs.deepseek.com (V4 Flash/Pro)
 * - Google ai.google.dev / cloud pricing (Gemini 2.5 / 3.x)
 *
 * Cache: Anthropic/OpenAI-style cache read ≈ 10% input; write ≈ 1.25× input where published.
 * Reasoning billed at output rate when not separately published.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic Claude — platform.claude.com (2026-07) ──
  // Opus 4.x: $5 / $25 · Sonnet 4.x/5: $3 / $15 · Haiku 4.5: $1 / $5 · Fable 5: $10 / $50
  "claude-opus-4.8":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4-8":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4.7":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4.6":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4-6":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4.5":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4-5-20251101":     { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cacheCreation: 6.25  },
  "claude-opus-4-20250514":       { input: 15.00, output: 75.00, cached: 1.50,  reasoning: 75.00,  cacheCreation: 18.75 },
  "claude-sonnet-5":              { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-sonnet-4.6":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-sonnet-4-6":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-sonnet-4.5":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-sonnet-4-5-20250929":   { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-sonnet-4":              { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-sonnet-4-20250514":     { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-3-5-sonnet-20241022":   { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-3.5-sonnet":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cacheCreation: 3.75  },
  "claude-haiku-4.5":             { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cacheCreation: 1.25  },
  "claude-haiku-4-5":             { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cacheCreation: 1.25  },
  "claude-haiku-4-5-20251001":    { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cacheCreation: 1.25  },
  "claude-fable-5":               { input: 10.00, output: 50.00, cached: 1.00,  reasoning: 50.00,  cacheCreation: 12.50 },
  "claude-mythos-5":              { input: 10.00, output: 50.00, cached: 1.00,  reasoning: 50.00,  cacheCreation: 12.50 },

  // ── OpenAI — developers.openai.com/api/docs/pricing (2026-07 short-context) ──
  "gpt-5.6-sol":                  { input: 5.00,  output: 30.00, cached: 0.50,  reasoning: 30.00,  cacheCreation: 6.25  },
  "gpt-5.6":                      { input: 5.00,  output: 30.00, cached: 0.50,  reasoning: 30.00,  cacheCreation: 6.25  },
  "gpt-5.6-terra":                { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cacheCreation: 3.125 },
  "gpt-5.6-luna":                 { input: 1.00,  output: 6.00,  cached: 0.10,  reasoning: 6.00,   cacheCreation: 1.25  },
  "gpt-5.5":                      { input: 5.00,  output: 30.00, cached: 0.50,  reasoning: 30.00,  cacheCreation: 6.25  },
  "gpt-5.5-pro":                  { input: 30.00, output: 180.00, cached: 3.00, reasoning: 180.00, cacheCreation: 37.50 },
  "gpt-5.4":                      { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cacheCreation: 3.125 },
  "gpt-5.4-mini":                 { input: 0.75,  output: 4.50,  cached: 0.075, reasoning: 4.50,   cacheCreation: 0.9375 },
  "gpt-5.4-nano":                 { input: 0.20,  output: 1.25,  cached: 0.02,  reasoning: 1.25,   cacheCreation: 0.25  },
  "gpt-5.4-pro":                  { input: 30.00, output: 180.00, cached: 3.00, reasoning: 180.00, cacheCreation: 37.50 },
  "gpt-5.3":                      { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 2.1875 },
  "gpt-5.3-codex":                { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 2.1875 },
  "gpt-5.3-codex-high":           { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 2.1875 },
  "gpt-5.3-codex-xhigh":          { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 2.1875 },
  "gpt-5.2":                      { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cacheCreation: 3.125 },
  "gpt-5.2-codex":                { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 2.1875 },
  "gpt-5.1":                      { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cacheCreation: 3.125 },
  "gpt-5.1-codex":                { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 2.1875 },
  "gpt-5.1-codex-mini":           { input: 0.75,  output: 4.50,  cached: 0.075, reasoning: 4.50,   cacheCreation: 0.9375 },
  "gpt-5.1-codex-max":            { input: 5.00,  output: 30.00, cached: 0.50,  reasoning: 30.00,  cacheCreation: 6.25  },
  "gpt-5":                        { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cacheCreation: 3.125 },
  "gpt-5-mini":                   { input: 0.75,  output: 4.50,  cached: 0.075, reasoning: 4.50,   cacheCreation: 0.9375 },
  "gpt-5-codex":                  { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cacheCreation: 2.1875 },
  "gpt-4o":                       { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 10.00,  cacheCreation: 3.125 },
  "gpt-4o-mini":                  { input: 0.15,  output: 0.60,  cached: 0.075, reasoning: 0.60,   cacheCreation: 0.1875 },
  "gpt-4-turbo":                  { input: 10.00, output: 30.00, cached: 5.00,   reasoning: 30.00,  cacheCreation: 12.50 },
  "gpt-4":                        { input: 30.00, output: 60.00, cached: 15.00,  reasoning: 60.00,  cacheCreation: 37.50 },
  "gpt-3.5-turbo":                { input: 0.50,  output: 1.50,  cached: 0.25,   reasoning: 1.50,   cacheCreation: 0.625 },
  "o1":                           { input: 15.00, output: 60.00, cached: 7.50,   reasoning: 60.00,  cacheCreation: 18.75 },
  "o1-mini":                      { input: 1.10,  output: 4.40,  cached: 0.55,   reasoning: 4.40,   cacheCreation: 1.375 },
  "o3-mini":                      { input: 1.10,  output: 4.40,  cached: 0.55,   reasoning: 4.40,   cacheCreation: 1.375 },

  // ── Google Gemini — ai.google.dev / cloud (2026-07, ≤200K tier where tiered) ──
  "gemini-3.5-flash":             { input: 1.50,  output: 9.00,  cached: 0.15,  reasoning: 9.00,   cacheCreation: 1.875 },
  "gemini-3.1-pro":               { input: 2.00,  output: 12.00, cached: 0.20,  reasoning: 12.00,  cacheCreation: 2.50  },
  "gemini-3-pro":                 { input: 2.00,  output: 12.00, cached: 0.20,  reasoning: 12.00,  cacheCreation: 2.50  },
  "gemini-3-pro-high":            { input: 2.00,  output: 12.00, cached: 0.20,  reasoning: 12.00,  cacheCreation: 2.50  },
  "gemini-3-pro-preview":         { input: 2.00,  output: 12.00, cached: 0.20,  reasoning: 12.00,  cacheCreation: 2.50  },
  "gemini-3-flash":               { input: 0.50,  output: 3.00,  cached: 0.05,  reasoning: 3.00,   cacheCreation: 0.625 },
  "gemini-3-flash-preview":       { input: 0.50,  output: 3.00,  cached: 0.05,  reasoning: 3.00,   cacheCreation: 0.625 },
  "gemini-2.5-pro":               { input: 1.25,  output: 10.00, cached: 0.125, reasoning: 10.00,  cacheCreation: 1.5625 },
  "gemini-2.5-flash":             { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 2.50,   cacheCreation: 0.375 },
  "gemini-2.5-flash-lite":        { input: 0.10,  output: 0.40,  cached: 0.01,  reasoning: 0.40,   cacheCreation: 0.125 },
  // CodeBuddy gemini-3.0-flash → gemini-3-flash (alias also applied in toCanonical).
  "gemini-3.0-flash":             { input: 0.50,  output: 3.00,  cached: 0.05,  reasoning: 3.00,   cacheCreation: 0.625 },
  "gemini-3.1-flash-lite":        { input: 0.10,  output: 0.40,  cached: 0.01,  reasoning: 0.40,   cacheCreation: 0.125 },

  // ── xAI Grok — docs.x.ai (2026-07) ──
  "grok-4.5":                     { input: 2.00,  output: 6.00,  cached: 0.20,  reasoning: 6.00,   cacheCreation: 2.50  },
  "grok-4.5-reasoning":           { input: 2.00,  output: 6.00,  cached: 0.20,  reasoning: 6.00,   cacheCreation: 2.50  },
  // Composer 2.5 — Cursor docs (cursor.com/docs/models/cursor-composer-2-5):
  // standard $0.50/$2.50, cache read $0.20. Fast tier is $3/$15.
  // xAI docs do NOT list composer-2.5 on API pricing (Grok Build subscription
  // surface); rates used for cost UI when tokens are reported.
  "composer-2.5":                 { input: 0.50,  output: 2.50,  cached: 0.20,  reasoning: 2.50,   cacheCreation: 0.625 },
  // Live cli-chat-proxy id: grok-composer-2.5-fast (Composer 2.5 Fast).
  "grok-composer-2.5-fast":       { input: 3.00,  output: 15.00, cached: 0.20,  reasoning: 15.00,  cacheCreation: 3.75  },
  "composer-2.5-fast":            { input: 3.00,  output: 15.00, cached: 0.20,  reasoning: 15.00,  cacheCreation: 3.75  },
  "grok-4.3":                     { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-4.3-reasoning":           { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-4.3-heavy":               { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-4.20":                    { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-4.20-fast":               { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-4.20-reasoning":          { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-4.20-heavy":              { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-4.20-super":              { input: 1.25,  output: 2.50,  cached: 0.125, reasoning: 2.50,   cacheCreation: 1.5625 },
  "grok-build-0.1":               { input: 1.00,  output: 2.00,  cached: 0.10,  reasoning: 2.00,   cacheCreation: 1.25  },

  // ── DeepSeek — api-docs.deepseek.com (2026-07) ──
  "deepseek-v4-flash":            { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.175 },
  "deepseek-v4-pro":              { input: 0.435, output: 0.87,  cached: 0.003625, reasoning: 0.87, cacheCreation: 0.54375 },
  "deepseek-chat":                { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.175 },
  "deepseek-reasoner":            { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.175 },
  "deepseek-coder":               { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.175 },
  // CBC / legacy aliases (also rewritten in toCanonical).
  "deepseek-r1":                  { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.175 },
  "deepseek-v3":                  { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,  cacheCreation: 0.175 },
  "deepseek-v3.2":                { input: 0.28,  output: 0.42,  cached: 0.028,  reasoning: 0.42,  cacheCreation: 0.35  },
  "deepseek-3.2":                 { input: 0.28,  output: 0.42,  cached: 0.028,  reasoning: 0.42,  cacheCreation: 0.35  },

  // ── Mistral / Groq / Cohere ──
  "mistral-large-latest":         { input: 0.50,  output: 1.50,  cached: 0.25,   reasoning: 1.50,  cacheCreation: 0.625 },
  "mistral-small-latest":         { input: 0.15,  output: 0.60,  cached: 0.075,  reasoning: 0.60,  cacheCreation: 0.1875 },
  "codestral-latest":             { input: 0.30,  output: 0.90,  cached: 0.15,   reasoning: 0.90,  cacheCreation: 0.375 },
  "llama-3.3-70b-versatile":      { input: 0.59,  output: 0.79,  cached: 0.059,  reasoning: 0.79,  cacheCreation: 0.7375 },
  "llama-3.1-70b-versatile":      { input: 0.59,  output: 0.79,  cached: 0.059,  reasoning: 0.79,  cacheCreation: 0.7375 },
  "mixtral-8x7b-32768":           { input: 0.24,  output: 0.24,  cached: 0.024,  reasoning: 0.24,  cacheCreation: 0.30  },
  "command-r-plus":               { input: 2.50,  output: 10.00, cached: 0.25,   reasoning: 10.00, cacheCreation: 3.125 },
  "command-r":                    { input: 0.50,  output: 1.50,  cached: 0.05,   reasoning: 1.50,  cacheCreation: 0.625 },
  "command-r7b":                  { input: 0.0375, output: 0.15, cached: 0.00375, reasoning: 0.15, cacheCreation: 0.046875 },

  // ── Qwen (DashScope international, indicative) ──
  "qwen3.7-max":                  { input: 1.20,  output: 6.00,  cached: 0.12,   reasoning: 6.00,  cacheCreation: 1.50  },
  "qwen3.7-max-preview":          { input: 1.20,  output: 6.00,  cached: 0.12,   reasoning: 6.00,  cacheCreation: 1.50  },
  "qwen3.7-plus":                 { input: 0.80,  output: 4.00,  cached: 0.08,   reasoning: 4.00,  cacheCreation: 1.00  },
  "qwen3.6-plus":                 { input: 0.80,  output: 4.00,  cached: 0.08,   reasoning: 4.00,  cacheCreation: 1.00  },
  "qwen3.5-plus":                 { input: 0.40,  output: 2.00,  cached: 0.04,   reasoning: 2.00,  cacheCreation: 0.50  },
  "qwen3.5-flash":                { input: 0.05,  output: 0.20,  cached: 0.005,  reasoning: 0.20,  cacheCreation: 0.0625 },
  "qwen3.6-flash":                { input: 0.05,  output: 0.20,  cached: 0.005,  reasoning: 0.20,  cacheCreation: 0.0625 },
  "qwen3-max":                    { input: 1.20,  output: 6.00,  cached: 0.12,   reasoning: 6.00,  cacheCreation: 1.50  },
  "qwen3-max-preview":            { input: 1.20,  output: 6.00,  cached: 0.12,   reasoning: 6.00,  cacheCreation: 1.50  },
  "qwen3-coder-plus":             { input: 1.00,  output: 5.00,  cached: 0.10,   reasoning: 5.00,  cacheCreation: 1.25  },
  "qwen3-coder-next":             { input: 1.00,  output: 5.00,  cached: 0.10,   reasoning: 5.00,  cacheCreation: 1.25  },
  "qwen3-coder-flash":            { input: 0.30,  output: 1.50,  cached: 0.03,   reasoning: 1.50,  cacheCreation: 0.375 },
  "qwen3-coder":                  { input: 1.00,  output: 5.00,  cached: 0.10,   reasoning: 5.00,  cacheCreation: 1.25  },
  "qwen3-vl-plus":                { input: 0.80,  output: 4.00,  cached: 0.08,   reasoning: 4.00,  cacheCreation: 1.00  },
  "qwen3-vl-flash":               { input: 0.15,  output: 0.60,  cached: 0.015,  reasoning: 0.60,  cacheCreation: 0.1875 },
  "qwen-plus":                    { input: 0.40,  output: 1.20,  cached: 0.04,   reasoning: 1.20,  cacheCreation: 0.50  },
  "qwen-plus-latest":             { input: 0.40,  output: 1.20,  cached: 0.04,   reasoning: 1.20,  cacheCreation: 0.50  },
  "qwen-max":                     { input: 1.60,  output: 6.40,  cached: 0.16,   reasoning: 6.40,  cacheCreation: 2.00  },
  "qwen-turbo":                   { input: 0.05,  output: 0.20,  cached: 0.005,  reasoning: 0.20,  cacheCreation: 0.0625 },
  "qwen-flash":                   { input: 0.05,  output: 0.20,  cached: 0.005,  reasoning: 0.20,  cacheCreation: 0.0625 },
  "qwen-vl-max":                  { input: 0.20,  output: 1.60,  cached: 0.02,   reasoning: 1.60,  cacheCreation: 0.25  },
  "qwen-vl-plus":                 { input: 0.15,  output: 0.60,  cached: 0.015,  reasoning: 0.60,  cacheCreation: 0.1875 },
  "qwq-plus":                     { input: 0.80,  output: 2.40,  cached: 0.08,   reasoning: 2.40,  cacheCreation: 1.00  },
  "qvq-max":                      { input: 1.20,  output: 4.80,  cached: 0.12,   reasoning: 4.80,  cacheCreation: 1.50  },
  "qwen-coder-plus":              { input: 1.00,  output: 5.00,  cached: 0.10,   reasoning: 5.00,  cacheCreation: 1.25  },
  // Image models — DashScope bills per image; token rates are indicative for UI.
  "qwen-image-max":               { input: 8.00,  output: 8.00,  cached: 8.00,   reasoning: 8.00,  cacheCreation: 8.00  },
  "qwen-image-plus":              { input: 4.00,  output: 4.00,  cached: 4.00,   reasoning: 4.00,  cacheCreation: 4.00  },

  // ── MiniMax / Kimi / GLM ──
  "minimax-m3":                   { input: 0.58,  output: 2.33,  cached: 0.058,  reasoning: 2.33,  cacheCreation: 0.725 },
  "minimax-m2.7":                 { input: 0.29,  output: 1.17,  cached: 0.029,  reasoning: 1.17,  cacheCreation: 0.3625 },
  "minimax-m2.5":                 { input: 0.29,  output: 1.17,  cached: 0.029,  reasoning: 1.17,  cacheCreation: 0.3625 },
  "minimax-m2.1":                 { input: 0.29,  output: 1.17,  cached: 0.029,  reasoning: 1.17,  cacheCreation: 0.3625 },
  // Kimi: platform.moonshot.cn / openrouter (k2.5–k2.7 share ~$0.95/$4 family rates)
  "kimi-k2.5":                    { input: 0.60,  output: 2.50,  cached: 0.15,   reasoning: 2.50,  cacheCreation: 0.75  },
  "kimi-k2.6":                    { input: 0.95,  output: 4.00,  cached: 0.16,   reasoning: 4.00,  cacheCreation: 1.1875 },
  // cbc-kimi-k2.7 / bare kimi-k2.7 ≈ kimi-k2.7-code SKU
  "kimi-k2.7":                    { input: 0.95,  output: 4.00,  cached: 0.19,   reasoning: 4.00,  cacheCreation: 1.1875 },
  "kimi-k2.7-code":               { input: 0.95,  output: 4.00,  cached: 0.19,   reasoning: 4.00,  cacheCreation: 1.1875 },
  "moonshot-v1-8k":               { input: 0.20,  output: 2.00,  cached: 0.02,   reasoning: 2.00,  cacheCreation: 0.25  },
  "moonshot-v1-32k":              { input: 1.00,  output: 3.00,  cached: 0.10,   reasoning: 3.00,  cacheCreation: 1.25  },
  "moonshot-v1-128k":             { input: 2.00,  output: 5.00,  cached: 0.20,   reasoning: 5.00,  cacheCreation: 2.50  },
  "glm-5.2":                      { input: 0.69,  output: 2.08,  cached: 0.069,  reasoning: 2.08,  cacheCreation: 0.8625 },
  "glm-5.1":                      { input: 0.55,  output: 1.66,  cached: 0.055,  reasoning: 1.66,  cacheCreation: 0.6875 },
  "glm-5":                        { input: 0.42,  output: 1.25,  cached: 0.042,  reasoning: 1.25,  cacheCreation: 0.525 },
  // Z.AI docs.z.ai: GLM-5V-Turbo $1.20 / $4.00, cache read $0.24 (2026-07)
  "glm-5v-turbo":                 { input: 1.20,  output: 4.00,  cached: 0.24,   reasoning: 4.00,  cacheCreation: 1.50  },
  "glm-5-turbo":                  { input: 1.20,  output: 4.00,  cached: 0.24,   reasoning: 4.00,  cacheCreation: 1.50  },
  "glm-4-flash":                  { input: 0.00,  output: 0.00,  cached: 0.00,   reasoning: 0.00,  cacheCreation: 0.00  },
  // CBC Hunyuan / specialty
  "hy3-preview":                  { input: 0.80,  output: 2.00,  cached: 0.08,   reasoning: 2.00,  cacheCreation: 1.00  },

  // ── Proprietary / non-token surfaces (indicative for cost UI) ──
  "canva-image":                  { input: 5.00,  output: 5.00,  cached: 5.00,   reasoning: 5.00,  cacheCreation: 5.00  },
  "canva-video":                  { input: 20.00, output: 20.00, cached: 20.00,  reasoning: 20.00, cacheCreation: 20.00 },
  "cursor-fast":                  { input: 1.00,  output: 3.00,  cached: 0.10,   reasoning: 3.00,  cacheCreation: 1.25  },
  "cursor-small":                 { input: 0.30,  output: 1.00,  cached: 0.03,   reasoning: 1.00,  cacheCreation: 0.375 },
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
  let m = model.trim();

  // Catalog keys are lowercase; qd-Qwen3.7-Max / Llama-3.3-… must fold for lookup.
  // Live list ids are never rewritten — only this resolution path lowercases.
  m = m.toLowerCase();

  // Vendor/org path form (OpenRouter, LiteLLM, Fireworks, …):
  // openai/gpt-4o → gpt-4o; accounts/fireworks/models/foo → foo.
  if (m.includes("/")) {
    m = m.slice(m.lastIndexOf("/") + 1);
  }

  // Kiro Pro: only Anthropic short names get claude- (kp-opus-4.8 → claude-opus-4.8).
  // kp-auto stays "auto" (not claude-auto).
  if (m.startsWith("kp-") || m.startsWith("kp_")) {
    const rest = m.slice(3);
    m = /^(opus|sonnet|haiku|fable|mythos)[-_]/.test(rest) ? "claude-" + rest : rest;
  }
  // Provider routing prefixes (strip, do not swap):
  if (m.startsWith("cbc-") || m.startsWith("cbc_")) m = m.slice(4);
  else if (m.startsWith("cb-") || m.startsWith("cb_")) m = m.slice(3);
  else if (m.startsWith("qd-") || m.startsWith("qd_")) m = m.slice(3);
  else if (m.startsWith("ym-") || m.startsWith("ym_")) m = m.slice(3);
  else if (m.startsWith("ali-") || m.startsWith("ali_")) m = m.slice(4);
  else if (m.startsWith("ag-") || m.startsWith("ag_")) m = m.slice(3);
  else if (m.startsWith("codex-") || m.startsWith("codex_")) m = m.slice(6);
  else if (m.startsWith("gitlab-duo:")) m = m.slice(11);
  // -thinking / _thinking and -1m context variants share base model rates.
  m = m.replace(/[-_]thinking$/i, "");
  m = m.replace(/-1m$/i, "");
  // Lookup only: providers may report gpt_5.2 / claude_opus_4.8 while our
  // catalog keys use hyphens (gpt-5.2). Do NOT rewrite the live model id in
  // lists — only normalize for pricing/spec resolution.
  m = m.replace(/_/g, "-");

  // Claude short names after prefix strip (mirrors codebuddy/kiro-pro maps):
  // cb-opus-4.8 / cbc-haiku-4.5 → claude-opus-4.8 / claude-haiku-4.5.
  if (/^(opus|sonnet|haiku|fable|mythos)-/.test(m) && !m.startsWith("claude-")) {
    m = "claude-" + m;
  }

  // ── SKU / display-name aliases (lookup only — live id unchanged) ──
  // cbc-kimi-k2.7 / kimi-k2.7 → same rates as kimi-k2.7-code.
  if (m === "kimi-k2.7") m = "kimi-k2.7-code";
  // CodeBuddy / CBC DeepSeek slugs.
  if (m === "deepseek-v3-2" || m === "deepseek-v3-2-volc") m = "deepseek-v3.2";
  if (m === "deepseek-r1") m = "deepseek-reasoner";
  if (m === "deepseek-v3") m = "deepseek-chat";
  // Gemini version punctuation: 3.0 → 3 (gemini-3.0-flash → gemini-3-flash).
  m = m.replace(/^gemini-3\.0-/, "gemini-3-");
  // Cursor / OpenRouter dotted Claude id → catalog hyphen form.
  if (m === "claude-3.5-sonnet") m = "claude-3-5-sonnet-20241022";
  // Codex / Kiro / OpenRouter "auto" routers → mid-tier reference rates.
  if (m === "auto" || m === "auto-review") m = "gpt-5.5";
  // Qoder product tiers (not raw model SKUs) — map to closest public rates.
  if (m === "ultimate") m = "claude-opus-4.8";
  else if (m === "performance") m = "claude-sonnet-4.6";
  else if (m === "efficient") m = "claude-haiku-4.5";
  else if (m === "lite") m = "gpt-4o-mini";
  // Hosted open-model path slugs (Together / Fireworks).
  if (/^llama-3\.3-70b/.test(m) || m === "llama-v3p3-70b-instruct") m = "llama-3.3-70b-versatile";
  if (/^llama-3\.1-70b/.test(m) || /405b/.test(m)) m = "llama-3.1-70b-versatile";
  if (m === "qwen2p5-72b-instruct") m = "qwen-plus";
  // CodeBuddy generic default router.
  if (m === "default") m = "gpt-5.5";

  // NOTE: date suffixes are NOT stripped here (some keys ARE dated).
  // getPricingForModel / catalogLookupKeys peels YYYY-MM-DD / YYYYMMDD.

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
/**
 * OpenAI/Codex/Grok-style effort suffixes. These are intensity knobs on the
 * SAME model (gpt-5.5-high → gpt-5.5), not separate SKUs like -mini/-pro/-nano.
 * Longest match first (xhigh before high).
 */
const EFFORT_SUFFIX_RE = /-(?:xhigh|high|medium|low|minimal)$/i;

/** Strip trailing effort suffix for catalog inheritance (lookup only). */
export function stripEffortSuffix(name: string): string {
  if (!name) return name;
  return name.replace(EFFORT_SUFFIX_RE, "");
}

/** Candidate catalog keys for a model id (lookup only; does not rename the id). */
function catalogLookupKeys(model: string): string[] {
  const canonical = toCanonicalModelName(model);
  const keys: string[] = [];
  const push = (k: string) => {
    if (k) keys.push(k);
  };

  const variants = [canonical, stripEffortSuffix(canonical)].filter(Boolean);
  for (const base of variants) {
    push(base);
    // Date-stripped form (claude-sonnet-4-5-20250929 / qwen-plus-2025-07-14 → base).
    const dateless = base.replace(/-\d{4}-\d{2}-\d{2}.*$/, "").replace(/-\d{8}$/, "");
    push(dateless);
    push(stripEffortSuffix(dateless));
    // BYOK / openrouter: `prefix-gpt-5.5-xhigh` → try `gpt-5.5-xhigh`, `gpt-5.5`, …
    let rest = base;
    while (rest.includes("-")) {
      rest = rest.slice(rest.indexOf("-") + 1);
      push(rest);
      push(stripEffortSuffix(rest));
      // Claude short names may appear mid-peel (…-opus-4.8) or as rest after strip.
      if (/^(opus|sonnet|haiku|fable|mythos)-/i.test(rest)) {
        push("claude-" + rest);
      }
      // kimi-k2.7 → also try kimi-k2.7-code when peel lands on bare k2.7 slug.
      if (/^kimi-k2\.7$/i.test(rest)) push("kimi-k2.7-code");
    }
  }
  // Claude short-name form of the full canonical (if still bare).
  if (/^(opus|sonnet|haiku|fable|mythos)-/i.test(canonical)) {
    push("claude-" + canonical);
  }
  if (/^kimi-k2\.7$/i.test(canonical)) push("kimi-k2.7-code");

  return [...new Set(keys.filter(Boolean))];
}

export async function getPricingForModel(model: string): Promise<ModelPricing | null> {
  if (!model) return null;
  const keys = catalogLookupKeys(model);
  const userPricing = await getUserPricing();
  for (const key of keys) {
    const userEntry = userPricing[key];
    if (!userEntry) continue;
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
  for (const key of keys) {
    if (MODEL_PRICING[key]) return MODEL_PRICING[key]!;
  }
  return null;
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