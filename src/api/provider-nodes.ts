/**
 * Provider-nodes API (F13) — CRUD for dynamic compatible-node providers.
 *
 * TS port of the reference proxy /api/provider-nodes/* (create/validate/list/delete).
 * Lets the dashboard add user-defined OpenAI/Anthropic-compatible endpoints at
 * runtime; they're resolved by model prefix via the compatible-node registry.
 *
 *   GET    /api/provider-nodes           — list all nodes
 *   POST   /api/provider-nodes           — create a node { id, name, type, prefix, baseUrl, models, apiType? }
 *   PUT    /api/provider-nodes/:id       — update a node
 *   DELETE /api/provider-nodes/:id       — delete a node
 *   POST   /api/provider-nodes/validate  — validate a node config (dry-run)
 */
import { Hono } from "hono";
import { db } from "../db/index";
import { providerNodes } from "../db/schema";
import { eq } from "drizzle-orm";
import { compatibleNodeRegistry } from "../proxy/providers/compatible-node";
import type { CompatibleNodeType, CompatibleNodeData } from "../proxy/providers/compatible-node";

export const providerNodesRouter = new Hono();

interface NodeInput {
  id: string;
  name: string;
  type: CompatibleNodeType;
  prefix: string;
  baseUrl: string;
  models: string[];
  apiType?: "openai" | "anthropic";
  headers?: Record<string, string>;
  /** Optional node-level API key (bound as static credentials on the provider). */
  apiKey?: string;
}

function validateNode(input: Partial<NodeInput>): { ok: boolean; error?: string } {
  if (!input.id || typeof input.id !== "string") return { ok: false, error: "id required" };
  if (!input.name) return { ok: false, error: "name required" };
  if (!input.type || !["openai-compatible", "anthropic-compatible", "custom-embedding"].includes(input.type)) {
    return { ok: false, error: "type must be openai-compatible | anthropic-compatible | custom-embedding" };
  }
  if (!input.prefix) return { ok: false, error: "prefix required" };
  if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl)) return { ok: false, error: "baseUrl must be a valid http(s) URL" };
  if (!Array.isArray(input.models)) return { ok: false, error: "models must be an array" };
  return { ok: true };
}

providerNodesRouter.get("/", async (c) => {
  const rows = await db.select().from(providerNodes);
  return c.json({ nodes: rows });
});

providerNodesRouter.post("/", async (c) => {
  const input = await c.req.json<NodeInput>().catch(() => ({}) as NodeInput);
  const v = validateNode(input);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const data: CompatibleNodeData = {
    prefix: input.prefix,
    baseUrl: input.baseUrl,
    apiType: input.type === "anthropic-compatible" ? "anthropic" : (input.apiType || "openai"),
    models: input.models,
    headers: input.headers,
    apiKey: input.apiKey,
  };
  const [existing] = await db.select().from(providerNodes).where(eq(providerNodes.id, input.id)).limit(1);
  if (existing) return c.json({ error: "A node with that id already exists" }, 409);
  await db.insert(providerNodes).values({
    id: input.id,
    type: input.type,
    name: input.name,
    data: data as any,
  });
  await compatibleNodeRegistry.refresh();
  return c.json({ success: true, id: input.id }, 201);
});

providerNodesRouter.put("/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<Partial<NodeInput>>().catch(() => ({}) as Partial<NodeInput>);
  const [existing] = await db.select().from(providerNodes).where(eq(providerNodes.id, id)).limit(1);
  if (!existing) return c.json({ error: "Node not found" }, 404);
  const oldData = (typeof existing.data === "string" ? JSON.parse(existing.data) : existing.data) as CompatibleNodeData;
  const nextType = (input.type as CompatibleNodeType) ?? existing.type;
  const data: CompatibleNodeData = {
    prefix: input.prefix ?? oldData.prefix,
    baseUrl: input.baseUrl ?? oldData.baseUrl,
    apiType:
      nextType === "anthropic-compatible"
        ? "anthropic"
        : (input.apiType ?? oldData.apiType ?? "openai"),
    models: input.models ?? oldData.models,
    headers: input.headers ?? oldData.headers,
    // Keep previous apiKey when omitted so updates don't wipe credentials.
    apiKey: input.apiKey !== undefined ? input.apiKey : oldData.apiKey,
  };
  await db.update(providerNodes).set({
    name: input.name ?? existing.name,
    type: (input.type as CompatibleNodeType) ?? existing.type,
    data: data as any,
    updatedAt: new Date(),
  }).where(eq(providerNodes.id, id));
  await compatibleNodeRegistry.refresh();
  return c.json({ success: true });
});

providerNodesRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(providerNodes).where(eq(providerNodes.id, id));
  await compatibleNodeRegistry.refresh();
  return c.json({ success: true });
});

providerNodesRouter.post("/validate", async (c) => {
  const input = await c.req.json<NodeInput>().catch(() => ({}) as NodeInput);
  const v = validateNode(input);
  if (!v.ok) return c.json({ valid: false, error: v.error }, 400);
  return c.json({ valid: true });
});
