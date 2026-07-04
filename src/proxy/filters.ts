/**
 * Content filter system for removing patterns that trigger content moderation.
 * Based on enowxai's pudidil filter template system.
 *
 * Rules are ordered: broad regex patterns first, then exact string fallbacks.
 */

export interface FilterRule {
  id: string;
  pattern: string;
  replacement: string;
  is_active: boolean;
  is_regex: boolean;
}

export const PUDIDIL_FILTERS: FilterRule[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Broad regex rules FIRST — catch all variations before exact
  //          strings can partially match and leave fragments behind.
  // ═══════════════════════════════════════════════════════════════════════════

  // Catch full billing header lines (any version, any entrypoint)
  {
    id: "remove_billing_header_regex",
    pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Catch any cc_entrypoint variation (cli, gui, vscode, jetbrains, etc.)
  {
    id: "remove_cc_entrypoint_any",
    pattern: "cc_entrypoint=\\w+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Catch cc_version=X.Y.Z patterns (any version)
  {
    id: "remove_cc_version_any",
    pattern: "cc_version=[\\w.]+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Catch cch= and ch= hash patterns
  {
    id: "remove_cch_hash",
    pattern: "c?ch=[a-f0-9]+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove claude-code GitHub references (full URL with path)
  {
    id: "remove_claude_code_github",
    pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Claude Code identity variations (case-insensitive)

  // Remove Anthropic CLI references
  {
    id: "remove_anthropic_cli_ref",
    pattern: "Anthropic'?s official (?:CLI|tool|agent)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove "Anxthxropic" obfuscated references
  {
    id: "remove_anxthxropic_ref",
    pattern: "Anxthxropic'?s official[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Cursor agent identity
  {
    id: "remove_cursor_identity",
    pattern: "You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Windsurf/Codeium agent identity
  {
    id: "remove_windsurf_identity",
    pattern: "You are (?:Windsurf|Cascade|Codeium)[^.]*\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Cline agent identity

  // Remove generic "AI coding agent" patterns that may trigger moderation

  // Remove tool use framework identifiers (MCP, tool_use markers)

  // Remove "powered by Claude" / "powered by Anthropic" patterns

  // Replace Claude Code identity with neutral AI assistant
  {
    id: "replace_claude_code_identity",
    pattern: "You are Claude Code[,\\s]",
    replacement: "You are an AI assistant",
    is_active: true,
    is_regex: true,
  },
  // Replace Claude model family references with generic AI
  {
    id: "replace_claude_model_refs",
    pattern: "Claude (?:5|Opus|Sonnet|Haiku|Fable)",
    replacement: "AI",
    is_active: true,
    is_regex: true,
  },
  // Replace Claude Code availability with neutral term
  {
    id: "replace_claude_code_availability",
    pattern: "Claude Code is available",
    replacement: "This AI assistant is available",
    is_active: true,
    is_regex: true,
  },
  // Replace Fast mode for Claude with neutral term
  {
    id: "replace_fast_mode_claude",
    pattern: "Fast mode for Claude",
    replacement: "Fast mode for AI",
    is_active: true,
    is_regex: true,
  },
  // Replace claude.ai URLs with neutral placeholder
  {
    id: "replace_claude_ai_urls",
    pattern: "claude\\.ai",
    replacement: "ai-assistant.dev",
    is_active: true,
    is_regex: true,
  },
  // Replace .claude file paths with .agents
  {
    id: "replace_claude_paths",
    pattern: "\\.claude[/\\\\]",
    replacement: ".agents/",
    is_active: true,
    is_regex: true,
  },
  // Replace CLAUDE.md with agents.md
  {
    id: "replace_claude_md_refs",
    pattern: "CLAUDE\\.md",
    replacement: "agents.md",
    is_active: true,
    is_regex: true,
  },
  // Replace generic "Claude" with "AI"
  {
    id: "replace_claude_general",
    pattern: "\\bClaude\\b",
    replacement: "AI",
    is_active: true,
    is_regex: true,
  },
  // Replace "Anthropic" with "AI provider"
  {
    id: "replace_anthropic_general",
    pattern: "\\bAnthropic\\b",
    replacement: "AI provider",
    is_active: true,
    is_regex: true,
  },
  // Replace camelCase "claude" identifiers (claudeMd, claudeHome, etc.)
  {
    id: "replace_claude_camelcase",
    pattern: "claude([A-Z])",
    replacement: "agent$1",
    is_active: true,
    is_regex: true,
  },


  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Exact string rules — catch any remaining known literal patterns
  //          that survived the regex phase.
  // ═══════════════════════════════════════════════════════════════════════════

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
 * Apply pudidil filters to a string. Reads rules from in-memory cache (DB-backed).
 * Falls back to PUDIDIL_FILTERS const if cache is empty (pre-boot).
 */
export function applyPudidilFilters(content: string): string {
  let filtered = content;
  const cached = getFilterRulesCached();
  const rules = cached.length > 0
    ? cached.map((r) => ({ pattern: r.pattern, replacement: r.replacement, is_active: r.isActive, is_regex: r.isRegex }))
    : PUDIDIL_FILTERS;

  for (const rule of rules) {
    if (!rule.is_active) continue;

    if (rule.is_regex) {
      try {
        const regex = new RegExp(rule.pattern, "gi");
        filtered = filtered.replace(regex, rule.replacement);
      } catch (error) {
        console.error(`[Filter] Invalid regex pattern: ${rule.pattern}`, error);
      }
    } else {
      if (!rule.pattern) continue;
      while (filtered.includes(rule.pattern)) {
        filtered = filtered.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return filtered;
}
