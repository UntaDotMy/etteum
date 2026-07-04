/**
 * Content filter system for removing patterns that trigger content moderation.
 * Based on enowxai's pudidil filter template system.
 *
 * General (one rule set for every provider). Only sanitization rules remain:
 *   - strip vendor telemetry (billing headers, cc_* hashes, claude-code GitHub
 *     URLs, cc_entrypoint / cc_version).
 *   - neutralize vendor identity boilerplate lines (feedback lines, "You are
 *     <vendor>" identity, Cursor/Windsurf/[AI-LAB-A]-CLI agent identity).
 *
 * IMPORTANT: there is NO brand-neutralization tier and NO word-rewrite tier.
 * Brand names (Claude, [AI-LAB-B], [AI-LAB-A], [AI-CHAT], [AI-LAB-C], [AI-LAB-D],
 * [AI-MODEL], [AI-LAB-E], ...) pass through VERBATIM. Common technical words
 * (terminate, access, modify, tool, device, threat, ...) also pass through
 * verbatim. Both tiers were removed because they mangled tool calls, code, file
 * paths, and tool results. The deactivated rules stay in the DB (is_active=false)
 * so they can be re-enabled per-provider from the dashboard; they are NOT in
 * this fallback const. Nothing in user content is dropped or rewritten.
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
