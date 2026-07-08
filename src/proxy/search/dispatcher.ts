/**
 * Search dispatcher — runs a dedicated search-API provider and normalizes its
 * response. 1:1 with the reference proxy open-sse/handlers/search/index.js
 * single-attempt path.
 *
 * API keys are stored in the `kv(searchApiKeys)` scope, keyed by provider id
 * (dashboard-configured). The dispatcher resolves the key, builds the
 * vendor-specific request (callers.ts), executes it with a timeout, and parses
 * the response (normalizers.ts) into the unified SearchResult shape.
 */
import { db } from "../../db/index";
import { kv } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { decrypt } from "../../utils/crypto";
import type { SearchProviderConfig } from "./providers";
import { buildSearchRequest, type SearchRequestParams } from "./callers";
import { normalizeSearchResponse, type NormalizedSearchResponse } from "./normalizers";

const DEFAULT_TIMEOUT_MS = 10000;

export interface SearchDispatchResult {
  success: boolean;
  status?: number;
  error?: string;
  data?: NormalizedSearchResponse & { provider: string };
}

/** Read a provider's API key from the kv(searchApiKeys) scope. */
async function getApiKey(providerId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(kv)
    .where(and(eq(kv.scope, "searchApiKeys"), eq(kv.key, providerId)))
    .limit(1);
  if (!row?.value) return "";
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed === "string") {
      // Stored encrypted — decrypt. (kvGet wraps in JSON; raw strings stay raw.)
      try { return decrypt(parsed); } catch { return parsed; }
    }
    if (parsed?.apiKey && typeof parsed.apiKey === "string") {
      try { return decrypt(parsed.apiKey); } catch { return parsed.apiKey; }
    }
    return "";
  } catch {
    return "";
  }
}

/** Sanitize + validate the query string. */
function sanitizeQuery(query: string): { error?: string; clean?: string } {
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(query)) {
    return { error: "Query contains invalid control characters" };
  }
  const clean = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!clean) return { error: "Query is empty after normalization" };
  return { clean };
}

/**
 * Run a single dedicated search provider attempt.
 */
export async function dispatchSearch(
  config: SearchProviderConfig,
  opts: {
    query: string;
    searchType?: string;
    maxResults?: number;
    country?: string;
    language?: string;
    timeRange?: string;
    offset?: number;
    domainFilter?: string[];
  },
): Promise<SearchDispatchResult> {
  const q = sanitizeQuery(opts.query);
  if (q.error) return { success: false, status: 400, error: q.error };

  let token = "";
  if (config.authHeader !== "none") {
    token = await getApiKey(config.id);
    if (!token) {
      return { success: false, status: 401, error: `No API key configured for ${config.displayName}. Set it via the dashboard (searchApiKeys).` };
    }
  }

  const searchType = opts.searchType && config.searchTypes.includes(opts.searchType)
    ? opts.searchType
    : "web";
  const maxResults = Math.min(
    Math.max(1, opts.maxResults || config.defaultMaxResults),
    config.maxMaxResults,
  );

  const params: SearchRequestParams = {
    query: q.clean!,
    searchType,
    maxResults,
    token,
    country: opts.country,
    language: opts.language,
    timeRange: opts.timeRange,
    offset: opts.offset,
    domainFilter: opts.domainFilter,
  };

  const { url, init } = buildSearchRequest(config, params);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, status: res.status, error: `${config.id} ${res.status}: ${text.slice(0, 200) || res.statusText}` };
    }
    const data = await res.json().catch(() => null);
    if (!data) return { success: false, status: 502, error: `${config.id} returned non-JSON response` };
    const normalized = normalizeSearchResponse(config.id, data, searchType);
    return { success: true, data: { ...normalized, provider: config.id } };
  } catch (e: any) {
    return { success: false, status: 0, error: e?.name === "AbortError" ? `${config.id} timeout` : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}
