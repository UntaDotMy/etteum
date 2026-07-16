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
  // 2. Credit/quota exhaustion — MUST outrank bare 429/rate-limit.
  //    Grok/xAI returns HTTP 429 + code "subscription:free-usage-exhausted"
  //    when free Build credits are gone; that is exhaustion, not a short throttle.
  {
    id: "quota-exhausted",
    match: (s, e) => {
      if (s === 402) return true;
      if (!e) return false;
      const n = e.toLowerCase();
      return (
        n.includes("free-usage-exhausted") ||
        n.includes("spending-limit") ||
        n.includes("spending_limit") ||
        n.includes("quota_exhausted") ||
        n.includes("quota exhausted") ||
        n.includes("usage exhausted") ||
        (n.includes("quota") && n.includes("exceed")) ||
        n.includes("you've used all") ||
        n.includes("you have used all") ||
        n.includes("payment required") ||
        n.includes("insufficient credit") ||
        n.includes("out of credits") ||
        n.includes("no remaining credits")
      );
    },
    kind: "permanent",
    cooldownMs: 60_000,
  },
  // 3. Rate limiting — rotate to another account + cooldown the throttled one.
  //    Skip when the body is actually free-usage / credit exhaustion (rule 2).
  {
    id: "rate-limit-429",
    match: (s, e) => {
      const n = e?.toLowerCase() ?? "";
      if (
        n.includes("free-usage-exhausted") ||
        n.includes("spending-limit") ||
        n.includes("quota_exhausted") ||
        n.includes("you've used all")
      ) {
        return false;
      }
      return s === 429 || n.includes("rate limit") || n.includes("too many requests") || n.includes("rate_limited");
    },
    kind: "rateLimit",
    backoff: true,
  },
  // 4. Auth-expired — refresh + retry (handled by the refresh coordinator).
  {
    id: "auth-expired-401",
    match: (s, e) => s === 401 || !!e?.toLowerCase().includes("expired") || !!e?.toLowerCase().includes("unauthorized"),
    kind: "transient",
    cooldownMs: 0, // retry immediately after refresh
  },
  // 5. Transient upstream/server errors — backoff + retry.
  {
    id: "transient-5xx",
    match: (s, e) => isTransientErr(s, e),
    kind: "transient",
    backoff: true,
  },
  // 6. Banned/restricted / Build Access denied — permanent account disable.
  {
    id: "banned",
    match: (_s, e) => {
      const n = e?.toLowerCase() ?? "";
      return (
        n.includes("banned") ||
        n.includes("suspended") ||
        n.includes("restricted") ||
        n.includes("access denied") ||
        n.includes("permission-denied") ||
        n.includes("chat endpoint is denied")
      );
    },
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
  return (
    n.includes("invalid_model_id") ||
    n.includes("invalid_model") ||
    n.includes("invalid model") ||
    n.includes("model_not_found") ||
    n.includes("no such model") ||
    n.includes("unknown model") ||
    n.includes("model does not exist") ||
    n.includes("model is not supported") ||
    n.includes("model not supported") ||
    n.includes("unsupported model") ||
    n.includes("does not support model") ||
    n.includes("does not support the model") ||
    n.includes("model is not available") ||
    n.includes("model not available") ||
    n.includes("invalid_model:")
  );
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
