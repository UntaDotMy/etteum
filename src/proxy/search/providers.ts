/**
 * Dedicated web-search-API provider catalog.
 *
 * 1:1 with the reference proxy's open-sse/providers/registry search providers.
 * Each entry is one API-key search vendor. The caller (callers.ts) builds the
 * per-vendor HTTP request from this config; the normalizer (normalizers.ts)
 * parses each vendor's response into the unified SearchResult shape.
 *
 * These are distinct from the LLM-summarized searchViaChat path in router.ts —
 * they hit a real search API and return structured results, no model in the loop.
 */

export type SearchAuthHeader = "bearer" | "x-api-key" | "x-subscription-token" | "key" | "api_key" | "none";

export interface SearchProviderConfig {
  id: string;
  alias: string;
  displayName: string;
  baseUrl: string;
  method: "GET" | "POST";
  authHeader: SearchAuthHeader;
  /** Per-query USD cost (informational). */
  costPerQuery: number;
  freeMonthlyQuota: number;
  searchTypes: string[];
  defaultMaxResults: number;
  maxMaxResults: number;
  timeoutMs: number;
  cacheTtlMs: number;
}

export const SEARCH_PROVIDERS: Record<string, SearchProviderConfig> = {
  "serper": {
    id: "serper", alias: "serper", displayName: "Serper",
    baseUrl: "https://google.serper.dev", method: "POST", authHeader: "x-api-key",
    costPerQuery: 0.001, freeMonthlyQuota: 2500, searchTypes: ["web", "news"],
    defaultMaxResults: 5, maxMaxResults: 100, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "brave-search": {
    id: "brave-search", alias: "brave", displayName: "Brave Search",
    baseUrl: "https://api.search.brave.com/res/v1", method: "GET", authHeader: "x-subscription-token",
    costPerQuery: 0.005, freeMonthlyQuota: 1000, searchTypes: ["web", "news"],
    defaultMaxResults: 5, maxMaxResults: 20, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "exa": {
    id: "exa", alias: "exa", displayName: "Exa",
    baseUrl: "https://api.exa.ai/search", method: "POST", authHeader: "x-api-key",
    costPerQuery: 0.008, freeMonthlyQuota: 1000, searchTypes: ["web"],
    defaultMaxResults: 5, maxMaxResults: 20, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "tavily": {
    id: "tavily", alias: "tavily", displayName: "Tavily",
    baseUrl: "https://api.tavily.com/search", method: "POST", authHeader: "bearer",
    costPerQuery: 0.008, freeMonthlyQuota: 1000, searchTypes: ["web", "news"],
    defaultMaxResults: 5, maxMaxResults: 20, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "perplexity": {
    id: "perplexity", alias: "perplexity", displayName: "Perplexity",
    baseUrl: "https://api.perplexity.ai/chat/completions", method: "POST", authHeader: "bearer",
    costPerQuery: 0.005, freeMonthlyQuota: 0, searchTypes: ["web"],
    defaultMaxResults: 5, maxMaxResults: 20, timeoutMs: 15000, cacheTtlMs: 300000,
  },
  "google-pse": {
    id: "google-pse", alias: "gpse", displayName: "Google PSE",
    baseUrl: "https://www.googleapis.com/customsearch/v1", method: "GET", authHeader: "key",
    costPerQuery: 0.005, freeMonthlyQuota: 100, searchTypes: ["web"],
    defaultMaxResults: 5, maxMaxResults: 10, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "linkup": {
    id: "linkup", alias: "linkup", displayName: "Linkup",
    baseUrl: "https://api.linkup.so/v1/search", method: "POST", authHeader: "bearer",
    costPerQuery: 0.005, freeMonthlyQuota: 1000, searchTypes: ["web", "news"],
    defaultMaxResults: 5, maxMaxResults: 50, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "searchapi": {
    id: "searchapi", alias: "searchapi", displayName: "SearchAPI",
    baseUrl: "https://www.searchapi.io/api/v1/search", method: "GET", authHeader: "api_key",
    costPerQuery: 0.003, freeMonthlyQuota: 100, searchTypes: ["web", "news"],
    defaultMaxResults: 5, maxMaxResults: 100, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "youcom": {
    id: "youcom", alias: "youcom", displayName: "You.com",
    baseUrl: "https://ydc-index.io/v1/search", method: "POST", authHeader: "x-api-key",
    costPerQuery: 0.01, freeMonthlyQuota: 100, searchTypes: ["web", "news"],
    defaultMaxResults: 5, maxMaxResults: 20, timeoutMs: 10000, cacheTtlMs: 300000,
  },
  "searxng": {
    id: "searxng", alias: "searxng", displayName: "SearXNG",
    baseUrl: "http://localhost:8888/search", method: "GET", authHeader: "none",
    costPerQuery: 0, freeMonthlyQuota: Infinity, searchTypes: ["web", "news"],
    defaultMaxResults: 5, maxMaxResults: 100, timeoutMs: 10000, cacheTtlMs: 300000,
  },
};

/** Resolve a provider by id or alias. */
export function resolveSearchProvider(idOrAlias: string): SearchProviderConfig | null {
  if (SEARCH_PROVIDERS[idOrAlias]) return SEARCH_PROVIDERS[idOrAlias];
  return Object.values(SEARCH_PROVIDERS).find((p) => p.alias === idOrAlias) || null;
}

export function listSearchProviders(): SearchProviderConfig[] {
  return Object.values(SEARCH_PROVIDERS);
}
