import { Hono } from "hono";
import { db } from "../db/index";
import { proxyPool } from "../db/schema";
import { eq, desc, sql, inArray } from "drizzle-orm";
import {
  getNextProxy,
  markProxySuccess,
  markProxyFail,
  checkProxyHealth,
  invalidateProxyCache,
} from "../services/proxy-pool";
import {
  scrapeProxies,
  verifyProxies,
  COUNTRIES,
  type ScrapeSource,
  type ScrapeProtocol,
} from "../services/proxy-scraper";

export const proxyPoolRouter = new Hono();

proxyPoolRouter.get("/pool", async (c) => {
  const proxies = await db
    .select()
    .from(proxyPool)
    .orderBy(desc(proxyPool.createdAt));

  return c.json({
    count: proxies.length,
    activeCount: proxies.filter((p) => p.status === "active").length,
    proxies,
  });
});

proxyPoolRouter.post("/pool", async (c) => {
  const body = await c.req.json<{ proxies: string[] }>();
  if (!Array.isArray(body.proxies) || body.proxies.length === 0) {
    return c.json({ error: "proxies must be a non-empty array of URLs" }, 400);
  }

  let added = 0;
  for (const url of body.proxies) {
    const trimmed = url.trim();
    if (!trimmed) continue;

    const type = trimmed.startsWith("socks5://") ? "socks5" : "http";
    const label = new URL(trimmed).hostname || trimmed;

    await db.insert(proxyPool).values({ url: trimmed, type, label });
    added++;
  }

  invalidateProxyCache();
  return c.json({ added });
});

proxyPoolRouter.put("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status?: string; label?: string }>();

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.status) updates.status = body.status;
  if (body.label !== undefined) updates.label = body.label;

  await db.update(proxyPool).set(updates).where(eq(proxyPool.id, id));
  invalidateProxyCache();

  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(proxyPool).where(eq(proxyPool.id, id));
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool", async (c) => {
  await db.delete(proxyPool);
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.post("/pool/:id/check", async (c) => {
  const id = Number(c.req.param("id"));
  const [proxy] = await db.select().from(proxyPool).where(eq(proxyPool.id, id));
  if (!proxy) return c.json({ error: "Proxy not found" }, 404);

  const result = await checkProxyHealth(proxy.url);

  await db
    .update(proxyPool)
    .set({
      status: result.ok ? "active" : "error",
      errorMessage: result.error || null,
      latencyMs: result.latencyMs,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proxyPool.id, id));

  invalidateProxyCache();
  return c.json({ id, ...result });
});

proxyPoolRouter.post("/pool/check-all", async (c) => {
  const proxies = await db
    .select()
    .from(proxyPool)
    .where(eq(proxyPool.status, "active"));

  const results = await Promise.allSettled(
    proxies.map(async (proxy) => {
      const result = await checkProxyHealth(proxy.url);
      await db
        .update(proxyPool)
        .set({
          status: result.ok ? "active" : "error",
          errorMessage: result.error || null,
          latencyMs: result.latencyMs,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proxyPool.id, proxy.id));
      return { id: proxy.id, url: proxy.url, ...result };
    })
  );

  invalidateProxyCache();
  return c.json({
    checked: results.length,
    results: results.map((r) => (r.status === "fulfilled" ? r.value : { error: "check failed" })),
  });
});

// List the regions available for scraping (for the dashboard dropdown).
proxyPoolRouter.get("/scrape/countries", (c) => {
  return c.json({ countries: COUNTRIES });
});

// Scrape proxies from free sources, optionally filtered by region/protocol,
// optionally health-verified, then add the survivors to the pool.
proxyPoolRouter.post("/scrape", async (c) => {
  const body = await c.req.json<{
    source?: ScrapeSource;
    country?: string;
    protocol?: ScrapeProtocol;
    limit?: number;
    verify?: boolean;
  }>().catch(() => ({} as Record<string, never>));

  const source = (body.source ?? "all") as ScrapeSource;
  const country = body.country ?? "all";
  const protocol = (body.protocol ?? "all") as ScrapeProtocol;
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
  const verify = body.verify !== false; // verify by default

  let scraped = await scrapeProxies({ source, country, protocol, limit });
  const scrapedCount = scraped.length;

  if (scrapedCount === 0) {
    return c.json({ scraped: 0, verified: 0, added: 0, skipped: 0, proxies: [] });
  }

  // Health-check before adding so the pool only gets working proxies.
  let verifiedCount = scrapedCount;
  if (verify) {
    scraped = await verifyProxies(scraped);
    verifiedCount = scraped.length;
  }

  // Skip proxies already in the pool (dedupe by URL).
  const urls = scraped.map((p) => p.url);
  const existing =
    urls.length > 0
      ? await db
          .select({ url: proxyPool.url })
          .from(proxyPool)
          .where(inArray(proxyPool.url, urls))
      : [];
  const existingSet = new Set(existing.map((e) => e.url));

  const toInsert = scraped.filter((p) => !existingSet.has(p.url));
  if (toInsert.length > 0) {
    await db.insert(proxyPool).values(
      toInsert.map((p) => ({
        url: p.url,
        type: p.type,
        label: p.country ? `scraped:${p.country}` : "scraped",
      })),
    );
    invalidateProxyCache();
  }

  return c.json({
    scraped: scrapedCount,
    verified: verifiedCount,
    added: toInsert.length,
    skipped: verifiedCount - toInsert.length,
  });
});
