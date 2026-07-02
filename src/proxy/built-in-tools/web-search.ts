/**
 * Built-in web_search backend.
 *
 * Anthropic's `web_search_*` server tool normally executes on Anthropic's
 * servers. We shim it: the proxy runs the search locally with an open-source
 * backend and returns Anthropic-shaped `web_search_tool_result` blocks so
 * clients (Claude Code) render native search results.
 *
 * Backends (pluggable, zero-config default):
 *   1. SearXNG (optional, robust) — when SEARXNG_URL is set, query
 *      `?q=...&format=json`. Self-hosted, keyless.
 *   2. DuckDuckGo Lite (default, zero-config) — HTML parse of
 *      `https://lite.duckduckgo.com/lite/?q=...`. No key, no service.
 *
 * Result shape maps to Anthropic `web_search_result` blocks:
 *   { type:"web_search_result", url, title, page_age?, encrypted_content? }
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

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;

/** Choose the active backend at call time (SearXNG wins if configured). */
function activeBackend(): WebSearchBackend {
  if (config.searxngUrl) return searxngBackend;
  return duckduckgoBackend;
}

/**
 * Public entry: run a web search. Bounded by result count + a 10s timeout.
 * Never throws — returns an empty array on failure so the agent loop can
 * inject a graceful error tool_result instead of crashing.
 */
export async function searchWeb(query: string): Promise<WebSearchResult[]> {
  if (!query?.trim()) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const backend = activeBackend();
    const results = await backend.search(query.trim(), controller.signal);
    return results.slice(0, MAX_RESULTS);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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

// ── DuckDuckGo Lite backend (zero-config default) ─────────────────────────

export const duckduckgoBackend: WebSearchBackend = {
  name: "duckduckgo",
  async search(query, signal) {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=us-en`;
    const res = await fetch(url, {
      headers: {
        Accept: "text/html",
        // DDG serves lite HTML to a basic UA; mimic a browser to avoid blocks.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
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
    const url = decodeDdgUrl(m[1]);
    const title = stripTags(m[2]).trim();
    if (url && title) links.push({ url, title });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    const s = stripTags(m[1]).trim();
    if (s) snippets.push(s);
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      url: links[i].url,
      title: links[i].title,
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
