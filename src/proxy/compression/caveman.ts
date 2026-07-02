/**
 * Caveman — System Prompt Compaction.
 *
 * Three tiers of increasing aggressiveness; OFF by default because shrinking
 * a system prompt CAN change model behaviour. The transformation is purely
 * regex-based: no LLM call, no semantic rewrite.
 *
 *   lite:  strip filler words & politeness ("please", "you should", …).
 *          Sentences and structure preserved. Saves ~5-15%.
 *   full:  collapse multi-sentence narrative into bullet form, keep all
 *          domain content. Saves ~30-50%.
 *   ultra: telegraphic — drop articles, drop transitions, force imperative.
 *          Saves 50-70% but may degrade output quality.
 */

import type { ChatCompletionRequest } from "../providers/base";
import type { CavemanConfig } from "./types";

// ─── lite ────────────────────────────────────────────────────────────────
const LITE_PATTERNS: Array<[RegExp, string]> = [
  // Strip surface politeness.
  [/\b(please|kindly)\s+/gi, ""],
  [/\byou\s+(should|must|need to|have to|are expected to)\s+/gi, ""],
  [/\bit\s+is\s+important\s+(?:that|to)\s+/gi, ""],
  [/\bit\s+is\s+(?:also\s+)?(?:critical|essential|vital)\s+(?:that|to)\s+/gi, ""],
  [/\bmake sure (?:that |to )?/gi, ""],
  [/\bbe sure (?:that |to )?/gi, ""],
  [/\bdo not hesitate to\s+/gi, ""],
  [/\bfeel free to\s+/gi, ""],
  // Compress hedges.
  [/\b(?:as a matter of fact|in fact|actually|basically|essentially)\b,?\s*/gi, ""],
  [/\b(?:in order to)\b/gi, "to"],
  [/\b(?:due to the fact that|owing to the fact that)\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  // Collapse repeated whitespace produced by the substitutions above.
  [/[ \t]{2,}/g, " "],
  [/\n{3,}/g, "\n\n"],
];

// ─── full ────────────────────────────────────────────────────────────────
const FULL_PATTERNS: Array<[RegExp, string]> = [
  ...LITE_PATTERNS,
  // Drop narrative connectors.
  [/\b(furthermore|moreover|additionally|in addition|on the other hand|that being said|having said that),?\s*/gi, ""],
  // Strip "we recommend" / "we suggest" / "I suggest".
  [/\b(?:we|i)\s+(?:recommend|suggest|advise)\s+(?:that\s+)?/gi, ""],
  // Drop "the following …" lead-ins.
  [/\bthe following\s+/gi, ""],
  // Convert "When X happens, Y" -> "X: Y" only when the clause is short.
  [/\bwhen\s+([^,.\n]{3,40}),\s+/gi, "$1: "],
  // Convert "If X, then Y" -> "If X: Y"
  [/\bif\s+([^,.\n]{3,60}),\s+then\s+/gi, "if $1: "],
];

// ─── ultra ───────────────────────────────────────────────────────────────
const ULTRA_PATTERNS: Array<[RegExp, string]> = [
  ...FULL_PATTERNS,
  // Drop articles in command-like sentences (heuristic: standalone a/an/the).
  [/\b(a|an|the)\s+/gi, ""],
  // Drop modal helpers ("can", "may", "might").
  [/\b(?:you can|you may|you might|you could)\s+/gi, ""],
  // Force imperative: replace "X is required" with "X required".
  [/\b(is|are)\s+(required|forbidden|allowed|prohibited)\b/gi, "$2"],
  // Strip leading "Note that"/"Please note".
  [/\b(?:please\s+)?note that\s+/gi, ""],
];

function selectPatterns(level: CavemanConfig["level"]): Array<[RegExp, string]> {
  switch (level) {
    case "lite":
      return LITE_PATTERNS;
    case "full":
      return FULL_PATTERNS;
    case "ultra":
      return ULTRA_PATTERNS;
    default:
      return LITE_PATTERNS;
  }
}

export function compactText(text: string, level: CavemanConfig["level"]): string {
  const patterns = selectPatterns(level);
  let out = text;
  for (const [re, rep] of patterns) out = out.replace(re, rep);
  return out.trim();
}

/**
 * Apply caveman to system prompt only.
 * The system prompt may live in two places depending on the upstream client:
 *   - `request.system` (Anthropic Messages format)
 *   - first `role: "system"` message (OpenAI format)
 */
export function applyCaveman(
  request: ChatCompletionRequest,
  cfg: CavemanConfig
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };

  let saved = 0;
  let mutated = false;
  const next: any = { ...request };

  // Anthropic-style system field.
  const sys = (next as any).system;
  if (typeof sys === "string" && sys.length > 0) {
    const compacted = compactText(sys, cfg.level);
    saved += sys.length - compacted.length;
    next.system = compacted;
    mutated = true;
  } else if (Array.isArray(sys)) {
    next.system = sys.map((b: any) => {
      if (b?.type === "text" && typeof b.text === "string") {
        const compacted = compactText(b.text, cfg.level);
        saved += b.text.length - compacted.length;
        mutated = true;
        return { ...b, text: compacted };
      }
      return b;
    });
  }

  // OpenAI-style system messages.
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((msg: any) => {
      if (msg.role !== "system") return msg;
      if (typeof msg.content === "string") {
        const compacted = compactText(msg.content, cfg.level);
        saved += msg.content.length - compacted.length;
        mutated = true;
        return { ...msg, content: compacted };
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((b: any) => {
            if (b?.type === "text" && typeof b.text === "string") {
              const compacted = compactText(b.text, cfg.level);
              saved += b.text.length - compacted.length;
              mutated = true;
              return { ...b, text: compacted };
            }
            return b;
          }),
        };
      }
      return msg;
    });
  }

  if (!mutated) return { request, saved: 0 };
  return { request: next, saved: Math.max(0, saved) };
}
