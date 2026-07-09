/**
 * Safe JSON parsing for LLM-generated content.
 *
 * LLMs frequently emit tool call arguments with Windows paths containing
 * backslashes that aren't properly JSON-escaped (`C:\Users\...` instead of
 * `C:\\Users\\...`). Standard `JSON.parse()` either rejects these with
 * "Invalid escape character" or silently corrupts them (e.g. `\t` → tab,
 * `\n` → newline, `\b` → backspace).
 *
 * `safeJsonParse()` pre-escapes lone backslashes in string values before
 * handing it to `JSON.parse()`. The only backslash pairs left unmodified are
 * `\\` (already-escaped) and `\"` (string delimiter) — all other backslashes
 * are doubled because in LLM tool-call output they almost certainly represent
 * literal path separators, not intentional control characters.
 */

/**
 * Parse a JSON string that may contain unescaped backslashes (e.g. Windows
 * paths). If the standard `JSON.parse()` succeeds, the result is returned
 * directly. If it fails, backslashes in string values are pre-escaped and
 * parsing is retried.
 *
 * Returns `fallback` (default `undefined`) if both attempts fail.
 */
export function safeJsonParse<T = any>(json: string, fallback?: T): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch {
    // Try pre-escaping lone backslashes inside string values.
    const fixed = escapeJsonBackslashes(json);
    if (fixed !== json) {
      try {
        return JSON.parse(fixed) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

/**
 * Double every backslash inside JSON string values UNLESS it is already part
 * of `\\` (escaped literal backslash) or `\"` (escaped quote delimiter).
 *
 * This is NOT a full JSON tokenizer — it scans character-by-character
 * tracking whether we're inside a string value.
 *
 * Why NOT keep valid JSON escapes like \n, \t, \r?
 * Because in LLM tool call output, `C:\Users\riezh\node_modules\test` has
 * `\n` and `\t` that the LLM intended as literal path separators, NOT as
 * newline/tab. The chance the LLM intentionally wanted a newline inside a
 * Bash command argument is essentially zero — these ARE Windows paths.
 */
function escapeJsonBackslashes(json: string): string {
  let out = "";
  let inString = false;
  let stringDelimiter = "";

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;

    if (inString) {
      if (ch === "\\") {
        const next = json[i + 1];
        // Only leave \\ (already escaped) and \" (string delimiter) alone.
        // Everything else (including \n, \t, \r, \b, \f, \/, \uXXXX) is
        // doubled because in LLM output these are Windows path separators.
        if (next === "\\" || next === stringDelimiter) {
          out += "\\";
        } else {
          out += "\\\\";
        }
        continue;
      } else if (ch === stringDelimiter) {
        inString = false;
        stringDelimiter = "";
        out += ch;
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
        stringDelimiter = '"';
      }
      out += ch;
    }
  }

  return out;
}
