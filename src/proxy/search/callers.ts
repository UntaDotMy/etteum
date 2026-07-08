/**
 * Search provider request builders.
 *
 * 1:1 with the reference proxy open-sse/handlers/search/callers.js. Each
 * builder turns a unified SearchRequest into the vendor-specific
 * { url, init } (method, headers, body/query). Auth is applied per the
 * provider's authHeader scheme.
 */
import type { SearchProviderConfig } from "./providers";

export interface SearchRequestParams {
  query: string;
  searchType: string;
  maxResults: number;
  token: string;
  country?: string;
  language?: string;
  timeRange?: string;
  offset?: number;
  domainFilter?: string[];
}

export interface BuiltRequest {
  url: string;
  init: RequestInit;
}

/** Resolve base URL, stripping any trailing slash. */
function resolveBaseUrl(config: SearchProviderConfig): string {
  return config.baseUrl.replace(/\/+$/, "");
}

/** Convert offset+maxResults to a 1-indexed page number. */
function toPageNumber(offset: number | undefined, maxResults: number): number | undefined {
  if (typeof offset !== "number" || offset <= 0 || maxResults <= 0) return undefined;
  return Math.floor(offset / maxResults) + 1;
}

/** Apply auth per the provider's authHeader scheme. */
function applyAuth(headers: Record<string, string>, authHeader: string, token: string): Record<string, string> {
  if (!token || authHeader === "none") return headers;
  switch (authHeader) {
    case "bearer": headers["Authorization"] = `Bearer ${token}`; break;
    case "x-api-key": headers["X-API-Key"] = token; break;
    case "x-subscription-token": headers["X-Subscription-Token"] = token; break;
    case "api_key": headers["api_key"] = token; break;
    case "key": headers["key"] = token; break;
  }
  return headers;
}

function buildSerperRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const endpoint = p.searchType === "news" ? "/news" : "/search";
  const body: any = { q: p.query, num: p.maxResults };
  if (p.country) body.gl = p.country.toLowerCase();
  if (p.language) body.hl = p.language;
  return {
    url: `${resolveBaseUrl(config)}${endpoint}`,
    init: { method: "POST", headers: applyAuth({ "Content-Type": "application/json" }, config.authHeader, p.token), body: JSON.stringify(body) },
  };
}

function buildBraveRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const endpoint = p.searchType === "news" ? "/news/search" : "/web/search";
  const qp = new URLSearchParams({ q: p.query, count: String(p.maxResults) });
  if (p.country) qp.set("country", p.country);
  if (p.language) qp.set("search_lang", p.language);
  return {
    url: `${resolveBaseUrl(config)}${endpoint}?${qp}`,
    init: { method: "GET", headers: applyAuth({ Accept: "application/json" }, config.authHeader, p.token) },
  };
}

function buildPerplexityRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const body: any = { query: p.query, max_results: p.maxResults };
  if (p.country) body.country = p.country;
  if (p.language) body.search_language_filter = [p.language];
  if (p.domainFilter?.length) body.search_domain_filter = p.domainFilter;
  return {
    url: resolveBaseUrl(config),
    init: { method: "POST", headers: applyAuth({ "Content-Type": "application/json" }, config.authHeader, p.token), body: JSON.stringify(body) },
  };
}

function buildExaRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const body: any = { query: p.query, numResults: p.maxResults };
  if (p.timeRange) body.startPublishedDate = p.timeRange;
  return {
    url: resolveBaseUrl(config),
    init: { method: "POST", headers: applyAuth({ "Content-Type": "application/json" }, config.authHeader, p.token), body: JSON.stringify(body) },
  };
}

function buildTavilyRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const body: any = { query: p.query, max_results: p.maxResults, topic: p.searchType === "news" ? "news" : "general" };
  if (p.country) body.country = p.country;
  if (p.domainFilter?.length) {
    body.include_domains = p.domainFilter.filter((d) => !d.startsWith("-"));
    body.exclude_domains = p.domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
  }
  return {
    url: resolveBaseUrl(config),
    init: { method: "POST", headers: applyAuth({ "Content-Type": "application/json" }, config.authHeader, p.token), body: JSON.stringify(body) },
  };
}

function buildGooglePseRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const qp = new URLSearchParams({ q: p.query, num: String(p.maxResults) });
  if (p.country) qp.set("gl", p.country.toLowerCase());
  if (p.language) qp.set("hl", p.language);
  if (p.offset) qp.set("start", String(p.offset + 1));
  const headers: Record<string, string> = { Accept: "application/json" };
  // Google PSE uses the `key` query param, not a header.
  if (p.token) qp.set("key", p.token);
  return { url: `${resolveBaseUrl(config)}?${qp}`, init: { method: "GET", headers } };
}

function buildLinkupRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const body: any = { q: p.query, depth: "standard", outputType: "searchResults" };
  return {
    url: resolveBaseUrl(config),
    init: { method: "POST", headers: applyAuth({ "Content-Type": "application/json" }, config.authHeader, p.token), body: JSON.stringify(body) },
  };
}

function buildSearchApiRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const qp = new URLSearchParams({ q: p.query, num: String(p.maxResults), engine: p.searchType === "news" ? "google_news" : "google" });
  if (p.country) qp.set("country", p.country);
  if (p.language) qp.set("language", p.language);
  if (p.token) qp.set("api_key", p.token);
  return { url: `${resolveBaseUrl(config)}?${qp}`, init: { method: "GET", headers: { Accept: "application/json" } } };
}

function buildYouComRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const qp = new URLSearchParams({ query: p.query, num: String(p.maxResults) });
  if (p.country) qp.set("country", p.country);
  return {
    url: `${resolveBaseUrl(config)}?${qp}`,
    init: { method: "GET", headers: applyAuth({ Accept: "application/json" }, config.authHeader, p.token) },
  };
}

function buildSearxngRequest(config: SearchProviderConfig, p: SearchRequestParams): BuiltRequest {
  const baseUrl = resolveBaseUrl(config);
  const url = baseUrl.endsWith("/search") ? baseUrl : `${baseUrl}/search`;
  const qp = new URLSearchParams({ q: p.query, format: "json", categories: p.searchType === "news" ? "news" : "general" });
  if (p.language) qp.set("language", p.language);
  if (p.timeRange && p.timeRange !== "any") qp.set("time_range", p.timeRange);
  const page = toPageNumber(p.offset, p.maxResults);
  if (page) qp.set("pageno", String(page));
  return { url: `${url}?${qp}`, init: { method: "GET", headers: { Accept: "application/json" } } };
}

const BUILDERS: Record<string, (c: SearchProviderConfig, p: SearchRequestParams) => BuiltRequest> = {
  "serper": buildSerperRequest,
  "brave-search": buildBraveRequest,
  "perplexity": buildPerplexityRequest,
  "exa": buildExaRequest,
  "tavily": buildTavilyRequest,
  "google-pse": buildGooglePseRequest,
  "linkup": buildLinkupRequest,
  "searchapi": buildSearchApiRequest,
  "youcom": buildYouComRequest,
  "searxng": buildSearxngRequest,
};

/**
 * Dispatch to the correct provider builder. Falls back to generic POST + bearer
 * auth for unknown providers.
 */
export function buildSearchRequest(config: SearchProviderConfig, params: SearchRequestParams): BuiltRequest {
  const builder = BUILDERS[config.id];
  if (builder) return builder(config, params);
  return {
    url: resolveBaseUrl(config),
    init: {
      method: config.method || "POST",
      headers: applyAuth({ "Content-Type": "application/json" }, config.authHeader, params.token),
      body: JSON.stringify({ query: params.query, max_results: params.maxResults, search_type: params.searchType }),
    },
  };
}
