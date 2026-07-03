/**
 * Built-in web_search backend.
 *
 * Anthropic's `web_search_*` server tool normally executes on Anthropic's
 * servers. We shim it: the proxy runs the search locally with a free, keyless
 * backend and returns Anthropic-shaped `web_search_tool_result` blocks so
 * clients (Claude Code) render native search results.
 *
 * Backends (cascading, zero-config default — first non-empty wins):
 *   0. SearXNG (optional, robust) — when SEARXNG_URL is set, query
 *      `?q=...&format=json`. Self-hosted, keyless.
 *   1. Brave Search HTML (default primary) — server-rendered results scraped
 *      from `https://search.brave.com/search?q=...`. Free, keyless, and
 *      reachable from China-routed networks where DuckDuckGo is blocked.
 *   2. DuckDuckGo Instant Answer API — `https://api.duckduckgo.com/?q=...&format=json`.
 *      Keyless; the `api.` host is reachable even when `lite.duckduckgo.com`
 *      (HTML) is blocked. Returns entity abstracts + related topics, not a
 *      general SERP — used as a fallback for factual/entity queries.
 *   3. Wikipedia MediaWiki API — `en.wikipedia.org/w/api.php?...&list=search`.
 *      Keyless, always reachable; encyclopedia-only, last-resort factual fallback.
 *   4. DuckDuckGo Lite HTML — kept for non-China deployments where lite.duckduckgo.com
 *      is reachable; never the first choice because it is blocked on some networks.
 *
 * Result shape maps to Anthropic `web_search_result` blocks:
 *   { type:"web_search_result", url, title, page_age?, encrypted_content? }
 *
 * Failures are NOT swallowed silently: searchWeb returns an `error` field when
 * every backend was unreachable, so the agent loop can surface an error tool
 * result to the model instead of looping on empty results.
 */

import { config } from "../../config";

export interface WebSearchResult {
  url: string;
  title: string;
  snippet?: string;
  pageAge?: string;
}

export interface WebSearchBackend {
  name: string;
  search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

/** Outcome of a search: results, and an error string if every backend failed. */
export interface WebSearchOutcome {
  results: WebSearchResult[];
  /** Set when all backends were unreachable/errored (distinct from "0 results"). */
  error?: string;
  /** Which backend produced the results, for diagnostics. */
  backend?: string;
}

const SEARCH_TIMEOUT_MS = 10_000;
// MediaWiki `list=search` requires a numeric srlimit (server caps at 500). Other
// backends return all organic results uncapped; only Wikipedia needs a ceiling.
const WIKIPEDIA_SRLIMIT = 50;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Ordered cascade of backends. SearXNG wins first when configured; otherwise we
 * try Brave (general SERP, China-reachable) → DDG API (entity answers) →
 * Wikipedia (factual) → DDG Lite (non-China fallback). First non-empty wins.
 */
function backendCascade(): WebSearchBackend[] {
  const chain: WebSearchBackend[] = [];
  if (config.searxngUrl) chain.push(searxngBackend);
  chain.push(braveBackend, duckduckgoApiBackend, wikipediaBackend, duckduckgoBackend);
  return chain;
}

/**
 * Public entry: run a web search. Tries backends in order; first non-empty
 * result set wins. Bounded by result count + a 10s timeout per backend.
 *
 * Returns { results, error? }. `error` is set ONLY when every backend threw or
 * returned nothing AND at least one backend errored (network/timeout) — this
 * distinguishes "search unavailable" from "genuinely no results", so the agent
 * loop can tell the user instead of looping on empty.
 */
export async function searchWeb(query: string): Promise<WebSearchOutcome> {
  if (!query?.trim()) return { results: [] };
  const seenErrors: string[] = [];
  for (const backend of backendCascade()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const results = await backend.search(query.trim(), controller.signal);
      if (results.length > 0) {
        return { results, backend: backend.name };
      }
      // Empty-but-no-throw: try the next backend. (DDG API legitimately returns
      // empty for non-entity queries; that's not a failure.)
    } catch (err) {
      seenErrors.push(`${backend.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  // Every backend returned empty. If some errored, flag it so the caller can
  // surface "search unavailable" rather than "no results exist".
  if (seenErrors.length > 0) {
    return { results: [], error: `All search backends failed — ${seenErrors.join("; ")}` };
  }
  return { results: [] };
}

// ── SearXNG backend ───────────────────────────────────────────────────────

export const searxngBackend: WebSearchBackend = {
  name: "searxng",
  async search(query, signal) {
    const base = config.searxngUrl.replace(/\/+$/, "");
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => ({}));
    return mapSearxngResults(data);
  },
};

/** Pure mapper from a SearXNG JSON payload to WebSearchResult[]. */
export function mapSearxngResults(data: any): WebSearchResult[] {
  if (!data || !Array.isArray(data.results)) return [];
  return data.results
    .filter((r: any) => r?.url)
    .map((r: any) => ({
      url: r.url,
      title: r.title || r.url,
      snippet: typeof r.content === "string" ? r.content : undefined,
      pageAge: typeof r.publishedDate === "string" ? r.publishedDate : undefined,
    }));
}

// ── Brave Search HTML backend (default primary; free, keyless, China-reachable) ─

export const braveBackend: WebSearchBackend = {
  name: "brave",
  async search(query, signal) {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": BROWSER_UA,
      },
      signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseBraveHtml(html);
  },
};

/**
 * Parse Brave Search HTML. Brave server-renders organic results: each result is
 * an anchor whose `href` is the real external URL (not a redirect), wrapped in
 * a `result`/`snippet` container. We extract external (non-brave.com) links
 * with their anchor text as the title, then best-effort match a nearby snippet.
 *
 * Markup drifts; we degrade to an empty array on any structural surprise and
 * never throw — the cascade then tries the next backend.
 */
export function parseBraveHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Organic anchors: <a ... href="https://external/..." ...>visible text</a>.
  // Skip brave.com / brave internal hosts. Anchor text becomes the title.
  const anchorRe = /<a[^>]*\bhref="(https?:\/\/(?!search\.brave\.com|brave\.com|cdn\.brave\.com|bravesoftware\.com|hackerone\.com\/brave|status\.brave\.app)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const url = m[1];
    const title = stripTags(m[2] ?? "").trim();
    // Skip nav/utility anchors with no real title text or a seen/duplicate url.
    if (!url || seen.has(url) || !title || title.length < 3) continue;
    seen.add(url);
    results.push({ url, title, snippet: snippetNear(html, m.index ?? 0, title) });
  }
  return results;
}

/**
 * Best-effort snippet extraction: find a <p> or text node within ~600 chars
 * after the result anchor. Brave wraps snippets in <p class="snippet ..."> or a
 * nearby <div>. We grab the first text-bearing paragraph after the anchor.
 */
function snippetNear(html: string, anchorIndex: number, title: string): string | undefined {
  const window = html.slice(anchorIndex, anchorIndex + 800);
  const pRe = /<(?:p|div)[^>]*class="[^"]*(?:snippet|description|text)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i;
  const sm = pRe.exec(window);
  if (sm) {
    const s = stripTags(sm[1] ?? "").trim();
    if (s && s !== title) return s.slice(0, 280);
  }
  return undefined;
}

// ── DuckDuckGo Instant Answer API backend (keyless entity answers) ──────────

export const duckduckgoApiBackend: WebSearchBackend = {
  name: "duckduckgo-api",
  async search(query, signal) {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
      signal,
    });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => ({}));
    return mapDdgApiResults(data);
  },
};

/**
 * Map a DuckDuckGo Instant Answer API payload to WebSearchResult[]. DDG IA
 * returns an abstract (AbstractText/AbstractURL) plus RelatedTopics. This is
 * NOT a general SERP — it answers entity/factual queries (e.g. "Claude AI") and
 * returns empty for news/arbitrary queries. That empty case is legitimate, not
 * an error, so the cascade continues to the next backend.
 */
export function mapDdgApiResults(data: any): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  if (!data || typeof data !== "object") return results;
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      url: data.AbstractURL,
      title: data.Heading || data.AbstractURL,
      snippet: data.AbstractText,
    });
  }
  // RelatedTopics can contain nested topic objects or disambiguation groups.
  const topics: any[] = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const t of topics) {
    if (t?.Text && t?.FirstURL) {
      results.push({ url: t.FirstURL, title: t.Text.split(" - ")[0] || t.Text, snippet: t.Text });
    } else if (Array.isArray(t?.Topics)) {
      for (const sub of t.Topics) {
        if (sub?.Text && sub?.FirstURL) {
          results.push({ url: sub.FirstURL, title: sub.Text.split(" - ")[0] || sub.Text, snippet: sub.Text });
        }
      }
    }
  }
  return results;
}

// ── Wikipedia MediaWiki API backend (keyless factual fallback) ──────────────

export const wikipediaBackend: WebSearchBackend = {
  name: "wikipedia",
  async search(query, signal) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${WIKIPEDIA_SRLIMIT}&srprop=snippet`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
      signal,
    });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => ({}));
    return mapWikipediaResults(data);
  },
};

/** Map a MediaWiki search payload to WebSearchResult[]. Encyclopedia-only. */
export function mapWikipediaResults(data: any): WebSearchResult[] {
  const hits = data?.query?.search;
  if (!Array.isArray(hits)) return [];
  return hits.map((h: any) => ({
    url: `https://en.wikipedia.org/?curid=${h.pageid}`,
    title: h.title,
    // MediaWiki returns snippet with <span class="searchmatch"> highlights; strip tags.
    snippet: typeof h.snippet === "string" ? stripTags(h.snippet) : undefined,
  }));
}

// ── DuckDuckGo Lite HTML backend (non-China fallback) ───────────────────────

export const duckduckgoBackend: WebSearchBackend = {
  name: "duckduckgo",
  async search(query, signal) {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=us-en`;
    const res = await fetch(url, {
      headers: {
        Accept: "text/html",
        // DDG serves lite HTML to a basic UA; mimic a browser to avoid blocks.
        "User-Agent": BROWSER_UA,
      },
      signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseDuckDuckGoLite(html);
  },
};

/**
 * Parse DuckDuckGo Lite HTML. The lite endpoint returns a bare <table> of
 * results (no JS). Each result is a row with an anchor (title+url) and a
 * snippet <td class="result-snippet">. The markup is minimal but can drift;
 * we degrade gracefully to an empty array on any structural surprise.
 */
export function parseDuckDuckGoLite(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Organic result anchors: href is a //duckduckgo.com/l/?uddg=<encoded>
  // redirect, class='result-link' with single OR double quotes (DDG uses
  // both). Requiring `uddg` skips sponsored (bing-redirect) results.
  const linkRe = /<a[^>]*href=["'](\/\/duckduckgo\.com\/l\/\?uddg=[^"']+)["'][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets are in <td class='result-snippet'> (quote-tolerant).
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    const rawTitle = m[2];
    if (href === undefined || rawTitle === undefined) continue;
    const url = decodeDdgUrl(href);
    const title = stripTags(rawTitle).trim();
    if (url && title) links.push({ url, title });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    const raw = m[1];
    if (raw === undefined) continue;
    const s = stripTags(raw).trim();
    if (s) snippets.push(s);
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link) continue;
    results.push({
      url: link.url,
      title: link.title,
      snippet: snippets[i],
    });
  }
  return results;
}

/** DDG lite sometimes wraps the redirect; extract the bare URL. */
function decodeDdgUrl(href: string): string {
  // lite.duckduckgo.com links are usually direct already. Handle //duckduckgo.com/l/?uddg=... redirects.
  try {
    if (href.startsWith("//")) href = "https:" + href;
    const u = new URL(href, "https://lite.duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    return u.toString();
  } catch {
    return href;
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
