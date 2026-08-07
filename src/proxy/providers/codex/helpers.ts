/** codex helpers (auth, crypto, transforms). */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import { config } from "../../../config";
import { applyModelSpecs } from "../../model-specs";

export interface CodexTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: string | number;
  email?: string;
  account_id?: string;
  method?: string;
}

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/**
 * Live model catalog endpoint (the same one the Codex CLI queries). Returns
 * `{ models: [...] }` (or `{ data: [...] }`) of the slugs this ChatGPT account
 * may actually use. client_version mirrors the CLI (see makeRequest UA).
 */
export const CODEX_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models?client_version=1.0.18";

/**
 * Parse an upstream 429 reset hint into a Date / ms pair. Codex returns either
 * a `Retry-After` header (seconds) or a JSON body with `reset_at`/`resets_at`
 * (epoch seconds or ms). Returns undefineds if no usable hint was found, in
 * which case the pool applies a default 60s cooldown.
 */
export function parseRateLimitReset(headers: Headers, bodyText: string): { resetsAt?: Date; retryAfterMs?: number } {
  const retryAfterHdr = headers.get("retry-after");
  if (retryAfterHdr) {
    const secs = Number(retryAfterHdr);
    if (Number.isFinite(secs) && secs > 0) {
      const retryAfterMs = secs * 1000;
      return { retryAfterMs, resetsAt: new Date(Date.now() + retryAfterMs) };
    }
  }
  try {
    const j = JSON.parse(bodyText || "{}");
    const ra = j?.reset_at ?? j?.resets_at ?? j?.error?.reset_at;
    if (ra) {
      const epoch = Number(ra);
      if (Number.isFinite(epoch)) {
        return { resetsAt: new Date(epoch > 1e12 ? epoch : epoch * 1000) };
      }
    }
  } catch { /* body wasn't JSON */ }
  return {};
}
export const CODEX_SCOPE = "openid profile email offline_access";

// --- Codex request sanitization (1:1 with the reference codex executor) ---
// Server-generated item id prefixes that /responses can't resolve with store=false.
export const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;
// Hosted tool types Codex/OpenAI Responses executes server-side. Non-function
// tools outside this set + the passthrough set are dropped.
export const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search",
]);
// Responses-native freeform tools carry a name + format payload and pass intact.
export const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

/** Strip server-generated item references from body.input (store=false). */
export function stripStoredItemReferences(input: unknown[]): unknown[] {
  if (!Array.isArray(input)) return input;
  return input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if (obj.type === "item_reference") return false;
      if (typeof obj.id === "string" && SERVER_ID_PATTERN.test(obj.id)) delete obj.id;
    }
    return true;
  });
}

/**
 * Parsed Codex usage — the credit model codex-lb uses. See parseCodexUsage.
 */
export interface CodexUsage {
  planType: string;
  /** 0-100. Primary window (rolling ~5h). */
  primaryUsedPercent: number;
  /** 0-100. Secondary window (rolling ~weekly). This is the hard ceiling. */
  secondaryUsedPercent: number;
  rateLimited: boolean;
  resetAt: Date | null;
  primaryResetAt: Date | null;
  secondaryResetAt: Date | null;
  /** Pay-as-you-go credits, if the account has any. */
  credits: { hasCredits: boolean; unlimited: boolean; balance: number };
  /** Extra rate-limit resets granted when a window fills (rare). */
  rateLimitResetCredits: { availableCount: number };
  /** Per-model additional limits (e.g. Codex-Spark), keyed by model name. */
  additionalRateLimits: Record<string, { usedPercent: number; resetAt: Date | null }>;
  /** Normalized for the proxy's quota snapshot. limit=100 (percent scale). */
  limit: number;
  used: number;
  remaining: number;
  /** True when credit-override keeps the account usable despite a full window. */
  creditOverrideActive: boolean;
}

/**
 * Parse a `wham/usage` JSON payload into the Codex credit model. Pure: no I/O,
 * never throws. Field names verified against codex-lb (Soju06/codex-lb) and the
 * Codex CLI's own usage check.
 *
 * Credit-override rule (the key fix vs. the old impl): an account counts as
 * having capacity when EITHER a rate window has headroom OR it has credits
 * (`unlimited` | `has_credits` | `balance > 0`). The old code marked the
 * account exhausted as soon as `remaining <= 0`, benching credit-backed
 * accounts that were still perfectly usable.
 */
export function parseCodexUsage(data: any): CodexUsage {
  const rl = data?.rate_limit || {};
  const primary = rl.primary_window || {};
  const secondary = rl.secondary_window || {};
  const credits = data?.credits || {};

  const primaryUsedPercent = Number(primary.used_percent ?? 0);
  const secondaryUsedPercent = Number(secondary.used_percent ?? 0);
  const rateLimited = Boolean(rl.limit_reached);

  const toDate = (v: any): Date | null =>
    v ? new Date(Number(v) * 1000) : null;
  const primaryResetAt = toDate(primary.reset_at);
  const secondaryResetAt = toDate(secondary.reset_at);
  // Prefer the window that resets soonest among those that are full; else the
  // primary reset. Used as the snapshot's resetAt.
  const resetAt = primaryResetAt;

  const hasCredits = Boolean(credits.has_credits);
  const unlimited = Boolean(credits.unlimited);
  const balance = Number(credits.balance ?? 0);

  const rlrc = data?.rate_limit_reset_credits || {};
  const availableCount = Number(rlrc.available_count ?? 0);

  const additional: Record<string, { usedPercent: number; resetAt: Date | null }> = {};
  const addl = data?.additional_rate_limits;
  if (addl && typeof addl === "object") {
    for (const [model, info] of Object.entries(addl)) {
      const i = (info || {}) as any;
      additional[model] = {
        usedPercent: Number(i.used_percent ?? 0),
        resetAt: toDate(i.reset_at),
      };
    }
  }

  // The secondary window is the hard ceiling. Credit-override: if it's full
  // but the account has credits, the account is still usable.
  const secondaryFull = secondaryUsedPercent >= 100 || rateLimited;
  const creditOverrideActive = secondaryFull && (unlimited || hasCredits || balance > 0 || availableCount > 0);

  // Normalized to a 100-point percent scale (the natural Codex unit).
  const limit = 100;
  const used = Math.min(100, Math.round(secondaryUsedPercent));
  const remaining = creditOverrideActive ? 100 : Math.max(0, limit - used);

  return {
    planType: String(data?.plan_type || ""),
    primaryUsedPercent,
    secondaryUsedPercent,
    rateLimited,
    resetAt,
    primaryResetAt,
    secondaryResetAt,
    credits: { hasCredits, unlimited, balance },
    rateLimitResetCredits: { availableCount },
    additionalRateLimits: additional,
    limit,
    used,
    remaining,
    creditOverrideActive,
  };
}

// Model map: proxy-facing `codex-*` ids → real Codex backend slugs.
// Fetched live 2026-07-03 from https://chatgpt.com/backend-api/codex/models
// ?client_version=1.0.18 (the same endpoint the Codex CLI uses). The backend
// currently exposes exactly FOUR slugs: gpt-5.5, gpt-5.4, gpt-5.4-mini,
// codex-auto-review — all 272k context, all vision-capable, all supporting
// reasoning levels low/medium/high/xhigh. Older slugs (gpt-5.3-codex, gpt-5.2,
// gpt-5.5-xhigh as a *model*) no longer exist and 400 on ChatGPT accounts.
//
// Note: "xhigh" is a REASONING LEVEL on gpt-5.5, not a separate model. Clients
// that send `gpt-5.5-xhigh` are aliased to gpt-5.5 (the proxy sets reasoning
// effort via the request, not the model name).
export const codexModelMap: Record<string, string> = {
  // Default fallback — newest frontier model, verified working on ChatGPT accounts.
  "codex-auto": "gpt-5.5",
  // Real models (live-fetched).
  "codex-gpt-5.5": "gpt-5.5",
  "gpt-5.5": "gpt-5.5",
  "codex-gpt-5.4": "gpt-5.4",
  "gpt-5.4": "gpt-5.4",
  "codex-gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "codex-auto-review": "codex-auto-review",
  // Legacy aliases — these slugs no longer exist upstream; remap to gpt-5.5 so
  // old configs/clients keep working instead of 400ing.
  "codex-gpt-5.5-xhigh": "gpt-5.5",
  "gpt-5.5-xhigh": "gpt-5.5",
  "codex-gpt-5.3": "gpt-5.5",
  "codex-gpt-5.3-codex": "gpt-5.5",
  "gpt-5.3-codex": "gpt-5.5",
  "codex-gpt-5.2": "gpt-5.5",
  "gpt-5.2": "gpt-5.5",
  "gpt-5-codex": "gpt-5.5",
};

export interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface CodexReasoningConfig {
  effort?: string;
  summary?: "auto" | "detailed";
}

