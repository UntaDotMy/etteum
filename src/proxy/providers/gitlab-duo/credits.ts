/**
 * GitLab Duo — Per-call credit accounting.
 *
 * Source of truth: https://docs.gitlab.com/subscriptions/gitlab_credits/
 * (verified 2026-06-15 against gitlab-lsp 8.104.0).
 *
 * GitLab Duo bills per **LLM call**, not per user message:
 *   "one sent message counts as one or more billable requests, because one
 *    or more LLM calls are made to answer the question"
 *
 * The published rates use a "calls per credit" multiplier — e.g. Sonnet 4.6
 * is 2.0 calls/credit, meaning each LLM call costs 0.5 credits. This file
 * exposes the inverse (credits per call) so we can multiply by the number
 * of LLM calls observed in a single turn.
 *
 * For agentic workflows, one user request typically triggers a chain:
 *   plan → tool_call → interpret → tool_call → summarize  (~3-8 calls)
 * We count each `agent` message added to the workflow's `ui_chat_log` during
 * a single poolprox3 turn — that maps 1:1 with distinct LLM calls.
 *
 * NOTE: rates change occasionally as GitLab adjusts subsidies. Refresh this
 * table when GitLab publishes new multipliers. Unknown model → safe default
 * (Sonnet rate, ~0.5 credits/call) so we never silently bill at zero.
 */

/** Credit consumption per LLM call, indexed by model `ref` (the value GitLab
 *  uses on the wire — `claude_sonnet_4_6` etc.). Models with a long-context
 *  premium tier carry both `short` (≤272K input tokens) and `long` rates. */
export const CREDIT_PER_CALL_TABLE: Readonly<Record<string, { short: number; long?: number }>> = {
  // Claude — Haiku family
  claude_haiku_3:    { short: 1 / 8.0 },     // 0.125
  claude_haiku_3_5:  { short: 1 / 8.0 },     // 0.125
  claude_haiku_4_5:  { short: 1 / 6.7 },     // 0.149

  // Claude — Sonnet family (all 0.5/call)
  claude_sonnet_3_5: { short: 1 / 2.0 },
  claude_sonnet_3_7: { short: 1 / 2.0 },
  claude_sonnet_4:   { short: 1 / 2.0 },
  claude_sonnet_4_5: { short: 1 / 2.0 },
  claude_sonnet_4_6: { short: 1 / 2.0 },     // 0.500

  // Claude — Opus family
  claude_opus_4_5:   { short: 1 / 1.2 },     // 0.833
  claude_opus_4_6:   { short: 1 / 1.1 },     // 0.909
  claude_opus_4_7:   { short: 1 / 1.1 },
  claude_opus_4_8:   { short: 1 / 1.1 },

  // Other Anthropic
  claude_fable_5:    { short: 1 / 0.6 },     // 1.667

  // OpenAI — subsidized tier
  gpt_5_mini:        { short: 1 / 8.0 },     // 0.125
  gpt_5_4_nano:      { short: 1 / 8.0 },

  // OpenAI — premium tier
  gpt_5_4_mini:      { short: 1 / 6.7 },
  gpt_5:             { short: 1 / 3.3 },     // 0.303
  gpt_5_codex:       { short: 1 / 3.3 },
  gpt_5_2:           { short: 1 / 2.5 },     // 0.400
  gpt_5_2_codex:     { short: 1 / 2.5 },
  gpt_5_3_codex:     { short: 1 / 2.5 },

  // Long-context premium — `long` rate kicks in when input > 272K tokens.
  gpt_5_4:           { short: 1 / 2.0,  long: 1 / 1.11 },   // 0.500 / 0.901
  gpt_5_5:           { short: 1 / 1.0,  long: 1 / 0.57 },   // 1.000 / 1.754
};

/** Threshold at which long-context pricing kicks in (per GitLab docs). */
const LONG_CONTEXT_TOKEN_THRESHOLD = 272_000;

/** Conservative fallback — Sonnet rate (0.5). Mid-tier so we don't underbill
 *  Opus traffic or overbill Haiku traffic on unknown models. */
const DEFAULT_CREDITS_PER_CALL = 0.5;

/**
 * Look up credits-per-call for a given model + estimated context size.
 *
 * @param modelRef The wire-format model name as known to GitLab (e.g.
 *   `claude_sonnet_4_6`). Case-sensitive — must match the table key exactly.
 * @param contextTokens Estimated total input tokens for the request, used to
 *   pick the long-context tier on models that have one.
 * @returns Credits consumed by a single LLM call at this rate.
 */
export function creditsPerCall(modelRef: string, contextTokens: number): number {
  const entry = CREDIT_PER_CALL_TABLE[modelRef];
  if (!entry) return DEFAULT_CREDITS_PER_CALL;
  const isLong = contextTokens > LONG_CONTEXT_TOKEN_THRESHOLD;
  return isLong && entry.long !== undefined ? entry.long : entry.short;
}

/**
 * Count the number of `agent` messages appended to `ui_chat_log` during a
 * single poolprox3 turn — that's the number of distinct LLM calls.
 *
 * On a fresh workflow `baseline=0` so every agent message counts. On a
 * continuation turn (after a tool_use round-trip) `baseline` is set to the
 * agent-message count at the start of the continuation, so prior turns'
 * messages are correctly excluded.
 *
 * Floors at 1 — every turn that completed must have made ≥1 LLM call by
 * definition, even if we somehow miss an entry due to upstream re-ordering
 * or schema drift.
 */
export function countAgentCallsInTurn(
  uiChatLog: unknown[] | undefined | null,
  baseline: number,
): number {
  if (!Array.isArray(uiChatLog)) return 1;
  let seen = 0;
  let calls = 0;
  for (const m of uiChatLog) {
    if (!m || typeof m !== "object") continue;
    if ((m as { message_type?: string }).message_type === "agent") {
      if (seen >= baseline) calls++;
      seen++;
    }
  }
  return Math.max(1, calls);
}

/**
 * Convenience: total credits for a turn given the chat-log delta and model.
 *
 * @example
 *   const credits = totalCreditsForTurn(state.channel_values?.ui_chat_log,
 *                                       agentBaseline, modelRef, ctxTokens);
 *   // → 2.5 for a 5-call Sonnet turn
 */
export function totalCreditsForTurn(
  uiChatLog: unknown[] | undefined | null,
  baseline: number,
  modelRef: string,
  contextTokens: number,
): { calls: number; creditsPerCall: number; total: number } {
  const calls = countAgentCallsInTurn(uiChatLog, baseline);
  const rate = creditsPerCall(modelRef, contextTokens);
  return { calls, creditsPerCall: rate, total: calls * rate };
}
