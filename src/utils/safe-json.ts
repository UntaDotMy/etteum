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
 * paths). Always pre-escapes lone backslashes before calling JSON.parse()
 * because valid JSON escapes like \n, \t, \b, \r, \f silently corrupt
 * Windows paths (e.g. C:\Users\test\nothing → C:\Users\test<LF>othing).
 *
 * In tool call arguments, the LLM meant backslashes as literal path
 * separators — they should never be interpreted as control characters.
 *
 * Used for all tool call argument parsing in the proxy.
 */
export function safeJsonParse<T = any>(json: string, fallback?: T): T | undefined {
  // Always pre-escape: \n, \t, \b, \r, \f are valid JSON escapes that
  // silently corrupt paths. Only \\ and \" pass through un-doubled.
  try {
    return JSON.parse(escapeJsonBackslashes(json)) as T;
  } catch {
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
        // \\ is an already-escaped literal backslash — keep both chars.
        // \" is an escaped quote — keep both chars.
        // Everything else is an LLM backslash meant literally (Windows path)
        // — double it so JSON.parse produces a single literal backslash.
        if (next === "\\" || next === stringDelimiter) {
          out += ch + next;
          i++; // consume the next character
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
