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
  /**
   * `structural` (default): telemetry/identity-removal safe to run for every
   *   provider (billing headers, cc_* hashes, claude-code GitHub URLs). Never
   *   mangles legitimate user content.
   * `identity`: over-broad rewrites (Claude->AI, CLAUDE.md->agents.md,
   *   claude([A-Z])->agent$1, ...) that exist ONLY to shield China providers'
   *   content moderation. Running these for non-China providers degrades the
   *   model (rewrites user code, docs, camelCase identifiers) for no benefit.
   */
  scope?: "structural" | "identity";
}

/** Filter scope requested by the caller. `undefined` = run every rule. */
export type FilterScope = "structural" | "identity" | undefined;

/**
 * Rule ids that belong to the "identity" tier (over-broad rewrites that only
 * China providers need). Kept as a set so DB-backed rules (which have no scope
 * column) can still be gated by id. Keep in sync with the `scope: "identity"`
 * tags on PUDIDIL_FILTERS below.
 */
const IDENTITY_RULE_IDS = new Set([
  "replace_claude_code_identity",
  "replace_claude_model_refs",
  "replace_claude_code_availability",
  "replace_fast_mode_claude",
  "replace_claude_ai_urls",
  "replace_claude_paths",
  "replace_claude_md_refs",
  "replace_claude_general",
  "replace_anthropic_general",
  "replace_claude_camelcase",
]);

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
     scope: "identity",
 },
  // Replace Claude model family references with generic AI
  {
    id: "replace_claude_model_refs",
    pattern: "Claude (?:5|Opus|Sonnet|Haiku|Fable)",
    replacement: "AI",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace Claude Code availability with neutral term
  {
    id: "replace_claude_code_availability",
    pattern: "Claude Code is available",
    replacement: "This AI assistant is available",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace Fast mode for Claude with neutral term
  {
    id: "replace_fast_mode_claude",
    pattern: "Fast mode for Claude",
    replacement: "Fast mode for AI",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace claude.ai URLs with neutral placeholder
  {
    id: "replace_claude_ai_urls",
    pattern: "claude\\.ai",
    replacement: "ai-assistant.dev",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace .claude file paths with .agents
  {
    id: "replace_claude_paths",
    pattern: "\\.claude[/\\\\]",
    replacement: ".agents/",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace CLAUDE.md with agents.md
  {
    id: "replace_claude_md_refs",
    pattern: "CLAUDE\\.md",
    replacement: "agents.md",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace generic "Claude" with "AI"
  {
    id: "replace_claude_general",
    pattern: "\\bClaude\\b",
    replacement: "AI",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace "Anthropic" with "AI provider"
  {
    id: "replace_anthropic_general",
    pattern: "\\bAnthropic\\b",
    replacement: "AI provider",
    is_active: true,
    is_regex: true,
     scope: "identity",
 },
  // Replace camelCase "claude" identifiers (claudeMd, claudeHome, etc.)
  {
    id: "replace_claude_camelcase",
    pattern: "claude([A-Z])",
    replacement: "agent$1",
    is_active: true,
    is_regex: true,
     scope: "identity",
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
export function applyPudidilFilters(content: string, scope: FilterScope = undefined): string {
  let filtered = content;
  const cached = getFilterRulesCached();
  const rules = cached.length > 0
    ? cached.map((r) => ({ id: r.ruleId, pattern: r.pattern, replacement: r.replacement, is_active: r.isActive, is_regex: r.isRegex, scope: (r as any).scope }))
    : PUDIDIL_FILTERS;

  for (const rule of rules) {
    if (!rule.is_active) continue;
    // Resolve the rule's effective scope: explicit scope wins, else derive
    // from the rule id (DB-backed rules have no scope column), else structural.
    const ruleScope = rule.scope ?? (rule.id && IDENTITY_RULE_IDS.has(rule.id) ? "identity" : "structural");
    // Scope gating: if a scope was requested, skip rules whose effective scope
    // does not match. Rules with no scope default to "structural" (run always).
    if (scope === "structural" && ruleScope === "identity") continue;
    if (scope === "identity" && ruleScope !== "identity") continue;

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
