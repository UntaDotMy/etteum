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
 *   2. On failure, pre-escape ONLY the backslashes that aren't already part
 *      of a valid JSON escape, and retry. This handles unescaped Windows
 *      paths like `C:\Users\...` while leaving real `\n` newlines intact.
 *
 * Why not always pre-escape? Valid JSON escapes like `\n`, `\t`, `\r` are
 * commonly used by LLMs to embed newlines/tabs in scripts, but they also
 * appear in Windows paths (`C:\test\node`). The two-pass approach correctly
 * handles both cases: valid JSON passes through untouched; invalid JSON gets
 * the backslash-repair treatment — and crucially, the repair pass preserves
 * valid escapes (`\n`, `\t`, `\uXXXX`) so a PowerShell/cmd command mixing a
 * real newline with an unescaped `C:\Users` path isn't corrupted.
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
 * Double every INVALID-escape backslash inside JSON string values, leaving
 * valid JSON escapes intact.
 *
 * A backslash is kept verbatim (both chars) when it starts one of the seven
 * single-char escapes the JSON spec allows — `\\`, `\"`, `\/`, `\b`, `\f`,
 * `\n`, `\r`, `\t` — or a `\uXXXX` sequence with four hex digits. Every other
 * backslash (the `\U` / `\H` / `\P` in `C:\Users\HP\...`) is a literal Windows
 * path separator the LLM failed to escape, so it gets doubled.
 *
 * Edge case — trailing backslash: a `\` immediately before the closing quote
 * (`{"path":"C:\Users\"}`) looks like `\"`. If the string actually continues
 * after that quote (a structural char, or more text on the value side of a
 * `key":"value` split) it really is an escaped quote and is kept; otherwise
 * the `\` is a literal trailing backslash and gets doubled so the string can
 * close.
 *
 * This is NOT a full JSON tokenizer — it scans character-by-character
 * tracking whether we're inside a string value. Called only on the fallback
 * pass when the initial `JSON.parse()` threw.
 */
function escapeJsonBackslashes(json: string): string {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < json.length) {
    const ch = json[i]!;
    let next = i + 1; // default: advance one char

    if (inString) {
      if (ch === "\\") {
        const d = resolveBackslash(json, i);
        if (d.keep) {
          // Valid escape — emit the source sequence verbatim.
          out += json.slice(i, i + d.consume);
        } else {
          // Literal path separator — emit a doubled backslash, then (for a
          // `\X` pair) the following char so `C:\test` becomes `C:\\test`.
          out += "\\\\";
          if (d.consume === 2) out += json[i + 1];
        }
        next = i + d.consume;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }

    i = next;
  }

  return out;
}

/**
 * Resolve one backslash at `json[i]` (inside a string).
 *   consume = number of INPUT chars in the sequence: 2 for a `\X` pair
 *             (escaped quote, valid escape, or a `\t`-style ambiguous pair),
 *             1 for a lone backslash (invalid escape char or end-of-input).
 *   keep    = true  → valid JSON escape: emit the source verbatim.
 *             false → literal Windows path separator: emit a doubled backslash
 *             (plus the pair's second char when consume===2).
 */
function resolveBackslash(json: string, i: number): { consume: number; keep: boolean } {
  const next = json[i + 1];
  if (next === undefined) return { consume: 1, keep: false }; // lone trailing \
  if (next === "\\" || next === "/") return { consume: 2, keep: true };
  if (next === '"') {
    // Escaped quote when the string continues past it; literal trailing \ else.
    return { consume: 2, keep: stringContinuesAfterQuote(json, i + 2) };
  }
  if (next === "u" && isHex4(json, i + 2)) return { consume: 6, keep: true };
  // \n and \r are real newlines in scripts — but a `\n`/`\r` that starts a
  // Windows path segment (drive anchor `C:\new`, or space anchor `cd \new`)
  // is a literal separator. \t \b \f are far more often path segments
  // (\test \bin \file) than tabs/backspaces in a command, so they always
  // resolve to path separators (when one really is a tab, JSON.parse already
  // accepted it in Pass 1 and this repair never runs).
  if (next === "n" || next === "r") {
    return { consume: 2, keep: !isPathContext(json, i) };
  }
  // Everything else — invalid escapes (\U \H \P) and the path-heavy \t \b \f —
  // is a literal path separator. consume=2 keeps the pair's second char.
  return { consume: 2, keep: false };
}

/**
 * True when a `\n` or `\r` at `i` is actually the start of a Windows path
 * segment rather than a real newline. Two anchors:
 *   drive   — `C:\new` : the backslash directly follows a `<letter>:` prefix.
 *   segment — `cd \new` : the backslash directly follows a space (a fresh
 *             token) and is followed by a path char (letters / `_` / `-`).
 * Otherwise (`line1\nline2`, `Out-String\necho`) it's a real newline escape.
 */
function isPathContext(json: string, i: number): boolean {
  const prev = json[i - 1];
  const prev2 = json[i - 2];
  if (prev === ":" && prev2 !== undefined && /[a-zA-Z]/.test(prev2)) return true;
  if (prev === " " && /[a-zA-Z_-]/.test(json[i + 2] ?? "")) return true;
  return false;
}

/** True when json[pos..pos+3] is four hex digits (for `\uXXXX`). */
function isHex4(json: string, pos: number): boolean {
  for (let k = 0; k < 4; k++) {
    const c = json[pos + k];
    if (!c || !/[0-9a-fA-F]/.test(c)) return false;
  }
  return true;
}

/**
 * Decide whether a `"` at `afterQuote` (the index just past a `\"`) closes the
 * string or is an escaped quote with more string content to follow.
 *
 * The quote closes the string when the next non-space char is a JSON
 * structural delimiter: `,` `}` `]` `:` or end-of-input. Otherwise (another
 * `"` for an adjacent value in the common `key":"value` split, or any raw
 * text char) the string continues and the `\"` is a genuine escaped quote.
 */
function stringContinuesAfterQuote(json: string, afterQuote: number): boolean {
  let j = afterQuote;
  while (j < json.length && (json[j] === " " || json[j] === "\t")) j++;
  const c = json[j];
  if (c === undefined) return false; // quote closes at end of input
  if (c === "," || c === "}" || c === "]" || c === ":") return false;
  return true;
}
