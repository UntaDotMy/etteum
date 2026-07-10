/**
 * Safe JSON parsing for LLM-generated content.
 *
 * LLMs frequently emit tool call arguments with Windows paths containing
 * backslashes that aren't properly JSON-escaped (`C:\Users\...` instead of
 * `C:\\Users\\...`). Standard `JSON.parse()` either rejects these with
 * "Invalid escape character" or silently corrupts them (e.g. `\t` → tab,
 * `\n` → newline, `\b` → backspace).
 *
 * Strategy (two-pass):
 *   1. Try `JSON.parse()` first. If the JSON is already valid (including
 *      legitimate escapes like `\n` for newlines in scripts), return the
 *      parsed result as-is.
 *   2. On failure, pre-escape ALL lone backslashes (doubling them) and
 *      retry. This handles unescaped Windows paths like `C:\Users\...`.
 *
 * Why not always pre-escape? Valid JSON escapes like `\n`, `\t`, `\r` are
 * commonly used by LLMs to embed newlines/tabs in scripts, but they also
 * appear in Windows paths (`C:\test\node`). The two-pass approach correctly
 * handles both cases: valid JSON passes through untouched; invalid JSON gets
 * the brute-force backslash-doubling treatment.
 */

/**
 * Parse a JSON string that may contain unescaped backslashes (e.g. Windows
 * paths). Two-pass: try direct parse first, fall back to backslash-doubling.
 */
export function safeJsonParse<T = any>(json: string, fallback?: T): T | undefined {
  // Pass 1: try direct parse. Valid JSON with legitimate escapes (e.g. \n
  // for newlines in scripts) works correctly here.
  try {
    return JSON.parse(json) as T;
  } catch {
    // Pass 2: pre-escape lone backslashes and retry. Handles Windows paths
    // where the LLM emitted C:\Users instead of C:\\Users.
  }
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
 * Called only on the fallback pass when the initial `JSON.parse()` threw
 * due to invalid escape sequences like `\U`, `\H`, `\P` in `C:\Users\HP\...`.
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
        if (next === "\\" || next === stringDelimiter) {
          out += ch + next;
          i++; // consume the next character
        } else {
          // Not part of a valid escape pair — LLM meant this as a literal
          // backslash (Windows path separator). Double it.
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
