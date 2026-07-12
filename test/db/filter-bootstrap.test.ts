import { describe, expect, test, beforeAll } from "bun:test";
import { db } from "../../src/db/index";
import { settings, filterRules } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { bootstrapFilterRules } from "../../src/db/filter-bootstrap";

describe("bootstrapFilterRules v3", () => {
  beforeAll(async () => {
    try {
      await db.select({ c: sql`1` }).from(settings).limit(1);
    } catch {
      /* empty */
    }
  });

  test("is idempotent and purges inactive rules", async () => {
    await bootstrapFilterRules();
    await bootstrapFilterRules();

    const [policy] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "filter_policy_v3"))
      .limit(1);
    expect(policy?.value).toBe("applied");

    const inactive = await db
      .select()
      .from(filterRules)
      .where(eq(filterRules.isActive, false));
    expect(inactive.length).toBe(0);
  });

  test("active sanitization rules remain", async () => {
    await bootstrapFilterRules();
    const active = await db
      .select()
      .from(filterRules)
      .where(eq(filterRules.isActive, true));
    expect(active.length).toBeGreaterThan(0);
    const ids = new Set(active.map((r) => r.ruleId));
    // Telemetry strip must stay.
    expect(ids.has("remove_billing_header_regex") || ids.has("remove_cc_entrypoint_any")).toBe(true);
  });
});
