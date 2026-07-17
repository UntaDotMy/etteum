/**
 * Filter policy bootstrap (v3).
 *
 * Seeds sanitization-only rules on first boot, then permanently removes
 * legacy inactive tiers (word-rewrite + brand neutralization) that mangled
 * Claude Code / CLI tool calls if re-enabled from the dashboard.
 *
 * Policy key `filter_policy_v3` ensures the purge runs once per DB.
 */
import { db } from "./index";
import { filterRules, settings } from "./schema";
import { eq, inArray, sql } from "drizzle-orm";
import { PUDIDIL_FILTERS } from "../proxy/filters";
import { loadFilterCache } from "../proxy/filter-cache";

const POLICY_KEY = "filter_policy_v3";
const POLICY_VALUE = "applied";

// Bumped to _v4 to DELETE remove_cch_hash (see filters.ts): it stripped legitimate
// tool-call arguments (Grep/Glob `ch=abc123`, git hashes) — the "model goes dumb"
// corruption. Hard-delete from the DB, matching the source removal.
const POLICY_KEY_V4 = "filter_policy_v4";
const POLICY_VALUE_V4 = "applied";
const CCH_RULE_ID = "remove_cch_hash";

/** Hard-deleted: broken / over-broad regex rules. */
const PURGE_RULE_IDS = [
  "remove_claude_code_identity_variations",
  "remove_cline_identity",
  "remove_ai_coding_agent_pattern",
  "remove_mcp_server_ref",
  "remove_powered_by_anthropic",
  "remove_claude_code_mention",
] as const;

async function getSetting(key: string): Promise<string | null> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function setSetting(key: string, value: string): Promise<void> {
  const [existing] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (existing) {
    await db.update(settings).set({ value }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
}

/**
 * Seed defaults if empty, purge inactive/legacy rules once, reload cache.
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
    console.log(`[DB] Seeded ${PUDIDIL_FILTERS.length} filter rules (sanitization only)`);
  }

  const applied = await getSetting(POLICY_KEY);
  if (applied !== POLICY_VALUE) {
    // 1) Drop known-broken rule ids (if any leftover).
    await db
      .delete(filterRules)
      .where(inArray(filterRules.ruleId, [...PURGE_RULE_IDS]));

    // 2) Delete every inactive rule — user request: off rules are not needed
    //    and were a trap (word-rewrite / brand tiers broke CLI tool calls).
    const deleted = await db
      .delete(filterRules)
      .where(eq(filterRules.isActive, false))
      .returning({ id: filterRules.id });

    // Clear legacy v2 marker if present.
    await db.delete(settings).where(eq(settings.key, "filter_policy_v2"));
    await setSetting(POLICY_KEY, POLICY_VALUE);
    console.log(
      `[DB] Applied filter policy v3 — removed ${deleted.length} inactive rule(s)`,
    );
  } else {
    // Always scrub inactive rows that were re-disabled later so they don't pile up.
    const deleted = await db
      .delete(filterRules)
      .where(eq(filterRules.isActive, false))
      .returning({ id: filterRules.id });
    if (deleted.length > 0) {
      console.log(`[DB] Purged ${deleted.length} inactive filter rule(s)`);
    }
  }

  // One-time v4 migration: DELETE remove_cch_hash from existing DBs. It stripped
  // legitimate tool-call arguments (any `ch=<hex>` token — Grep/Glob patterns, git
  // hashes), silently corrupting tool calls and making the model look "dumb".
  const appliedV4 = await getSetting(POLICY_KEY_V4);
  if (appliedV4 !== POLICY_VALUE_V4) {
    const deleted = await db
      .delete(filterRules)
      .where(eq(filterRules.ruleId, CCH_RULE_ID))
      .returning({ id: filterRules.id });
    await setSetting(POLICY_KEY_V4, POLICY_VALUE_V4);
    if (deleted.length > 0) {
      console.log(`[DB] Applied filter policy v4 — removed ${CCH_RULE_ID} (tool-arg corruption)`);
    }
  }

  await loadFilterCache();
}
