/**
 * Combo CRUD API: GET /api/combos, POST, PATCH, DELETE.
 * Strategy config (fallback/sticky/fusion) is stored in the settings table
 * under key "combo_strategies" as JSON.
 */

import { Hono } from "hono";
import { getAllCombos, getComboByName, createCombo, updateCombo, deleteCombo, toggleCombo } from "../proxy/combo";

export const combosRouter = new Hono();

combosRouter.get("/", async (c) => {
  const combos = await getAllCombos();
  return c.json({ combos });
});

combosRouter.get("/:name", async (c) => {
  const combo = await getComboByName(c.req.param("name"));
  if (!combo) return c.json({ error: "Combo not found" }, 404);
  return c.json({ combo });
});

combosRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; models: string[] }>();
  if (!body.name || !Array.isArray(body.models)) {
    return c.json({ error: "name and models[] are required" }, 400);
  }
  const existing = await getComboByName(body.name);
  if (existing) return c.json({ error: "Combo already exists" }, 409);

  const combo = await createCombo(body.name, body.models);
  return c.json({ combo }, 201);
});

combosRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ models?: string[]; enabled?: boolean }>();
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  if (body.models !== undefined) {
    const updated = await updateCombo(id, body.models);
    if (!updated) return c.json({ error: "Combo not found" }, 404);
    return c.json({ combo: updated });
  }
  if (body.enabled !== undefined) {
    await toggleCombo(id, body.enabled);
    return c.json({ ok: true });
  }
  return c.json({ error: "No valid fields to update" }, 400);
});

combosRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  await deleteCombo(id);
  return c.json({ ok: true });
});
