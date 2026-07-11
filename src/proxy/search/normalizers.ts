/**
 * Search response normalizers.
 *
 * 1:1 with the reference proxy open-sse/handlers/search/normalizers.js. Each
 * normalizer maps a vendor-specific response into the unified SearchResult
 * shape { title, url, snippet, ... }.
 */

export interface SearchResult {
  title: string;
  url: string;
  display_url?: string;
  snippet: string;
  position: number;
  score: number | null;
  published_at: string | null;
  favicon_url: string | null;
  content: { format: string; text: string; length: number } | null;
  metadata: {
    author: string | null;
    language: null;
    source_type: string | null;
    image_url: string | null;
  };
  citation: { provider: string; rank: number };
}

export interface NormalizedSearchResponse {
  results: SearchResult[];
  totalResults: number | null;
}

function displayUrl(url: string): string | undefined {
  return url ? url.replace(/^https?:\/\/(www\.)?/, "").split("?")[0] : undefined;
}

function makeResult(
  providerId: string,
  item: Record<string, any>,
  idx: number,
): SearchResult {
  const url = item.url || "";
  return {
    title: item.title || "",
    url,
    display_url: displayUrl(url),
    snippet: item.snippet || "",
    position: idx + 1,
    score: typeof item.score === "number" ? Math.min(1, Math.max(0, item.score)) : null,
    published_at: item.published_at || null,
    favicon_url: item.favicon_url || null,
    content: item.full_text
      ? { format: item.text_format || "text", text: item.full_text, length: item.full_text.length }
      : null,
    metadata: {
      author: item.author || null,
      language: null,
      source_type: item.source_type || null,
      image_url: item.image_url || null,
    },
    citation: { provider: providerId, rank: idx + 1 },
  };
}

function normalizeSerper(data: any, searchType: string): NormalizedSearchResponse {
  const items = searchType === "news" ? data.news : data.organic;
  if (!Array.isArray(items)) return { results: [], totalResults: null };
  const results = items.map((item: any, idx: number) =>
    makeResult("serper", { title: item.title, url: item.link, snippet: item.snippet || item.description, published_at: item.date }, idx),
  );
  const total = data.searchParameters?.totalResults;
  return { results, totalResults: typeof total === "number" ? total : null };
}

function normalizeBrave(data: any, searchType: string): NormalizedSearchResponse {
  const container = searchType === "news" ? data.news || data : data.web;
  const items = container?.results;
  if (!Array.isArray(items)) return { results: [], totalResults: null };
  const results = items.map((item: any, idx: number) =>
    makeResult("brave-search", {
      title: item.title, url: item.url, snippet: item.description,
      published_at: item.page_age || item.age, favicon_url: item.meta_url?.favicon || item.favicon,
    }, idx),
  );
  return { results, totalResults: container?.totalCount ?? null };
}

function normalizePerplexity(data: any): NormalizedSearchResponse {
  // Perplexity Sonar returns an OpenAI-style chat completion:
  //   { choices: [{ message: { content } }], citations: [url, ...] }
  // NOT a { results: [...] } search payload. Build search results from the
  // citations list; the model's synthesized answer is the top snippet.
  if (!data || typeof data !== "object") return { results: [], totalResults: null };

  // Tolerate a legacy { results: [...] } shape just in case upstream changes.
  if (Array.isArray(data.results)) {
    const items = data.results;
    const results = items.map((item: any, idx: number) =>
      makeResult("perplexity", { title: item.title, url: item.url, snippet: item.snippet, published_at: item.date || item.last_updated }, idx),
    );
    return { results, totalResults: results.length };
  }

  const content: string = data.choices?.[0]?.message?.content ?? "";
  const citations: string[] = Array.isArray(data.citations) ? data.citations : [];
  if (citations.length === 0 && !content) return { results: [], totalResults: null };

  const results = citations.map((url: string, idx: number) =>
    makeResult("perplexity", { title: url, url, snippet: idx === 0 ? content.slice(0, 500) : "" }, idx),
  );
  // If there are no citations but we have content, surface the answer itself.
  if (results.length === 0 && content) {
    results.push(makeResult("perplexity", { title: "Perplexity Sonar answer", url: "", snippet: content.slice(0, 500) }, 0));
  }
  return { results, totalResults: results.length };
}

function normalizeExa(data: any): NormalizedSearchResponse {
  const items = data.results;
  if (!Array.isArray(items)) return { results: [], totalResults: null };
  const results = items.map((item: any, idx: number) =>
    makeResult("exa", {
      title: item.title, url: item.url,
      snippet: item.highlights?.[0] || item.text?.slice(0, 300) || "",
      score: item.score, published_at: item.publishedDate, favicon_url: item.favicon,
      author: item.author, image_url: item.image, full_text: item.text, text_format: "text",
    }, idx),
  );
  return { results, totalResults: results.length };
}

function normalizeTavily(data: any): NormalizedSearchResponse {
  const items = data.results;
  if (!Array.isArray(items)) return { results: [], totalResults: null };
  const results = items.map((item: any, idx: number) =>
    makeResult("tavily", {
      title: item.title, url: item.url, snippet: item.content || "",
      score: item.score, published_at: item.published_date, full_text: item.raw_content, text_format: "text",
    }, idx),
  );
  return { results, totalResults: results.length };
}

function normalizeGooglePse(data: any): NormalizedSearchResponse {
  const items = Array.isArray(data.items) ? data.items : [];
  const results = items.map((item: any, idx: number) =>
    makeResult("google-pse", {
      title: item.title, url: item.link, snippet: item.snippet,
      image_url: item.pagemap?.cse_image?.[0]?.src || item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.metatags?.[0]?.["og:image"],
    }, idx),
  );
  return { results, totalResults: typeof data.searchInformation?.totalResults === "string" ? Number(data.searchInformation.totalResults) : results.length };
}

function normalizeLinkup(data: any): NormalizedSearchResponse {
  const items = data?.results?.links ?? data?.links;
  if (!Array.isArray(items)) return { results: [], totalResults: null };
  const results = items.map((item: any, idx: number) =>
    makeResult("linkup", { title: item.title, url: item.url, snippet: item.snippet, full_text: item.content, text_format: "text" }, idx),
  );
  return { results, totalResults: results.length };
}

function normalizeSearchApi(data: any): NormalizedSearchResponse {
  const items = data.search_results ?? data.organic_results;
  if (!Array.isArray(items)) return { results: [], totalResults: null };
  const results = items.map((item: any, idx: number) =>
    makeResult("searchapi", { title: item.title, url: item.link, snippet: item.snippet, published_at: item.date }, idx),
  );
  return { results, totalResults: typeof data?.search_information?.total_results === "number" ? data.search_information.total_results : results.length };
}

function normalizeYouCom(data: any, searchType: string): NormalizedSearchResponse {
  const items = data.hits;
  if (!Array.isArray(items)) return { results: [], totalResults: null };
  const results = items.map((item: any, idx: number) => {
    const firstSnippet = Array.isArray(item.snippets) ? item.snippets[0] : item.snippets;
    const livecrawlText = typeof item.markdown === "string" ? item.markdown : typeof item.html === "string" ? item.html : undefined;
    const livecrawlFormat = typeof item.markdown === "string" ? "markdown" : "html";
    return makeResult("youcom", {
      title: item.title, url: item.url,
      snippet: typeof firstSnippet === "string" ? firstSnippet : typeof item.description === "string" ? item.description : "",
      published_at: item.page_age, favicon_url: item.favicon_url, image_url: item.thumbnail_url,
      source_type: searchType, full_text: livecrawlText, text_format: livecrawlText ? livecrawlFormat : undefined,
    }, idx);
  });
  return { results, totalResults: results.length };
}

function normalizeSearxng(data: any): NormalizedSearchResponse {
  const items = Array.isArray(data.results) ? data.results : [];
  const results = items.map((item: any, idx: number) =>
    makeResult("searxng", {
      title: item.title, url: item.url,
      snippet: item.content || item.snippet || "",
      published_at: item.publishedDate || item.published_date || null,
      source_type: Array.isArray(item.engines) ? item.engines.join(", ") : item.engine || item.category || null,
      image_url: item.thumbnail || item.img_src || null,
    }, idx),
  );
  return { results, totalResults: results.length };
}

const NORMALIZERS: Record<string, (data: any, searchType: string) => NormalizedSearchResponse> = {
  "serper": (d, st) => normalizeSerper(d, st),
  "brave-search": (d, st) => normalizeBrave(d, st),
  "perplexity": (d) => normalizePerplexity(d),
  "exa": (d) => normalizeExa(d),
  "tavily": (d) => normalizeTavily(d),
  "google-pse": (d) => normalizeGooglePse(d),
  "linkup": (d) => normalizeLinkup(d),
  "searchapi": (d) => normalizeSearchApi(d),
  "youcom": (d, st) => normalizeYouCom(d, st),
  "searxng": (d) => normalizeSearxng(d),
};

/** Dispatch to the appropriate normalizer by providerId. */
export function normalizeSearchResponse(providerId: string, data: any, searchType: string): NormalizedSearchResponse {
  const fn = NORMALIZERS[providerId];
  return fn ? fn(data, searchType) : { results: [], totalResults: null };
}
