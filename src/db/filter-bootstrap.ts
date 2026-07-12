/**
 * One-shot filter policy bootstrap.
 *
 * Runs at most once per DB (settings key). Avoids re-deleting/re-disabling
 * dozens of filter rows on every process start.
 */
import { db } from "./index";
import { filterRules, settings } from "./schema";
import { eq, inArray, sql } from "drizzle-orm";
import { PUDIDIL_FILTERS } from "../proxy/filters";
import { loadFilterCache } from "../proxy/filter-cache";

const POLICY_KEY = "filter_policy_v2";
const POLICY_VALUE = "applied";

const PURGE_RULE_IDS = [
  "remove_claude_code_identity_variations",
  "remove_cline_identity",
  "remove_ai_coding_agent_pattern",
  "remove_mcp_server_ref",
  "remove_powered_by_anthropic",
  "remove_claude_code_mention",
] as const;

/** Word-rewrite tier — mangled tool args/paths; keep rows but disable. */
const DISABLE_WORD_REWRITE = [
  "neutralize_kill",
  "neutralize_kill_upper",
  "neutralize_kill_allcaps",
  "neutralize_exploit",
  "neutralize_exploit_upper",
  "neutralize_attack",
  "neutralize_attack_upper",
  "neutralize_attacker",
  "neutralize_attacker_upper",
  "neutralize_hack",
  "neutralize_hack_upper",
  "neutralize_weapon",
  "neutralize_weapon_upper",
  "neutralize_bomb",
  "neutralize_bomb_upper",
  "neutralize_terror",
  "neutralize_terror_upper",
  "neutralize_suicide",
  "neutralize_suicide_upper",
  "neutralize_violence",
  "neutralize_violence_upper",
  "neutralize_political",
  "neutralize_political_upper",
  "neutralize_kill_regex",
  "neutralize_exploit_regex",
  "neutralize_attack_regex",
  "neutralize_hack_regex",
] as const;

/** Brand neutralization — brand names must pass through verbatim. */
const DISABLE_BRAND_REWRITE = [
  "neutralize_anthropic",
  "neutralize_anthropic_lower",
  "neutralize_claude_code",
  "neutralize_claude_code_lower",
  "neutralize_openai",
  "neutralize_openai_lower",
  "neutralize_chatgpt",
  "neutralize_chatgpt_lower",
  "neutralize_gemini",
  "neutralize_gemini_lower",
  "neutralize_google_ai",
  "neutralize_google_ai_lower",
  "neutralize_llama",
  "neutralize_llama_lower",
  "neutralize_meta_ai",
  "neutralize_meta_ai_lower",
] as const;

async function policyAlreadyApplied(): Promise<boolean> {
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, POLICY_KEY))
      .limit(1);
    return row?.value === POLICY_VALUE;
  } catch {
    return false;
  }
}

async function markPolicyApplied(): Promise<void> {
  const [existing] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, POLICY_KEY))
    .limit(1);
  if (existing) {
    await db.update(settings).set({ value: POLICY_VALUE }).where(eq(settings.key, POLICY_KEY));
  } else {
    await db.insert(settings).values({ key: POLICY_KEY, value: POLICY_VALUE });
  }
}

/**
 * Seed defaults if empty, apply one-shot policy, always reload in-memory cache.
 */
export async function bootstrapFilterRules(): Promise<void> {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(filterRules);
  if (Number(row?.count || 0) === 0) {
    await db.insert(filterRules).values(
      PUDIDIL_FILTERS.map((r, i) => ({
        ruleId: r.id,
        pattern: r.pattern,
        replacement: r.replacement,
        isActive: r.is_active,
        isRegex: r.is_regex,
        sortOrder: i,
      })),
    );
    console.log(`[DB] Seeded ${PUDIDIL_FILTERS.length} filter rules`);
  }

  if (!(await policyAlreadyApplied())) {
    await db.delete(filterRules).where(inArray(filterRules.ruleId, [...PURGE_RULE_IDS]));
    await db
      .update(filterRules)
      .set({ isActive: false })
      .where(inArray(filterRules.ruleId, [...DISABLE_WORD_REWRITE]));
    await db
      .update(filterRules)
      .set({ isActive: false })
      .where(inArray(filterRules.ruleId, [...DISABLE_BRAND_REWRITE]));
    await markPolicyApplied();
    console.log("[DB] Applied filter policy v2 (purge + disable rewrite tiers)");
  }

  await loadFilterCache();
}
