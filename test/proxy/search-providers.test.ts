import { describe, test, expect } from "bun:test";
import { buildSearchRequest } from "../../src/proxy/search/callers";
import { normalizeSearchResponse } from "../../src/proxy/search/normalizers";
import { resolveSearchProvider, listSearchProviders } from "../../src/proxy/search/providers";
import { dispatchSearch } from "../../src/proxy/search/dispatcher";

/**
 * Hermetic tests for the dedicated web-search-API providers.
 * Request builders + normalizers are pure functions; the dispatcher's network
 * path is exercised via a fetch stub so no real API is hit.
 */

const baseParams = {
  query: "rust async runtime",
  searchType: "web",
  maxResults: 5,
  token: "test-key",
};

describe("search provider catalog", () => {
  test("lists all 10 dedicated search providers", () => {
    const ids = listSearchProviders().map((p) => p.id);
    expect(ids.sort()).toEqual([
      "brave-search", "exa", "google-pse", "linkup", "perplexity",
      "searchapi", "searxng", "serper", "tavily", "youcom",
    ]);
  });

  test("resolves by id and by alias", () => {
    expect(resolveSearchProvider("brave-search")?.id).toBe("brave-search");
    expect(resolveSearchProvider("brave")?.id).toBe("brave-search");
    expect(resolveSearchProvider("nope")).toBeNull();
  });
});

describe("search request builders", () => {
  test("serper: POST /search with X-API-Key + {q, num}", () => {
    const cfg = resolveSearchProvider("serper")!;
    const { url, init } = buildSearchRequest(cfg, baseParams);
    expect(url).toBe("https://google.serper.dev/search");
    expect(init.method).toBe("POST");
    expect((init.headers as any)["X-API-Key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ q: "rust async runtime", num: 5 });
  });

  test("serper news uses /news endpoint", () => {
    const cfg = resolveSearchProvider("serper")!;
    const { url } = buildSearchRequest(cfg, { ...baseParams, searchType: "news" });
    expect(url).toBe("https://google.serper.dev/news");
  });

  test("brave: GET /web/search with X-Subscription-Token + query params", () => {
    const cfg = resolveSearchProvider("brave-search")!;
    const { url, init } = buildSearchRequest(cfg, baseParams);
    expect(init.method).toBe("GET");
    expect((init.headers as any)["X-Subscription-Token"]).toBe("test-key");
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(url).toContain("q=rust+async+runtime");
    expect(url).toContain("count=5");
  });

  test("exa: POST with {query, numResults}", () => {
    const cfg = resolveSearchProvider("exa")!;
    const { url, init } = buildSearchRequest(cfg, baseParams);
    expect(url).toBe("https://api.exa.ai/search");
    expect((init.headers as any)["X-API-Key"]).toBe("test-key");
    expect(JSON.parse(init.body as string)).toEqual({ query: "rust async runtime", numResults: 5 });
  });

  test("tavily: POST with topic=general for web", () => {
    const cfg = resolveSearchProvider("tavily")!;
    const { url, init } = buildSearchRequest(cfg, baseParams);
    expect(url).toBe("https://api.tavily.com/search");
    expect((init.headers as any)["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.topic).toBe("general");
    expect(body.max_results).toBe(5);
  });

  test("tavily news sets topic=news", () => {
    const cfg = resolveSearchProvider("tavily")!;
    const { init } = buildSearchRequest(cfg, { ...baseParams, searchType: "news" });
    expect(JSON.parse(init.body as string).topic).toBe("news");
  });

  test("google-pse puts the key in the query string, not a header", () => {
    const cfg = resolveSearchProvider("google-pse")!;
    const { url } = buildSearchRequest(cfg, baseParams);
    expect(url).toContain("key=test-key");
    expect(url).toContain("q=rust+async+runtime");
  });

  test("searxng needs no auth (none)", () => {
    const cfg = resolveSearchProvider("searxng")!;
    const { url, init } = buildSearchRequest(cfg, baseParams);
    expect(init.method).toBe("GET");
    expect(url).toContain("format=json");
    expect((init.headers as any)["Authorization"]).toBeUndefined();
  });
});

describe("search response normalizers", () => {
  test("serper normalizes organic results", () => {
    const data = {
      organic: [
        { title: "Tokio", link: "https://tokio.rs", snippet: "async runtime", date: "2024-01-01" },
      ],
      searchParameters: { totalResults: 42 },
    };
    const out = normalizeSearchResponse("serper", data, "web");
    expect(out.totalResults).toBe(42);
    const r = out.results[0]!;
    expect(r).toMatchObject({ title: "Tokio", url: "https://tokio.rs", snippet: "async runtime", position: 1 });
    expect(r.display_url).toBe("tokio.rs");
    expect(r.citation.provider).toBe("serper");
  });

  test("serper news normalizes the news array", () => {
    const data = { news: [{ title: "N1", link: "https://n.example", snippet: "s" }] };
    const out = normalizeSearchResponse("serper", data, "news");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.title).toBe("N1");
  });

  test("brave normalizes web.results", () => {
    const data = { web: { results: [{ title: "B", url: "https://b.example", description: "d" }], totalCount: 7 } };
    const out = normalizeSearchResponse("brave-search", data, "web");
    expect(out.totalResults).toBe(7);
    expect(out.results[0]!.snippet).toBe("d");
  });

  test("tavily normalizes results + raw_content into content", () => {
    const data = { results: [{ title: "T", url: "https://t.example", content: "snippet", raw_content: "full text" }] };
    const out = normalizeSearchResponse("tavily", data, "web");
    expect(out.results[0]!.snippet).toBe("snippet");
    expect(out.results[0]!.content).toEqual({ format: "text", text: "full text", length: 9 });
  });

  test("exa uses highlights or text slice for snippet", () => {
    const data = { results: [{ title: "E", url: "https://e.example", highlights: ["hl"], score: 0.9 }] };
    const out = normalizeSearchResponse("exa", data, "web");
    expect(out.results[0]!.snippet).toBe("hl");
    expect(out.results[0]!.score).toBe(0.9);
  });

  test("google-pse reads items[].link", () => {
    const data = { items: [{ title: "G", link: "https://g.example", snippet: "s" }] };
    const out = normalizeSearchResponse("google-pse", data, "web");
    expect(out.results[0]!.url).toBe("https://g.example");
  });

  test("searxng reads results[].content", () => {
    const data = { results: [{ title: "S", url: "https://s.example", content: "c", engines: ["google", "bing"] }] };
    const out = normalizeSearchResponse("searxng", data, "web");
    expect(out.results[0]!.snippet).toBe("c");
    expect(out.results[0]!.metadata.source_type).toBe("google, bing");
  });

  test("unknown provider returns empty results", () => {
    const out = normalizeSearchResponse("nope", { results: [] }, "web");
    expect(out.results).toEqual([]);
  });
});

describe("dispatchSearch", () => {
  test("rejects an empty query before any network call", async () => {
    const cfg = resolveSearchProvider("serper")!;
    const out = await dispatchSearch(cfg, { query: "   " });
    expect(out.success).toBe(false);
    expect(out.status).toBe(400);
  });

  test("rejects control characters in the query", async () => {
    const cfg = resolveSearchProvider("serper")!;
    const out = await dispatchSearch(cfg, { query: "bad\x00query" });
    expect(out.success).toBe(false);
    expect(out.status).toBe(400);
    expect(out.error).toContain("control characters");
  });

  test("returns 401 when a key is required but not set", async () => {
    const cfg = resolveSearchProvider("exa")!;
    const out = await dispatchSearch(cfg, { query: "test" });
    expect(out.success).toBe(false);
    expect(out.status).toBe(401);
    expect(out.error).toContain("No API key");
  });

  test("executes + normalizes when a key is configured (fetch stubbed)", async () => {
    const cfg = resolveSearchProvider("serper")!;
    const origFetch = globalThis.fetch;
    let calledUrl = "";
    (globalThis as any).fetch = async (url: string, init: any) => {
      calledUrl = url;
      expect(init.headers["X-API-Key"]).toBe("stub-key");
      return new Response(JSON.stringify({
        organic: [{ title: "Result", link: "https://r.example", snippet: "snip" }],
        searchParameters: { totalResults: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      // Seed the key directly in the kv table (encrypted), then dispatch.
      const { db } = await import("../../src/db/index");
      const { kv } = await import("../../src/db/schema");
      const { eq, and } = await import("drizzle-orm");
      const { encrypt } = await import("../../src/utils/crypto");
      const value = JSON.stringify({ apiKey: encrypt("stub-key") });
      const [existing] = await db.select().from(kv).where(and(eq(kv.scope, "searchApiKeys"), eq(kv.key, "serper"))).limit(1);
      if (existing) {
        await db.update(kv).set({ value, updatedAt: new Date() }).where(and(eq(kv.scope, "searchApiKeys"), eq(kv.key, "serper")));
      } else {
        await db.insert(kv).values({ scope: "searchApiKeys", key: "serper", value, updatedAt: new Date() });
      }

      const out = await dispatchSearch(cfg, { query: "hello" });
      expect(calledUrl).toBe("https://google.serper.dev/search");
      expect(out.success).toBe(true);
      expect(out.data?.results[0]?.title).toBe("Result");
      expect(out.data?.provider).toBe("serper");

      // Cleanup so it doesn't leak into other tests.
      await db.delete(kv).where(and(eq(kv.scope, "searchApiKeys"), eq(kv.key, "serper")));
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});
