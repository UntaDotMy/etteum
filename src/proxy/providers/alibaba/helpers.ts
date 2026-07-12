/** alibaba helpers (auth, crypto, transforms). */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "../base";
import type { Account } from "../../../db/schema";
import { db } from "../../../db/index";
import { accounts } from "../../../db/schema";
import { eq, and } from "drizzle-orm";
import { decrypt } from "../../../utils/crypto";
import { config } from "../../../config";
import { resolveModelSpec } from "../../model-specs";

// ============================================================================
// Alibaba DashScope Provider
//
// OpenAPI-compatible relay at dashscope-intl.aliyuncs.com/compatible-mode/v1.
// Auth: Authorization: Bearer sk-... (API key).
//
// All proxy-facing model IDs use the `ali-` prefix. Requests to:
//   `ali-qwen-plus` → /v1/chat/completions with model: "qwen-plus"
//   `ali-deepseek-v4-flash` → /v1/chat/completions with model: "deepseek-v4-flash"
//
// Quota system:
//   GET /api/v1/quotas (non-OpenAI, native DashScope API) returns per-model
//   usage limits (usage_limit = total tokens allocated per period). We use
//   this as the quota cap and track remaining locally via pool.decrementQuota().
//   Models not yet activated ("purchased") return AccessDenied.Unpurchased.
//
// Free tier: each model typically gets 100K–5M tokens per period (60 days).
// ============================================================================

export const DASHSCOPE_BASE = "https://dashscope-intl.aliyuncs.com";
export const CHAT_URL = `${DASHSCOPE_BASE}/compatible-mode/v1/chat/completions`;
export const MODELS_URL = `${DASHSCOPE_BASE}/compatible-mode/v1/models`;
export const QUOTAS_URL = `${DASHSCOPE_BASE}/api/v1/quotas`;

/**
 * Curated catalog of DashScope models available via the OpenAI-compatible
 * endpoint. Each entry maps an `ali-` prefixed proxy id to the upstream
 * model name and its capabilities.
 *
 * Add models here as they become relevant — the /v1/models endpoint can
 * auto-discover everything, but this map provides capability metadata
 * (context_window, max_output, vision, thinking) needed for routing.
 */
export const ALI_MODEL_MAP: Record<string, {
  upstream: string;
  context_window: number;
  max_output: number;
  thinking: boolean;
  vision: boolean;
  creditRate: number;
}> = {
  // ── Qwen family ──────────────────────────────────────────────────
  "ali-qwen-turbo":           { upstream: "qwen-turbo",           context_window: 1000000,  max_output: 8192,  thinking: false, vision: false, creditRate: 0.0005 },
  "ali-qwen-plus":            { upstream: "qwen-plus",            context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.002 },
  "ali-qwen-plus-latest":     { upstream: "qwen-plus-latest",     context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.002 },
  "ali-qwen-plus-2025-07-14": { upstream: "qwen-plus-2025-07-14", context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.002 },
  "ali-qwen-max":             { upstream: "qwen-max",             context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.004 },
  "ali-qvq-max":              { upstream: "qvq-max",              context_window: 1000000,  max_output: 8192,  thinking: true,  vision: true,  creditRate: 0.004 },
  "ali-qwq-plus":             { upstream: "qwq-plus",             context_window: 1000000,  max_output: 8192,  thinking: true,  vision: false, creditRate: 0.003 },
  "ali-qwen-flash":           { upstream: "qwen-flash",           context_window: 1000000,  max_output: 8192,  thinking: false, vision: false, creditRate: 0.0003 },

  // ── Qwen 3.x family ──────────────────────────────────────────────
  "ali-qwen3-max":            { upstream: "qwen3-max",            context_window: 1000000,  max_output: 32768, thinking: true,  vision: true,  creditRate: 0.005 },
  "ali-qwen3-max-preview":    { upstream: "qwen3-max-preview",    context_window: 1000000,  max_output: 32768, thinking: true,  vision: true,  creditRate: 0.005 },
  "ali-qwen3.5-flash":        { upstream: "qwen3.5-flash",        context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.0003 },
  "ali-qwen3.5-plus":         { upstream: "qwen3.5-plus",         context_window: 1000000,  max_output: 32768, thinking: false, vision: true,  creditRate: 0.003 },
  "ali-qwen3.6-flash":        { upstream: "qwen3.6-flash",        context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.0003 },
  "ali-qwen3.6-plus":         { upstream: "qwen3.6-plus",         context_window: 1000000,  max_output: 32768, thinking: false, vision: true,  creditRate: 0.003 },
  "ali-qwen3.7-max":          { upstream: "qwen3.7-max",          context_window: 1000000,  max_output: 32768, thinking: true,  vision: true,  creditRate: 0.006 },
  "ali-qwen3.7-plus":         { upstream: "qwen3.7-plus",         context_window: 1000000,  max_output: 32768, thinking: true,  vision: true,  creditRate: 0.004 },

  // ── Coder models ─────────────────────────────────────────────────
  "ali-qwen-coder-plus":      { upstream: "qwen-coder-plus",      context_window: 1000000,  max_output: 8192,  thinking: false, vision: false, creditRate: 0.002 },
  "ali-qwen3-coder-plus":     { upstream: "qwen3-coder-plus",     context_window: 1000000,  max_output: 32768, thinking: true,  vision: false, creditRate: 0.003 },
  "ali-qwen3-coder-flash":    { upstream: "qwen3-coder-flash",    context_window: 1000000,  max_output: 8192,  thinking: false, vision: false, creditRate: 0.0003 },
  "ali-qwen3-coder-next":     { upstream: "qwen3-coder-next",     context_window: 1000000,  max_output: 32768, thinking: false, vision: false, creditRate: 0.001 },

  // ── Vision models ────────────────────────────────────────────────
  "ali-qwen-vl-plus":         { upstream: "qwen-vl-plus",         context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.003 },
  "ali-qwen-vl-max":          { upstream: "qwen-vl-max",          context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.005 },
  "ali-qwen3-vl-plus":        { upstream: "qwen3-vl-plus",        context_window: 1000000,  max_output: 32768, thinking: false, vision: true,  creditRate: 0.003 },
  "ali-qwen3-vl-flash":       { upstream: "qwen3-vl-flash",       context_window: 1000000,  max_output: 8192,  thinking: false, vision: true,  creditRate: 0.0005 },

  // ── Third-party models (via DashScope marketplace) ───────────────
  "ali-deepseek-v4-flash":    { upstream: "deepseek-v4-flash",    context_window: 1000000,  max_output: 8192,  thinking: true,  vision: true,  creditRate: 0.002 },
  "ali-deepseek-v4-pro":      { upstream: "deepseek-v4-pro",      context_window: 1000000,  max_output: 32768, thinking: true,  vision: true,  creditRate: 0.003 },
  "ali-deepseek-v3.2":        { upstream: "deepseek-v3.2",        context_window: 1000000,  max_output: 8192,  thinking: false, vision: false, creditRate: 0.001 },
  "ali-kimi-k2.7-code":       { upstream: "kimi-k2.7-code",       context_window: 256000,   max_output: 8192,  thinking: false, vision: false, creditRate: 0.003 },
  "ali-glm-5.2":              { upstream: "glm-5.2",              context_window: 1000000,  max_output: 8192,  thinking: true,  vision: true,  creditRate: 0.002 },
  "ali-glm-5.1":              { upstream: "glm-5.1",              context_window: 200000,   max_output: 8192,  thinking: true,  vision: true,  creditRate: 0.002 },

  // ── Image generation ─────────────────────────────────────────────
  "ali-qwen-image-max":       { upstream: "qwen-image-max",       context_window: 0,        max_output: 0,     thinking: false, vision: false, creditRate: 0.01 },
  "ali-qwen-image-plus":      { upstream: "qwen-image-plus",      context_window: 0,        max_output: 0,     thinking: false, vision: false, creditRate: 0.005 },
};

/**
 * Per-model quota data stored in the account's `tokens` JSON column.
 */
export interface AlibabaQuotaTokens {
  modelQuotas: Record<string, {
    limit: number;
    remaining: number;
    periodDays: number;
    resetAt: string | null;
  }>;
  /** Models this account can successfully query (verified by probe). */
  queryableModels?: string[];
  updatedAt: string;
}

/**
 * Quota limit per model as reported by /api/v1/quotas.
 * Populated lazily during healthCheck/fetchQuota.
 *
 * Map<upstream_model_name, { limit: number, periodDays: number }>
 */
export type QuotaLimitEntry = { limit: number; periodDays: number };
export const quotaLimitCache = new Map<string, QuotaLimitEntry>();
let quotaCacheExpiry = 0;
export const QUOTA_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Alibaba DashScope Provider — API key based, OpenAI-compatible.
 *
 * Account storage:
 * - provider: "alibaba"
 * - email: label (user-defined, e.g. "alibaba-key1")
 * - password: encrypted API key (XOR + base64)
 * - tokens: null (not needed — static API key)
 *
 * Model routing via `ali-` prefix.
 */
