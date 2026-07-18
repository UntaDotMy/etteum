import { checkProxyHealth } from "./proxy-pool";

export type ScrapeSource = "proxyscrape" | "geonode" | "proxifly" | "all";
export type ScrapeProtocol = "http" | "socks5" | "all";

export interface ScrapedProxy {
  url: string;
  type: "http" | "socks5";
  country: string | null;
}

export interface ScrapeOptions {
  source?: ScrapeSource;
  country?: string; // ISO-2 code (e.g. "US") or "all"
  protocol?: ScrapeProtocol;
  limit?: number;
}

// Curated region list for the dashboard dropdown. Any ISO-2 code works with
// ProxyScrape/Geonode, but these cover the common cases.
export const COUNTRIES: { code: string; name: string }[] = [
  { code: "all", name: "Any region" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "RU", name: "Russia" },
  { code: "ID", name: "Indonesia" },
  { code: "SG", name: "Singapore" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "IN", name: "India" },
  { code: "CN", name: "China" },
  { code: "HK", name: "Hong Kong" },
  { code: "BR", name: "Brazil" },
  { code: "AU", name: "Australia" },
  { code: "TR", name: "Turkey" },
  { code: "VN", name: "Vietnam" },
  { code: "TH", name: "Thailand" },
  { code: "PL", name: "Poland" },
  { code: "UA", name: "Ukraine" },
  { code: "MX", name: "Mexico" },
];

const FETCH_TIMEOUT_MS = 20_000;

function normalizeProtocol(scheme: string): "http" | "socks5" | null {
  const s = scheme.toLowerCase();
  if (s === "http" || s === "https") return "http";
  if (s === "socks5" || s === "socks5h") return "socks5";
  return null; // socks4 and anything else are unsupported downstream
}

// Parse a "protocol://ip:port" line into a normalized proxy entry.
function parseProxyLine(line: string, country: string | null): ScrapedProxy | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([a-z0-9]+):\/\/([^/\s]+)$/i);
  if (!match) return null;
  const [, scheme, hostPort] = match;
  if (!scheme || !hostPort) return null;
  const type = normalizeProtocol(scheme);
  if (!type) return null;
  if (!/^[^:]+:\d+$/.test(hostPort)) return null; // must be host:port
  return { url: `${type}://${hostPort}`, type, country };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// --- Sources ---------------------------------------------------------------

async function scrapeProxyScrape(country: string, protocol: ScrapeProtocol): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({
    request: "display_proxies",
    proxy_format: "protocolipport",
    format: "text",
  });
  if (country !== "all") params.set("country", country.toLowerCase());
  if (protocol !== "all") params.set("protocol", protocol);

  const text = await fetchText(`https://api.proxyscrape.com/v4/free-proxy-list/get?${params}`);
  const countryTag = country !== "all" ? country.toUpperCase() : null;
  return text
    .split("\n")
    .map((line) => parseProxyLine(line, countryTag))
    .filter((p): p is ScrapedProxy => p !== null);
}

async function scrapeGeonode(country: string, protocol: ScrapeProtocol): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({
    limit: "500",
    page: "1",
    sort_by: "lastChecked",
    sort_type: "desc",
  });
  if (country !== "all") params.set("country", country.toUpperCase());
  if (protocol !== "all") params.set("protocols", protocol);

  const text = await fetchText(`https://proxylist.geonode.com/api/proxy-list?${params}`);
  const json = JSON.parse(text) as {
    data?: { ip: string; port: string; protocols?: string[]; country?: string }[];
  };
  const out: ScrapedProxy[] = [];
  for (const row of json.data ?? []) {
    if (!row.ip || !row.port) continue;
    const proto = (row.protocols ?? []).map((p) => normalizeProtocol(p)).find(Boolean);
    if (!proto) continue;
    if (protocol !== "all" && proto !== protocol) continue;
    out.push({ url: `${proto}://${row.ip}:${row.port}`, type: proto, country: row.country ?? null });
  }
  return out;
}

async function scrapeProxifly(country: string, protocol: ScrapeProtocol): Promise<ScrapedProxy[]> {
  const path =
    country !== "all"
      ? `proxies/countries/${country.toUpperCase()}/data.txt`
      : "proxies/all/data.txt";
  const text = await fetchText(`https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/${path}`);
  const countryTag = country !== "all" ? country.toUpperCase() : null;
  return text
    .split("\n")
    .map((line) => parseProxyLine(line, countryTag))
    .filter((p): p is ScrapedProxy => p !== null)
    .filter((p) => protocol === "all" || p.type === protocol);
}

// --- Orchestration ---------------------------------------------------------

/**
 * Scrape proxies from one or all free sources, filtered by region and protocol.
 * Results are de-duplicated by URL. Failed sources are skipped silently so a
 * single dead source never sinks the whole request.
 */
export async function scrapeProxies(options: ScrapeOptions = {}): Promise<ScrapedProxy[]> {
  const { source = "all", country = "all", protocol = "all", limit = 100 } = options;

  const tasks: Promise<ScrapedProxy[]>[] = [];
  if (source === "proxyscrape" || source === "all") tasks.push(scrapeProxyScrape(country, protocol));
  if (source === "geonode" || source === "all") tasks.push(scrapeGeonode(country, protocol));
  if (source === "proxifly" || source === "all") tasks.push(scrapeProxifly(country, protocol));

  const settled = await Promise.allSettled(tasks);

  const seen = new Set<string>();
  const merged: ScrapedProxy[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const proxy of result.value) {
      if (seen.has(proxy.url)) continue;
      seen.add(proxy.url);
      merged.push(proxy);
    }
  }

  return limit > 0 ? merged.slice(0, limit) : merged;
}

/**
 * Health-check scraped proxies with bounded concurrency, keeping only the ones
 * that respond. Used when the caller asks to verify before adding to the pool.
 */
export async function verifyProxies(
  proxies: ScrapedProxy[],
  concurrency = 20,
): Promise<ScrapedProxy[]> {
  const alive: ScrapedProxy[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < proxies.length) {
      const proxy = proxies[cursor++];
      if (!proxy) break;
      const result = await checkProxyHealth(proxy.url);
      if (result.ok) alive.push(proxy);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, proxies.length) }, worker);
  await Promise.all(workers);
  return alive;
}
