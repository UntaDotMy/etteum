export function isInvalidModelError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("invalid_model_id") ||
    normalized.includes("invalid_model") ||
    normalized.includes("invalid model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("no such model") ||
    normalized.includes("unknown model") ||
    normalized.includes("model does not exist") ||
    normalized.includes("model is not supported") ||
    normalized.includes("model not supported") ||
    normalized.includes("unsupported model") ||
    normalized.includes("does not support model") ||
    normalized.includes("does not support the model") ||
    normalized.includes("model is not available") ||
    normalized.includes("model not available") ||
    // Prefix used by GrokProvider.classifyError for non-account model failures
    normalized.includes("invalid_model:")
  );
}

export function isBadUpstreamRequest(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("improperly formed request") ||
    normalized.includes("unsupported parameter")
  );
}

/**
 * Detect content moderation / content safety rejections from ANY upstream provider.
 *
 * This is the GLOBAL safety net: when any provider rejects a request because
 * the input content triggered their content safety scanner, the error must be
 * classified as "this request is bad, not the account". The router then throws
 * immediately instead of retrying other accounts and marking them as error.
 *
 * Covers:
 *   - Alibaba DashScope: data_inspection_failed, inappropriate content
 *   - AWS Bedrock / Kiro: content_filter, sensitive content
 *   - CodeBuddy: content policy, safety filter
 *   - Anthropic direct: content_filter
 *   - Generic: any 400 with content/moderation/safety/policy keywords
 */
export function isContentModerationError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    // -- Generic patterns (all providers) --
    // Use the lowercased `normalized` form for all Latin-script checks so
    // mixed-case upstream messages (e.g. "Content moderation: ...") are caught.
    // CJK substrings are case-insensitive by definition; kept on `error`
    // to avoid any re-encoding surprises, Latin ones use `normalized`.
    normalized.includes("content_filter") ||
    normalized.includes("content filter") ||
    normalized.includes("content moderation") ||
    normalized.includes("content policy") ||
    normalized.includes("content safety") ||
    normalized.includes("safety filter") ||
    normalized.includes("safety_policy") ||
    normalized.includes("safety policy") ||
    normalized.includes("flagged as potentially sensitive") ||
    // ── Chinese-language moderation (Alibaba, Baidu, etc.) ────────────
    error.includes("敏感内容") ||
    error.includes("内容审核") ||
    error.includes("内容安全") ||
    error.includes("系统检测到") ||
    normalized.includes("sensitive content") ||
    // ── Alibaba DashScope specific ────────────────────────────────────
    normalized.includes("data_inspection_failed") ||
    normalized.includes("datainspectionfailed") ||
    normalized.includes("inappropriate content") ||
    normalized.includes("data inspection failed") ||
    // ── AWS Bedrock / Kiro ───────────────────────────────────────────
    normalized.includes("input is not allowed") ||
    normalized.includes("input was filtered") ||
    normalized.includes("blocked by content") ||
    normalized.includes("content policy violation") ||
    // ── CodeBuddy / Tencent ──────────────────────────────────────────
    normalized.includes("content security") ||
    normalized.includes("text contains sensitive") ||
    // ── Generic HTTP 400 content rejections ──────────────────────────
    // Catch "HTTP 400: ...content..." patterns from any provider
    (normalized.includes("400") && (
      normalized.includes("content") ||
      normalized.includes("moderation") ||
      normalized.includes("safety") ||
      normalized.includes("inspection") ||
      normalized.includes("policy") ||
      normalized.includes("inappropriate") ||
      normalized.includes("blocked") ||
      normalized.includes("filter")
    ))
  );
}

/**
 * Errors that are caused by the request content itself, not the account.
 * These should NOT be retried with different accounts since the same content
 * will trigger the same error regardless of which account is used.
 *
 * GLOBAL: applies to all providers. The router throws immediately on these
 * instead of calling pool.markError() or pool.markExhausted().
 */
export function isNonAccountRequestError(error?: string): boolean {
  if (!error) return false;
  return (
    isInvalidModelError(error) ||
    isContentModerationError(error) ||
    isBadUpstreamRequest(error)
  );
}

/**
 * Hard infrastructure connect failure (same host for all accounts of a provider).
 * Retrying the same credential or walking the whole fleet pays multi-second
 * TCP/TLS timeouts without improving odds — fail-fast instead.
 *
 * Live Grok example: `cli-chat-proxy error 503: upstream connect error...
 * Connection refused` / `delayed connect error`.
 */
export function isHardConnectFailure(error?: string): boolean {
  if (!error) return false;
  const n = error.toLowerCase();
  return (
    n.includes("connection refused") ||
    n.includes("econnrefused") ||
    n.includes("upstream connect") ||
    n.includes("delayed connect") ||
    n.includes("transport failure") ||
    n.includes("connect error") ||
    (n.includes("503") &&
      (n.includes("connect") || n.includes("refused") || n.includes("reset before headers")))
  );
}

/**
 * Grok/xAI Build "Access denied" (HTTP 403 body) — permanent for that credential
 * on cli-chat-proxy, not a temporary rate limit and not a dead refresh token.
 */
export function isAccessDeniedForbidden(error?: string): boolean {
  if (!error) return false;
  const n = error.toLowerCase();
  return (
    n.includes("access denied") ||
    (n.includes("403") && n.includes("access denied")) ||
    n.includes("permission-denied") ||
    n.includes("chat endpoint is denied")
  );
}

/**
 * Transient errors that are temporary and should not permanently mark an account as errored.
 * These include network issues, timeouts, rate limits, upstream server errors,
 * and bad-request errors that are caused by the request format (not the account).
 * Account stays "active" but error is logged.
 *
 * GLOBAL: applies to all providers.
 */
export function isTransientError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    // Network / connectivity
    normalized.includes("timeout") ||
    normalized.includes("etimedout") ||
    normalized.includes("request timeout") ||
    normalized.includes("network error") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("socket hang up") ||
    normalized.includes("fetch failed") ||
    normalized.includes("dns") ||
    normalized.includes("connection") ||
    normalized.includes("aborted") ||
    normalized.includes("eai again") ||
    normalized.includes("temporary failure") ||
    // Upstream server errors (not account-specific)
    // Match bare "503" / "error 503:" as well as "(503)" — Grok cli-chat-proxy
    // formats as `cli-chat-proxy error 503: ...` without parentheses.
    normalized.includes("(500)") ||
    normalized.includes("(502)") ||
    normalized.includes("(503)") ||
    normalized.includes("(504)") ||
    /\berror\s+50[0-4]\b/.test(normalized) ||
    (/\b50[0-4]\b/.test(normalized) &&
      (normalized.includes("upstream") ||
        normalized.includes("gateway") ||
        normalized.includes("unavailable") ||
        normalized.includes("connect"))) ||
    normalized.includes("internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable") ||
    normalized.includes("gateway timeout") ||
    // Rate limiting (temporary)
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("(429)") ||
    // Bad request format (not account issue — request content caused it)
    normalized.includes("parse message failed") ||
    normalized.includes("invalid request") ||
    // HTTP status codes in any format: "(400)", "HTTP 400:", "status 400", etc.
    // Previously only matched "(400)" which missed "HTTP 400:" (Alibaba format).
    normalized.includes("(400)") ||
    normalized.includes("http 400") ||
    // Stream errors (temporary)
    normalized.includes("stream error") ||
    normalized.includes("stream read timeout") ||
    normalized.includes("stream failed")
  );
}
