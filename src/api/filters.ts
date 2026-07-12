import { Hono } from "hono";
import { db } from "../db/index";
import { filterRules } from "../db/schema";
import { eq, asc, sql } from "drizzle-orm";
import { invalidateFilterCache } from "../proxy/filter-cache";
import { validateFilterRule } from "../proxy/filter-safety";
import { broadcast } from "../ws/index";

export const filtersRouter = new Hono();

filtersRouter.get("/", async (c) => {
  const rules = await db.select().from(filterRules).orderBy(asc(filterRules.sortOrder));
  return c.json({ count: rules.length, activeCount: rules.filter((r) => r.isActive).length, rules });
});

filtersRouter.post("/", async (c) => {
  const body = await c.req.json<{
    pattern: string;
    replacement?: string;
    isRegex?: boolean;
    isActive?: boolean;
    ruleId?: string;
  }>();
  const safety = validateFilterRule({
    pattern: body.pattern,
    replacement: body.replacement ?? "",
    isRegex: body.isRegex,
  });
  if (!safety.ok) {
    return c.json({ error: safety.error }, 400);
  }

  const [maxRow] = await db
    .select({ maxOrder: sql<number>`COALESCE(MAX(${filterRules.sortOrder}), 0)` })
    .from(filterRules);

  const ruleId = body.ruleId?.trim() || `rule_${crypto.randomUUID().slice(0, 8)}`;

  const [created] = await db
    .insert(filterRules)
    .values({
      ruleId,
      pattern: body.pattern.trim(),
      // Strip-only: force empty even if a client sent whitespace.
      replacement: "",
      isRegex: Boolean(body.isRegex),
      isActive: body.isActive !== false,
      sortOrder: Number(maxRow?.maxOrder || 0) + 1,
    })
    .returning();

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });
  return c.json(created, 201);
});

filtersRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    pattern?: string;
    replacement?: string;
    isRegex?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  }>();

  const [existing] = await db.select().from(filterRules).where(eq(filterRules.id, id)).limit(1);
  if (!existing) return c.json({ error: "Not found" }, 404);

  // Only re-validate when content fields change (toggle-only PATCH stays allowed).
  const contentTouched =
    typeof body.pattern === "string" ||
    typeof body.replacement === "string" ||
    typeof body.isRegex === "boolean";
  if (contentTouched) {
    const safety = validateFilterRule({
      pattern: typeof body.pattern === "string" ? body.pattern : existing.pattern,
      replacement: typeof body.replacement === "string" ? body.replacement : existing.replacement,
      isRegex: typeof body.isRegex === "boolean" ? body.isRegex : existing.isRegex,
    });
    if (!safety.ok) {
      return c.json({ error: safety.error }, 400);
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.pattern === "string") updates.pattern = body.pattern.trim();
  if (typeof body.replacement === "string") updates.replacement = ""; // strip-only
  if (typeof body.isRegex === "boolean") updates.isRegex = body.isRegex;
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;
  if (typeof body.sortOrder === "number") updates.sortOrder = body.sortOrder;

  const [updated] = await db
    .update(filterRules)
    .set(updates)
    .where(eq(filterRules.id, id))
    .returning();

  if (!updated) return c.json({ error: "Not found" }, 404);

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });
  return c.json(updated);
});

/** DELETE /api/filters/inactive/all — drop every disabled rule (must be before /:id). */
filtersRouter.delete("/inactive/all", async (c) => {
  const result = await db
    .delete(filterRules)
    .where(eq(filterRules.isActive, false))
    .returning({ id: filterRules.id, ruleId: filterRules.ruleId });
  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: { purgedInactive: result.length } });
  return c.json({ success: true, deleted: result.length, rules: result });
});

filtersRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
  const result = await db.delete(filterRules).where(eq(filterRules.id, id)).returning();
  if (result.length === 0) return c.json({ error: "Not found" }, 404);

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });
  return c.json({ success: true });
});
