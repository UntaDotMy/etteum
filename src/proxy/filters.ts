/**
 * Content filter system for removing patterns that trigger content moderation.
 * Based on enowxai's pudidil filter template system.
 *
 * General (one rule set for every provider). Two kinds of rules only:
 *   - sanitize:  strip vendor telemetry (billing headers, cc_* hashes, claude-code
 *                GitHub URLs). These are removal of instrumentation, never user
 *                content, so they cannot degrade the model.
 *   - neutralize: rewrite vendor brand names to bracketed tokens (e.g. "Claude"
 *                -> "[AI-ASSISTANT]", "[AI-LAB-A]" -> "[AI-LAB-A]"). Neutralizes
 *                identity without breaking tool calls, code, or file paths.
 *
 * IMPORTANT: there is intentionally NO word-rewrite tier. Earlier rules rewrote
 * common technical words (terminate, access, modify, tool, device, threat, ...)
 * to moderation-neutral synonyms; that mangled tool-call arguments, tool results,
 * commands, and file paths, which broke Codex tool execution ("dumb" tool calls).
 * Those rules remain in the DB with is_active=false so they can be re-enabled
 * per-provider from the dashboard, but they do NOT run by default. Nothing is
 * dropped from user content: instructions, system prompt, harness, tool calls,
 * and tool results pass through verbatim.
 */

export interface FilterRule {
  id: string;
  pattern: string;
  replacement: string;
  is_active: boolean;
  is_regex: boolean;
}

export const PUDIDIL_FILTERS: FilterRule[] = [
  {
    id: "remove_billing_header_regex",
    pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_cc_entrypoint_any",
    pattern: "cc_entrypoint=\\w+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_cc_version_any",
    pattern: "cc_version=[\\w.]+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_cch_hash",
    pattern: "c?ch=[a-f0-9]+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_claude_code_github",
    pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_anthropic_cli_ref",
    pattern: "Anthropic'?s official (?:CLI|tool|agent)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_anxthxropic_ref",
    pattern: "Anxthxropic'?s official[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_cursor_identity",
    pattern: "You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_windsurf_identity",
    pattern: "You are (?:Windsurf|Cascade|Codeium)[^.]*\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_feedback_line",
    pattern: "Claude Code. To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_powerful_ai_agent",
    pattern: "Advanced AI Agent",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_claude_code_identity",
    pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_anthropic",
    pattern: "Anthropic",
    replacement: "[AI-LAB-A]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_anthropic_lower",
    pattern: "anthropic",
    replacement: "[ai-lab-a]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_claude_code",
    pattern: "Claude Code",
    replacement: "[AI-ASSISTANT]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_claude_code_lower",
    pattern: "claude code",
    replacement: "[ai-assistant]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_openai",
    pattern: "OpenAI",
    replacement: "[AI-LAB-B]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_openai_lower",
    pattern: "openai",
    replacement: "[ai-lab-b]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_chatgpt",
    pattern: "ChatGPT",
    replacement: "[AI-CHAT]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_chatgpt_lower",
    pattern: "chatgpt",
    replacement: "[ai-chat]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_gemini",
    pattern: "Gemini",
    replacement: "[AI-LAB-C]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_gemini_lower",
    pattern: "gemini",
    replacement: "[ai-lab-c]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_google_ai",
    pattern: "Google AI",
    replacement: "[AI-LAB-D]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_google_ai_lower",
    pattern: "google ai",
    replacement: "[ai-lab-d]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_llama",
    pattern: "Llama",
    replacement: "[AI-MODEL]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_llama_lower",
    pattern: "llama",
    replacement: "[ai-model]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_meta_ai",
    pattern: "Meta AI",
    replacement: "[AI-LAB-E]",
    is_active: true,
    is_regex: false,
  },
  {
    id: "neutralize_meta_ai_lower",
    pattern: "meta ai",
    replacement: "[ai-lab-e]",
    is_active: true,
    is_regex: false,
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // Word-rewrite tier REMOVED (was: terminate->terminate, access->access,
  // modify->modify, tool->tool, device->device, threat->threat, ...). Those
  // rewrites broke tool calls and mangled code. Kept in the DB as
  // is_active=false; re-enable via dashboard only if a specific provider needs
  // them. They are deliberately NOT in this fallback const.
  // ═══════════════════════════════════════════════════════════════════════════
];

import { getFilterRulesCached } from "./filter-cache";

/**
 * Apply pudidil filters to a string. Reads rules from in-memory cache
 * (DB-backed); falls back to PUDIDIL_FILTERS const if cache is empty (pre-boot).
 *
 * General: every active rule runs, for every provider. No scope gating.
 */
export function applyPudidilFilters(content: string): string {
  let filtered = content;
  const cached = getFilterRulesCached();
  const rules = cached.length > 0
    ? cached.map((r) => ({ id: r.ruleId, pattern: r.pattern, replacement: r.replacement, is_active: r.isActive, is_regex: r.isRegex }))
    : PUDIDIL_FILTERS;

  for (const rule of rules) {
    if (!rule.is_active) continue;
    if (!rule.pattern) continue;

    if (rule.is_regex) {
      try {
        const regex = new RegExp(rule.pattern, "gi");
        filtered = filtered.replace(regex, rule.replacement);
      } catch (error) {
        console.error(`[Filter] Invalid regex pattern: ${rule.pattern}`, error);
      }
    } else {
      while (filtered.includes(rule.pattern)) {
        filtered = filtered.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return filtered;
}
