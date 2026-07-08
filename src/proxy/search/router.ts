/**
 * Web search endpoint — TS port of the reference proxy's /v1/search.
 *
 *   POST /v1/search  { query, provider?, search_type?, max_results?, ... }
 *   GET  /v1/search/providers        — list dedicated search-API vendors
 *   GET  /v1/search/keys/:provider    — does this provider have a key set?
 *   PUT  /v1/search/keys/:provider   — set the API key (encrypted at rest)
 *
 * Two paths:
 *   1. Dedicated search-API providers (Brave/Exa/Tavily/Serper/Perplexity/
 *      Google PSE/Linkup/SearchAPI/You.com/SearXNG) — hit the real search API,
 *      return structured results. Set `provider` in the body to use one.
 *   2. LLM-summarized search (searchViaChat, the default when no `provider` is
 *      given) — route the query through a chat model with search capability.
 */
import { Hono } from "hono";
import { routeRequest } from "../router";
import { broadcast } from "../../ws/index";
import { db } from "../../db/index";
import { kv } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../../utils/crypto";
import { listSearchProviders, resolveSearchProvider } from "./providers";
import { dispatchSearch } from "./dispatcher";

export const searchRouter = new Hono();

/** GET /v1/search/providers — list dedicated search-API vendors. */
searchRouter.get("/v1/search/providers", (c) => {
  return c.json({ providers: listSearchProviders() });
});

/** GET /v1/search/keys/:provider — whether a key is set (never returns the key). */
searchRouter.get("/v1/search/keys/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!resolveSearchProvider(provider)) return c.json({ error: "unknown provider" }, 404);
  const [row] = await db.select().from(kv).where(and(eq(kv.scope, "searchApiKeys"), eq(kv.key, provider))).limit(1);
  return c.json({ provider, hasKey: !!row?.value });
});

/** PUT /v1/search/keys/:provider — set the API key (encrypted at rest). */
searchRouter.put("/v1/search/keys/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!resolveSearchProvider(provider)) return c.json({ error: "unknown provider" }, 404);
  const { apiKey } = await c.req.json<{ apiKey?: string }>().catch(() => ({}) as any);
  if (!apiKey || typeof apiKey !== "string") return c.json({ error: "apiKey required" }, 400);
  const value = JSON.stringify({ apiKey: encrypt(apiKey) });
  const [existing] = await db.select().from(kv).where(and(eq(kv.scope, "searchApiKeys"), eq(kv.key, provider))).limit(1);
  if (existing) {
    await db.update(kv).set({ value, updatedAt: new Date() }).where(and(eq(kv.scope, "searchApiKeys"), eq(kv.key, provider)));
  } else {
    await db.insert(kv).values({ scope: "searchApiKeys", key: provider, value, updatedAt: new Date() });
  }
  return c.json({ provider, hasKey: true });
});

searchRouter.post("/v1/search", async (c) => {
  const body = await c.req.json<{
    query?: string; provider?: string; model?: string; search_type?: string;
    max_results?: number; country?: string; language?: string; time_range?: string;
    offset?: number; domain_filter?: string[];
  }>().catch(() => ({}) as any);
  const query = body.query;
  if (!query) return c.json({ error: { message: "query is required", type: "invalid_request_error" } }, 400);

  // Path 1: dedicated search-API provider.
  if (body.provider) {
    const config = resolveSearchProvider(body.provider);
    if (!config) {
      return c.json({ error: { message: `Unknown search provider: ${body.provider}`, type: "invalid_request_error" } }, 400);
    }
    const result = await dispatchSearch(config, {
      query,
      searchType: body.search_type,
      maxResults: body.max_results,
      country: body.country,
      language: body.language,
      timeRange: body.time_range,
      offset: body.offset,
      domainFilter: body.domain_filter,
    });
    if (!result.success) {
      const status = (result.status && result.status >= 400 ? result.status : 503) as 400 | 503 | 502 | 500;
      return c.json({ error: { message: result.error || "Search failed", type: "upstream_error" } }, status);
    }
    broadcast({ type: "media_request", data: { modality: "search", provider: config.id } });
    return c.json({ query, ...result.data! });
  }

  // Path 2: LLM-summarized search (searchViaChat, default).
  const model = body.model || "claude-sonnet-4";
  const chatRequest = {
    model,
    messages: [
      {
        role: "user",
        content: `Search the web for: "${query}". Return up to ${body.max_results || 5} results as a JSON array of { title, url, snippet }. Use any available web search tool. Return ONLY the JSON array, no prose.`,
      },
    ],
    stream: false,
    max_tokens: 2000,
  };

  try {
    const routed = await routeRequest(chatRequest as any, false);
    if (!routed?.result?.success || !routed.result.response) {
      return c.json({ error: { message: routed?.result?.error || "Search failed", type: "upstream_error" } }, 503);
    }

    const content = extractText(routed.result.response);
    let results: any[] = [];
    try {
      const match = content.match(/\[[\s\S]*\]/);
      results = match ? JSON.parse(match[0]) : [];
    } catch {
      results = [];
    }

    broadcast({ type: "media_request", data: { modality: "search", model, accountId: routed.account?.id } });
    return c.json({ query, results, model });
  } catch (err: any) {
    return c.json({ error: { message: err.message, type: "server_error" } }, 500);
  }
});

function extractText(response: any): string {
  const choices = response?.choices || [];
  if (!choices.length) return "";
  const msg = choices[0]?.message;
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content.map((p: any) => p?.text || "").join("\n");
  }
  return "";
}
