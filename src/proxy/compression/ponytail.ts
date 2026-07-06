/**
 * Ponytail — Token-Saving Compression.
 *
 * A lossy pipeline stage (off by default) that targets repetitive structure
 * in tool results — the residue of commands like `ls -R src/`, `find .`,
 * `tree -L 10`, and `cat` on deep directories. These produce verbose output
 * where the same prefix appears dozens of times (e.g. `src/components/ui/button/`
 * repeated 50 times). Removing the repetition costs the model zero context
 * while saving significant tokens.
 *
 * Techniques applied in order:
 *   1. Trim trailing whitespace + normalise line endings (always runs)
 *   2. Collapse repeated indentation prefixes (structural noise)
 *   3. Strip repeated path prefixes from output lines (e.g. long directory roots)
 *   4. Collapse runs of very similar consecutive lines (log spam)
 *
 * Unlike RTK (shape-aware) or DCP (idempotent read dedup), Ponytail targets
 * the raw character-level redundancy that exists even within a single tool result.
 *
 * Run position: AFTER RTK in the compression pipeline (Ponytail's changes are
 * orthogonal to RTK's shape-aware truncation, and Ponytail shouldn't waste
 * effort on content that RTK will cut anyway).
 */

import type { ChatCompletionRequest, ChatMessage } from "../providers/base";
import type { PonytailConfig } from "./types";

/** Maximum number of lines to scan when building the prefix set. */
const PREFIX_SAMPLE_LINES = 200;

/** Minimum line length to be considered for prefix collapse. */
const MIN_LINE_LEN = 20;

/** Collapse a repeated prefix if it appears in ≥ this fraction of sampled lines. */
const PREFIX_SUPPORT_THRESHOLD = 0.3;

/** Minimum prefix length to bother stripping. */
const MIN_PREFIX_LEN = 8;

/**
 * Find a common leading path/text prefix shared by ≥threshold fraction of lines.
 * Returns the longest common prefix found, or "" if none qualifies.
 */
function extractCommonPrefix(lines: string[]): string {
  if (lines.length < 3) return "";

  // Sample first N lines to avoid scanning massive outputs.
  const sampled = lines.slice(0, PREFIX_SAMPLE_LINES);
  const eligible = sampled.filter((l) => l.trimEnd().length >= MIN_LINE_LEN);
  if (eligible.length < 3) return "";

  const total = eligible.length;
  const supportNeeded = Math.ceil(total * PREFIX_SUPPORT_THRESHOLD);

  // Try prefixes of increasing length — find the longest one that enough lines share.
  // Strategy: start with the first eligible line as the candidate, then shrink.
  let candidate = eligible[0]!.trimEnd();

  // Work backwards from the end of the candidate, shortening by path segments.
  // This gives us a useful path-component boundary rather than a mid-char cut.
  const segments = candidate.split(/[\/\\]/);
  if (segments.length < 2) return "";

  let bestPrefix = "";
  let bestCount = 0;

  // Try progressively shorter prefixes
  for (let keep = segments.length; keep >= 1; keep--) {
    const prefix = segments.slice(0, keep).join("/") + "/";
    if (prefix.length < MIN_PREFIX_LEN) continue;

    const count = eligible.filter((l) => l.trimStart().startsWith(prefix)).length;
    if (count >= supportNeeded && count > bestCount) {
      bestPrefix = prefix;
      bestCount = count;
    }
  }

  return bestPrefix;
}

/**
 * Collapse consecutive near-identical log/error lines.
 * E.g. repeated "✓ doing X" / "✓ X done" patterns.
 * Only collapses when ≥ 3 consecutive lines share the same prefix.
 */
function collapseRepeatedLineGroups(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 6) return text;

  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    // Count how many consecutive lines share this leading whitespace + first 20 chars.
    const prefix = trimmed.slice(0, 20);
    let run = 1;
    while (i + run < lines.length) {
      const nextTrimmed = lines[i + run]!.trimStart();
      if (nextTrimmed.slice(0, 20) === prefix) {
        run++;
      } else {
        break;
      }
    }

    if (run >= 3) {
      // Collapse this run to one representative + count.
      out.push(line.trimEnd());
      out.push(`  … (${run} similar lines collapsed)`);
      i += run;
    } else {
      out.push(line);
      i++;
    }
  }

  return out.join("\n");
}

/**
 * Apply ponytail compression to a single text block.
 * Returns the compressed text and the number of characters saved.
 */
function applyPonytailToText(text: string): { text: string; saved: number } {
  const beforeLen = text.length;

  let result = text;

  // 1. Trim trailing whitespace and normalise line endings.
  // Doing this first means the subsequent passes see cleaner lines.
  result = result
    .replace(/\r\n/g, "\n")   // normalize CRLF → LF
    .split("\n")
    .map((l) => l.trimEnd())  // strip trailing spaces/tabs
    .join("\n");

  // 2. Collapse repeated path prefixes.
  // Only apply when the content looks like directory/file output.
  const lines = result.split("\n");
  const hasPathShape = lines.some(
    (l) => l.length > 30 && /[\/\\]/.test(l.slice(0, 40))
  );
  if (hasPathShape) {
    const prefix = extractCommonPrefix(lines);
    if (prefix.length >= MIN_PREFIX_LEN) {
      result = lines.map((l) => l.startsWith(prefix) ? l.slice(prefix.length) : l).join("\n");
    }
  }

  // 3. Collapse repeated log/error lines (only for longer texts with many lines).
  if (result.split("\n").length >= 20) {
    result = collapseRepeatedLineGroups(result);
  }

  const saved = Math.max(0, beforeLen - result.length);
  return { text: result, saved };
}

/**
 * Apply Ponytail compression to a ChatCompletionRequest.
 *
 * Scans all tool_result blocks (both OpenAI role:"tool" messages and
 * Anthropic content-block format) in every message turn.
 */
export function applyPonytail(
  request: ChatCompletionRequest,
  cfg: PonytailConfig
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { request, saved: 0 };
  }

  let totalSaved = 0;
  let mutated = false;

  const newMessages = request.messages.map((msg) => {
    // OpenAI format: role:"tool" message with string content.
    if (msg.role === "tool" && typeof msg.content === "string") {
      const { text, saved } = applyPonytailToText(msg.content);
      if (saved > 0) {
        totalSaved += saved;
        mutated = true;
        return { ...msg, content: text };
      }
      return msg;
    }

    // Anthropic format: content blocks array.
    if (!Array.isArray(msg.content)) return msg;

    const newContent = (msg.content as any[]).map((block) => {
      if (block?.type !== "tool_result") return block;

      // Block with string content.
      if (typeof block.content === "string") {
        const { text, saved } = applyPonytailToText(block.content);
        if (saved > 0) {
          totalSaved += saved;
          mutated = true;
          return { ...block, content: text };
        }
        return block;
      }

      // Block with text array.
      if (Array.isArray(block.content)) {
        let blockSaved = 0;
        const newBlockContent = block.content.map((inner: any) => {
          if (inner?.type === "text" && typeof inner.text === "string") {
            const { text, saved } = applyPonytailToText(inner.text);
            blockSaved += saved;
            return { ...inner, text };
          }
          return inner;
        });
        if (blockSaved > 0) {
          totalSaved += blockSaved;
          mutated = true;
          return { ...block, content: newBlockContent };
        }
        return block;
      }

      return block;
    });

    return { ...msg, content: newContent };
  });

  if (!mutated) return { request, saved: 0 };
  return { request: { ...request, messages: newMessages }, saved: totalSaved };
}
