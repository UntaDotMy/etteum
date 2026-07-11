/**
 * MITM API (F10) — exposes the MITM manager over HTTP.
 *
 * TS port of the reference proxy's /api/cli-tools/antigravity-mitm/* routes:
 *   GET    /api/mitm/status                  — running/cert/dns status
 *   POST   /api/mitm/start                   — generate CA + enable DNS + start server (body: {password?})
 *   POST   /api/mitm/stop                    — stop server (keep DNS)
 *   POST   /api/mitm/disable                 — stop server + strip DNS
 *   POST   /api/mitm/trust-cert              — install Root CA into OS trust store (body: {password?})
 *   POST   /api/mitm/enable-dns              — write vendor hosts → 127.0.0.1 (body: {password?})
 *   GET    /api/mitm/aliases                 — list tool→model aliases
 *   PUT    /api/mitm/aliases                 — set an alias {tool, model, target}
 *   DELETE /api/mitm/aliases                 — delete an alias {tool, model}
 */
import { Hono } from "hono";
import {
  getMitmStatus,
  startMitm,
  stopMitm,
  disableMitm,
  trustRootCA,
  enableDNS,
} from "../proxy/mitm/manager";
import { db } from "../db/index";
import { kv } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { adminGuardFromPeer, peerIpFromHonoContext } from "../utils/security";

export const mitmRouter = new Hono();

// Host-compromising operations (root-CA install, hosts-file rewrite, server
// start/stop) require local origin or a CLI admin token on top of the API
// key. A leaked API key alone must not be able to install a root CA or
// hijack vendor DNS remotely (OWASP API5:2023 / CWE-862).
function requireAdmin(c: any) {
  return adminGuardFromPeer(peerIpFromHonoContext(c), c.req.raw.headers, new URL(c.req.url).searchParams);
}

mitmRouter.get("/status", (c) => c.json(getMitmStatus()));

mitmRouter.post("/start", async (c) => {
  const guard = requireAdmin(c);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  const res = await startMitm(body.password);
  return c.json(res, res.ok ? 200 : 400);
});

mitmRouter.post("/stop", (c) => {
  const guard = requireAdmin(c);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  return c.json(stopMitm());
});

mitmRouter.post("/disable", (c) => {
  const guard = requireAdmin(c);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  return c.json(disableMitm());
});

mitmRouter.post("/trust-cert", async (c) => {
  const guard = requireAdmin(c);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  const res = trustRootCA(body.password);
  return c.json(res, res.ok ? 200 : 400);
});

mitmRouter.post("/enable-dns", async (c) => {
  const guard = requireAdmin(c);
  if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  const res = enableDNS(undefined, body.password);
  return c.json(res, res.ok ? 200 : 400);
});

// --- Alias CRUD (tool → real model) ---
mitmRouter.get("/aliases", async (c) => {
  const rows = await db.select().from(kv).where(eq(kv.scope, "mitmAlias"));
  const out: Record<string, any> = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return c.json({ aliases: out });
});

mitmRouter.put("/aliases", async (c) => {
  const body = await c.req.json<{ tool: string; model: string; target: string }>();
  if (!body.tool || !body.model || !body.target) {
    return c.json({ error: "tool, model, target required" }, 400);
  }
  const key = `${body.tool}:${body.model}`;
  const val = JSON.stringify(body.target);
  const [existing] = await db.select().from(kv).where(and(eq(kv.scope, "mitmAlias"), eq(kv.key, key))).limit(1);
  if (existing) {
    await db.update(kv).set({ value: val, updatedAt: new Date() }).where(and(eq(kv.scope, "mitmAlias"), eq(kv.key, key)));
  } else {
    await db.insert(kv).values({ scope: "mitmAlias", key, value: val, updatedAt: new Date() });
  }
  return c.json({ success: true });
});

mitmRouter.delete("/aliases", async (c) => {
  const body = await c.req.json<{ tool: string; model: string }>();
  const key = `${body.tool}:${body.model}`;
  await db.delete(kv).where(and(eq(kv.scope, "mitmAlias"), eq(kv.key, key)));
  return c.json({ success: true });
});
