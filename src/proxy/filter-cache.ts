import { db } from "../db/index";
import { filterRules, type FilterRule } from "../db/schema";
import { asc, eq } from "drizzle-orm";

/** Hot-path cache: active rules only (inactive rows are purged / never applied). */
let cache: FilterRule[] = [];

export async function loadFilterCache(): Promise<void> {
  cache = await db
    .select()
    .from(filterRules)
    .where(eq(filterRules.isActive, true))
    .orderBy(asc(filterRules.sortOrder));
}

export function getFilterRulesCached(): FilterRule[] {
  return cache;
}

export function invalidateFilterCache(): void {
  loadFilterCache().catch((e) => console.error("[FilterCache] reload failed", e));
}
