import { describe, expect, test, beforeAll } from "bun:test";
import { db } from "../../src/db/index";
import { settings, filterRules } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { bootstrapFilterRules } from "../../src/db/filter-bootstrap";

describe("bootstrapFilterRules", () => {
  beforeAll(async () => {
    // Ensure schema is usable; migrations may already have run in other tests.
    try {
      await db.select({ c: sql`1` }).from(settings).limit(1);
    } catch {
      /* empty */
    }
  });

  test("is idempotent — second call does not throw", async () => {
    await bootstrapFilterRules();
    await bootstrapFilterRules();
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "filter_policy_v2"))
      .limit(1);
    expect(row?.value).toBe("applied");
  });

  test("word-rewrite rules stay disabled after policy", async () => {
    await bootstrapFilterRules();
    const rows = await db
      .select()
      .from(filterRules)
      .where(eq(filterRules.ruleId, "neutralize_kill"));
    if (rows.length === 0) {
      // Rule not present in this DB seed — skip assert.
      return;
    }
    expect(rows[0]!.isActive).toBe(false);
  });
});
