import { describe, expect, test, beforeAll } from "bun:test";
import { db } from "../../src/db/index";
import { settings } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { bootstrapCompressionSettings } from "../../src/db/compression-bootstrap";

describe("bootstrapCompressionSettings v1", () => {
  beforeAll(async () => {
    try {
      await db.select({ c: sql`1` }).from(settings).limit(1);
    } catch {
      /* empty */
    }
  });

  test("clamps pathological max_tool_chars below UI floor", async () => {
    // Simulate the live bug (150 chars).
    async function upsert(key: string, value: string) {
      const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
      if (row) {
        await db.update(settings).set({ value }).where(eq(settings.key, key));
      } else {
        await db.insert(settings).values({ key, value });
      }
    }
    await upsert("compression_rtk_max_tool_chars", "150");
    await upsert("compression_rtk_keep_last_n_turns_full", "1");
    await db.delete(settings).where(eq(settings.key, "compression_policy_v1"));

    await bootstrapCompressionSettings();

    const [maxRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "compression_rtk_max_tool_chars"))
      .limit(1);
    const [keepRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "compression_rtk_keep_last_n_turns_full"))
      .limit(1);
    const [policy] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "compression_policy_v1"))
      .limit(1);

    expect(Number(maxRow?.value)).toBeGreaterThanOrEqual(500);
    // Clamped to SAFE_MAX = DEFAULT_COMPRESSION_CONFIG.rtk.maxToolChars (4000).
    expect(Number(maxRow?.value)).toBe(4000);
    expect(Number(keepRow?.value)).toBeGreaterThanOrEqual(4);
    expect(policy?.value).toBe("applied");
  });

  test("is idempotent when values are already safe", async () => {
    await bootstrapCompressionSettings();
    await bootstrapCompressionSettings();
    const [policy] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "compression_policy_v1"))
      .limit(1);
    expect(policy?.value).toBe("applied");
  });
});
