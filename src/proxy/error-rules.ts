/**
 * Config-driven error classification rules (F12).
 *
 * Ported from the reference proxy open-sse/config/errorConfig.js (ERROR_RULES + BACKOFF_CONFIG
 * + NON_ACCOUNT_ERROR_TEXTS) + open-sse/services/accountFallback.js
 * (checkFallbackError, isNonAccountError).
 *
 * Replaces the scattered hardcoded predicates in errors.ts with a declarative
 * table that is (a) priority-ordered, (b) per-rule backoff/fallback flags, and
 * (c) extensible per-provider. The existing errors.ts functions are preserved
 * as the building blocks — this table classifies via them + adds config-driven
 * status-code + text rules on top.
 *
 * Rule shape mirrors reference ERROR_RULES:
 *   { id, match: (status?, error?) => boolean, kind: "nonAccount"|"transient"|"rateLimit"|"invalidModel"|"permanent", cooldownMs?, backoff? }
 */

export type ErrorKind = "nonAccount" | "transient" | "rateLimit" | "invalidModel" | "permanent";

export interface ErrorRule {
  id: string;
  /** Returns true when this rule matches the error. Checked top-to-bottom; first match wins. */
  match: (status: number | undefined, error: string | undefined) => boolean;
  kind: ErrorKind;
  /** Fixed cooldown (ms). Mutually exclusive with `backoff`. */
  cooldownMs?: number;
  /** Use exponential backoff by backoffLevel. Mutually exclusive with `cooldownMs`. */
  backoff?: boolean;
}

// --- Backoff config (mirrors reference BACKOFF_CONFIG, errorConfig.js:32-36) ---
export const BACKOFF_CONFIG = {
  initialMs: 2_000,
  maxMs: 5 * 60_000,
  /** Compute the delay for a given backoff level (0-indexed), doubling, capped. */
  delayFor(level: number): number {
    const d = this.initialMs * Math.pow(2, level);
    return Math.min(this.maxMs, d);
  },
};

// --- The rule table (priority-ordered; first match wins) ---
// Mirrors reference ERROR_RULES (errorConfig.js:59-76): text rules first
// (priority), then status rules. Each rule tags the error with a kind that
// the router uses to decide fallback/backoff/non-rotation.
export const ERROR_RULES: ErrorRule[] = [
  // 1. Non-account errors — request content caused the failure; NEVER rotate accounts.
  {
    id: "content-moderation",
    match: (_s, e) => isContentModerationErr(e),
    kind: "nonAccount",
  },
  {
    id: "invalid-model",
    match: (_s, e) => isInvalidModelErr(e),
    kind: "nonAccount",
  },
  {
    id: "bad-upstream-request",
    match: (_s, e) => isBadUpstreamErr(e),
    kind: "nonAccount",
  },
  // 2. Rate limiting — rotate to another account + cooldown the throttled one.
  {
    id: "rate-limit-429",
    match: (s, e) => s === 429 || !!e?.toLowerCase().includes("rate limit") || !!e?.toLowerCase().includes("too many requests"),
    kind: "rateLimit",
    backoff: true,
  },
  // 3. Auth-expired — refresh + retry (handled by the refresh coordinator).
  {
    id: "auth-expired-401",
    match: (s, e) => s === 401 || !!e?.toLowerCase().includes("expired") || !!e?.toLowerCase().includes("unauthorized"),
    kind: "transient",
    cooldownMs: 0, // retry immediately after refresh
  },
  // 4. Transient upstream/server errors — backoff + retry.
  {
    id: "transient-5xx",
    match: (s, e) => isTransientErr(s, e),
    kind: "transient",
    backoff: true,
  },
  // 5. Quota exhausted — mark account exhausted (not a hard error).
  {
    id: "quota-exhausted",
    match: (_s, e) => !!e?.toLowerCase().includes("quota") && !!e?.toLowerCase().includes("exceed"),
    kind: "permanent",
    cooldownMs: 60_000,
  },
  // 6. Banned/restricted — permanent account disable.
  {
    id: "banned",
    match: (_s, e) => !!e?.toLowerCase().includes("banned") || !!e?.toLowerCase().includes("suspended") || !!e?.toLowerCase().includes("restricted"),
    kind: "permanent",
  },
];

/** Classify an error via the rule table. Returns the first matching rule (or null). Mirrors reference checkFallbackError (accountFallback.js:46). */
export function classifyError(status: number | undefined, error: string | undefined): ErrorRule | null {
  for (const rule of ERROR_RULES) {
    try {
      if (rule.match(status, error)) return rule;
    } catch { /* a failing matcher shouldn't abort classification */ }
  }
  return null;
}

/** True for non-account errors (413, oversized-400s, content/moderation) — must NOT rotate. Mirrors reference isNonAccountError. */
export function isNonAccountError(status: number | undefined, error: string | undefined): boolean {
  if (status === 413) return true;
  const rule = classifyError(status, error);
  return rule?.kind === "nonAccount";
}

// --- Predicate helpers (ported from errors.ts so the table can reuse them) ---
// These mirror the existing errors.ts functions; kept here so error-rules.ts is
// self-contained and the table is the single source of truth.
function isInvalidModelErr(error?: string): boolean {
  if (!error) return false;
  const n = error.toLowerCase();
  return n.includes("invalid_model_id") || n.includes("invalid model") || n.includes("model_not_found") || n.includes("no such model") || n.includes("model is not supported") || n.includes("model not supported");
}
function isBadUpstreamErr(error?: string): boolean {
  if (!error) return false;
  const n = error.toLowerCase();
  return n.includes("improperly formed request") || n.includes("unsupported parameter");
}
function isContentModerationErr(error?: string): boolean {
  if (!error) return false;
  const n = error.toLowerCase();
  return n.includes("content_filter") || n.includes("content filter") || n.includes("content moderation") || n.includes("content policy") || n.includes("content safety") || n.includes("safety filter") || n.includes("safety_policy") || n.includes("safety policy") || n.includes("flagged as potentially sensitive") || n.includes("sensitive content") || n.includes("data_inspection_failed") || n.includes("datainspectionfailed") || n.includes("inappropriate content") || n.includes("data inspection failed") || n.includes("input is not allowed") || n.includes("input was filtered") || n.includes("blocked by content") || n.includes("content policy violation") || n.includes("content security") || n.includes("text contains sensitive") || error.includes("敏感内容") || error.includes("内容审核") || error.includes("内容安全") || error.includes("系统检测到");
}
function isTransientErr(status?: number, error?: string): boolean {
  if (status && (status === 500 || status === 502 || status === 503 || status === 504)) return true;
  if (!error) return false;
  const n = error.toLowerCase();
  return n.includes("timeout") || n.includes("etimedout") || n.includes("network error") || n.includes("econnreset") || n.includes("econnrefused") || n.includes("enotfound") || n.includes("socket hang up") || n.includes("fetch failed") || n.includes("dns") || n.includes("connection") || n.includes("aborted") || n.includes("eai again") || n.includes("temporary failure") || n.includes("(500)") || n.includes("(502)") || n.includes("(503)") || n.includes("(504)") || n.includes("internal server error") || n.includes("bad gateway") || n.includes("service unavailable") || n.includes("gateway timeout") || n.includes("stream error") || n.includes("stream read timeout") || n.includes("stream failed") || n.includes("server_is_overloaded") || n.includes("service_unavailable_error");
}
