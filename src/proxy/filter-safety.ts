/**
 * Filter rule safety — blocks word-rewrite / brand-neutralization rules that
 * mangled Claude Code / CLI tool args when re-enabled from the dashboard.
 *
 * Policy: custom filters are **strip-only** (empty replacement). Patterns must
 * be specific enough that they cannot match bare identifiers inside JSON tool
 * arguments (e.g. rejecting a lone "kill" or "modify").
 */

export interface FilterRuleInput {
  pattern: string;
  replacement?: string;
  isRegex?: boolean;
}

export type FilterSafetyResult =
  | { ok: true }
  | { ok: false; error: string };

/** UI + apply-path floor; shorter bare tokens almost always hit code/paths. */
const MIN_STRUCTURED_PATTERN_LEN = 8;
const MIN_BARE_PATTERN_LEN = 16;
const MAX_PATTERN_LEN = 4_000;

/**
 * Structured patterns (telemetry keys, URLs, multi-word identity lines) are OK
 * even when shorter. Bare single tokens are not.
 */
function looksStructured(pattern: string, isRegex: boolean): boolean {
  if (/\s/.test(pattern)) return true;
  if (/[=:/\\@#<>{}()[\],.|+]/.test(pattern)) return true;
  if (isRegex && /\\[bBdDsSwW]|[+*?{}()|[\]\\]/.test(pattern) && pattern.length >= MIN_STRUCTURED_PATTERN_LEN) {
    return true;
  }
  return false;
}

/**
 * Validate a create/update filter rule. Shared by API and dashboard.
 */
export function validateFilterRule(input: FilterRuleInput): FilterSafetyResult {
  const pattern = (input.pattern ?? "").trim();
  const replacement = input.replacement ?? "";
  const isRegex = Boolean(input.isRegex);

  if (!pattern) {
    return { ok: false, error: "pattern is required" };
  }
  if (pattern.length > MAX_PATTERN_LEN) {
    return { ok: false, error: `pattern too long (max ${MAX_PATTERN_LEN} chars)` };
  }

  // Strip-only: non-empty replacements are brand/word rewrites and break tools.
  if (replacement.trim().length > 0) {
    return {
      ok: false,
      error:
        "replacement must be empty (strip-only). Word-rewrite and brand-token " +
        "replacements break CLI tool calls and are not allowed",
    };
  }

  if (isRegex) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern, "gi");
    } catch (e) {
      return { ok: false, error: `Invalid regex: ${(e as Error).message}` };
    }
  }

  // Reject bare short tokens that would match inside shell commands / JSON args.
  if (!looksStructured(pattern, isRegex) && pattern.length < MIN_BARE_PATTERN_LEN) {
    return {
      ok: false,
      error:
        "pattern is too broad (bare short token). Use a multi-word phrase, " +
        "telemetry key (key=value), URL, or identity line so tool args stay intact",
    };
  }

  if (pattern.length < 3) {
    return { ok: false, error: "pattern is too short" };
  }

  return { ok: true };
}
