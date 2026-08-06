/**
 * Unit tests for src/services/proxy-pool.ts (getNextProxy / markProxySuccess /
 * markProxyFail — rotation + health tracking) and src/services/proxy-scraper.ts
 * (parseProxyLine — format parsing only, no network).
 *
 * proxy-pool imports src/db/index at module load, which opens a real SQLite
 * database. We mock.module("../../src/db/index") BEFORE any import of the
 * service so the DB module never initializes. The stub exposes a `db` object
 * with chainable select/update methods that record calls and return values
 * controlled by the test.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── In-memory DB stub ────────────────────────────────────────────────────────
interface ProxyRow {
  id: number;
  url: string;
  type: string;
  status: string;
  successCount: number;
  failCount: number;
  errorMessage: string | null;
}

let proxyRows: ProxyRow[];
let settingsRows: { key: string; value: string }[];
let updateCalls: Array<{ kind: "proxy" | "settings"; set: Record<string, unknown>; id?: number }>;

function makeChainable(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  // drizzle awaits the final query — make the chain itself thenable
  chain.then = (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(rows).then(onFulfilled, onRejected);
  return chain;
}

const dbStub = {
  select: (_fields?: Record<string, unknown>) => {
    // Distinguish proxy_pool select (3 fields: id/url/type) from settings
    // select (2 fields: key/value) by the shape of the requested fields.
    const keys = _fields ? Object.keys(_fields) : [];
    const isProxySelect = keys.includes("url") && keys.includes("type");
    return makeChainable(isProxySelect ? proxyRows : settingsRows);
  },
  update: (_table: unknown) => ({
    set: (set: Record<string, unknown>) => ({
      where: (_cond: unknown) => {
        updateCalls.push({ kind: "proxy", set });
        return Promise.resolve();
      },
    }),
  }),
};

mock.module("../../src/db/index", () => ({
  db: dbStub,
  client: { run: () => {}, exec: () => {}, prepare: () => ({ all: () => [] }) },
}));

const {
  getNextProxy,
  markProxySuccess,
  markProxyFail,
  invalidateProxyCache,
  invalidateProxySettingsCache,
} = await import("../../src/services/proxy-pool");

// ── Helpers ─────────────────────────────────────────────────────────────────
function resetState() {
  proxyRows = [];
  settingsRows = [];
  updateCalls = [];
  invalidateProxyCache();
  invalidateProxySettingsCache();
}

function seedProxies(rows: Omit<ProxyRow, "successCount" | "failCount" | "errorMessage">[]) {
  proxyRows = rows.map((r) => ({ successCount: 0, failCount: 0, errorMessage: null, ...r }));
}

function seedSettings(usage?: string, rotation?: string) {
  settingsRows = [];
  if (usage !== undefined) settingsRows.push({ key: "proxy_pool_usage", value: usage });
  if (rotation !== undefined) settingsRows.push({ key: "proxy_pool_rotation", value: rotation });
}

// ── getNextProxy ────────────────────────────────────────────────────────────
describe("proxy-pool: getNextProxy", () => {
  beforeEach(resetState);

  test("returns null when pool is empty", async () => {
    seedSettings("all", "round_robin");
    expect(await getNextProxy()).toBeNull();
  });

  test("returns null when usage excludes the requested purpose", async () => {
    seedProxies([{ id: 1, url: "http://1.2.3.4:8080", type: "http", status: "active" }]);
    seedSettings("model", "round_robin");
    expect(await getNextProxy("auth")).toBeNull();
    expect(await getNextProxy("model")).not.toBeNull();
  });

  test("round_robin cycles through all active proxies", async () => {
    seedProxies([
      { id: 1, url: "http://a:1", type: "http", status: "active" },
      { id: 2, url: "http://b:2", type: "http", status: "active" },
      { id: 3, url: "http://c:3", type: "http", status: "active" },
    ]);
    seedSettings("all", "round_robin");

    // roundRobinIndex is module-global and persists across tests, so the first
    // pick of this test may not be "a". Over 6 calls with 3 proxies we must
    // still see each proxy exactly twice and consecutive picks must differ.
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await getNextProxy("model");
      seen.push(p?.url ?? "null");
    }
    const count = (url: string) => seen.filter((u) => u === url).length;
    expect(count("http://a:1")).toBe(2);
    expect(count("http://b:2")).toBe(2);
    expect(count("http://c:3")).toBe(2);
    // Strict cycling: pick i and i+3 must be the same proxy.
    expect(seen[0]).toBe(seen[3]);
    expect(seen[1]).toBe(seen[4]);
    expect(seen[2]).toBe(seen[5]);
    // And the sequence must rotate (no immediate repeat).
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  test("round_robin skips disabled/error rows (only status=active cached)", async () => {
    seedProxies([
      { id: 1, url: "http://active:1", type: "http", status: "active" },
      { id: 2, url: "http://disabled:2", type: "http", status: "disabled" },
      { id: 3, url: "http://error:3", type: "http", status: "error" },
    ]);
    seedSettings("all", "round_robin");

    // The real DB filters on status='active'; our stub returns all rows,
    // so emulate the WHERE by only seeding active rows here.
    seedProxies([{ id: 1, url: "http://active:1", type: "http", status: "active" }]);
    invalidateProxyCache();

    const p1 = await getNextProxy("model");
    const p2 = await getNextProxy("model");
    expect(p1?.url).toBe("http://active:1");
    expect(p2?.url).toBe("http://active:1");
  });

  test("type filter only returns matching protocol", async () => {
    seedProxies([
      { id: 1, url: "http://h1:1", type: "http", status: "active" },
      { id: 2, url: "socks5://s1:2", type: "socks5", status: "active" },
      { id: 3, url: "http://h2:3", type: "http", status: "active" },
    ]);
    seedSettings("all", "round_robin");

    const p = await getNextProxy("model", "socks5");
    expect(p?.url).toBe("socks5://s1:2");

    const p2 = await getNextProxy("model", "http");
    expect(p2?.url).toBe("http://h1:1");
  });

  test("type filter returns null when no proxy matches", async () => {
    seedProxies([{ id: 1, url: "http://h1:1", type: "http", status: "active" }]);
    seedSettings("all", "round_robin");
    expect(await getNextProxy("model", "socks5")).toBeNull();
  });

  test("sequential mode sticks to the same proxy until advanced", async () => {
    seedProxies([
      { id: 1, url: "http://a:1", type: "http", status: "active" },
      { id: 2, url: "http://b:2", type: "http", status: "active" },
    ]);
    seedSettings("all", "sequential");

    const p1 = await getNextProxy("model");
    const p2 = await getNextProxy("model");
    expect(p1?.url).toBe("http://a:1");
    expect(p2?.url).toBe("http://a:1");
  });

  test("getNextProxy triggers a background lastUsedAt update", async () => {
    seedProxies([{ id: 42, url: "http://a:1", type: "http", status: "active" }]);
    seedSettings("all", "round_robin");

    await getNextProxy("model");
    // The update is fire-and-forget (`void db.update(...)`); flush microtasks.
    await Promise.resolve();
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls[0]?.set).toHaveProperty("lastUsedAt");
  });
});

// ── markProxySuccess / markProxyFail ────────────────────────────────────────
describe("proxy-pool: markProxySuccess / markProxyFail", () => {
  beforeEach(resetState);

  test("markProxySuccess issues an update incrementing successCount", async () => {
    await markProxySuccess(7);
    expect(updateCalls).toHaveLength(1);
    const set = updateCalls[0]?.set ?? {};
    expect(set).toHaveProperty("successCount");
    expect(set).toHaveProperty("updatedAt");
    expect(set).not.toHaveProperty("errorMessage");
  });

  test("markProxyFail issues an update incrementing failCount and storing the error", async () => {
    await markProxyFail(9, "connection refused");
    expect(updateCalls).toHaveLength(1);
    const set = updateCalls[0]?.set ?? {};
    expect(set).toHaveProperty("failCount");
    expect(set).toHaveProperty("updatedAt");
    expect(set).toHaveProperty("errorMessage", "connection refused");
  });

  test("markProxyFail without error stores null errorMessage", async () => {
    await markProxyFail(10);
    const set = updateCalls[0]?.set ?? {};
    expect(set).toHaveProperty("errorMessage", null);
  });

  test("markProxyFail advances the sequential index so next call rotates", async () => {
    seedProxies([
      { id: 1, url: "http://a:1", type: "http", status: "active" },
      { id: 2, url: "http://b:2", type: "http", status: "active" },
    ]);
    seedSettings("all", "sequential");

    const first = await getNextProxy("model");
    expect(first?.url).toBe("http://a:1");

    await markProxyFail(first!.id, "dead");

    const second = await getNextProxy("model");
    expect(second?.url).toBe("http://b:2");
  });

  test("markProxyFail in round_robin mode does not affect round-robin cycling", async () => {
    seedProxies([
      { id: 1, url: "http://a:1", type: "http", status: "active" },
      { id: 2, url: "http://b:2", type: "http", status: "active" },
    ]);
    seedSettings("all", "round_robin");

    const p1 = await getNextProxy("model");
    await markProxyFail(p1!.id, "dead");
    const p2 = await getNextProxy("model");
    const p3 = await getNextProxy("model");

    expect(p1?.url).toBe("http://a:1");
    expect(p2?.url).toBe("http://b:2");
    expect(p3?.url).toBe("http://a:1");
  });
});

// ── parseProxyLine ──────────────────────────────────────────────────────────
describe("proxy-scraper: parseProxyLine", () => {
  // parseProxyLine is module-private, but it is exercised through scrapeProxies.
  // scrapeProxies fetches from the network, so we test the parser via a thin
  // re-export harness: import the module and use scrapeProxies with a stubbed
  // global fetch that returns canned text bodies.

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  test("parses valid protocol://host:port lines and normalizes schemes", async () => {
    const body = [
      "http://1.2.3.4:8080",
      "https://5.6.7.8:443",
      "socks5://9.10.11.12:1080",
      "socks5h://13.14.15.16:1080",
      "",
      "   ",
      "not-a-proxy",
      "ftp://17.18.19.20:21",
      "http://no-port",
      "http://host:notaport",
      "http://host:8080/extra/path",
      "socks4://21.22.23.24:1080",
    ].join("\n");

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(body, { status: 200 }),
      )) as unknown as typeof fetch;

    // scrapeProxies with source "all" would hit 3 endpoints; use "proxyscrape"
    // to limit to a single fetch. protocol "all" so nothing is filtered out.
    const { scrapeProxies } = await import("../../src/services/proxy-scraper");
    const out = await scrapeProxies({ source: "proxyscrape", country: "all", protocol: "all" });

    globalThis.fetch = originalFetch;

    expect(out).toEqual([
      { url: "http://1.2.3.4:8080", type: "http", country: null },
      { url: "http://5.6.7.8:443", type: "http", country: null },
      { url: "socks5://9.10.11.12:1080", type: "socks5", country: null },
      { url: "socks5://13.14.15.16:1080", type: "socks5", country: null },
    ]);
  });

  test("applies country tag when a specific country is requested", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("http://1.2.3.4:8080\n", { status: 200 }))) as unknown as typeof fetch;

    const { scrapeProxies } = await import("../../src/services/proxy-scraper");
    const out = await scrapeProxies({ source: "proxyscrape", country: "US", protocol: "all" });

    globalThis.fetch = originalFetch;

    expect(out).toHaveLength(1);
    expect(out[0]?.country).toBe("US");
  });

  test("trims surrounding whitespace from lines", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("  http://1.2.3.4:8080  \n", { status: 200 }))) as unknown as typeof fetch;

    const { scrapeProxies } = await import("../../src/services/proxy-scraper");
    const out = await scrapeProxies({ source: "proxyscrape", country: "all", protocol: "all" });

    globalThis.fetch = originalFetch;

    expect(out).toEqual([{ url: "http://1.2.3.4:8080", type: "http", country: null }]);
  });

  test("deduplicates identical proxy URLs", async () => {
    const body = "http://1.2.3.4:8080\nhttp://1.2.3.4:8080\nhttp://1.2.3.4:8080";
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const { scrapeProxies } = await import("../../src/services/proxy-scraper");
    const out = await scrapeProxies({ source: "proxyscrape", country: "all", protocol: "all" });

    globalThis.fetch = originalFetch;

    expect(out).toHaveLength(1);
  });

  test("respects the limit option", async () => {
    const body = "http://1.1.1.1:1\nhttp://2.2.2.2:2\nhttp://3.3.3.3:3";
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const { scrapeProxies } = await import("../../src/services/proxy-scraper");
    const out = await scrapeProxies({ source: "proxyscrape", country: "all", protocol: "all", limit: 2 });

    globalThis.fetch = originalFetch;

    expect(out).toHaveLength(2);
    expect(out.map((p) => p.url)).toEqual(["http://1.1.1.1:1", "http://2.2.2.2:2"]);
  });

  test("proxyscrape source does NOT client-side filter by protocol (characterization)", async () => {
    // scrapeProxyScrape passes `protocol` as an upstream query param but never
    // filters the parsed lines locally — unlike scrapeProxifly, which does
    // `.filter((p) => protocol === "all" || p.type === protocol)`. With a
    // stubbed fetch returning mixed protocols, all parsed proxies come back.
    const body = "http://1.1.1.1:1\nsocks5://2.2.2.2:2\nhttp://3.3.3.3:3";
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const { scrapeProxies } = await import("../../src/services/proxy-scraper");
    const out = await scrapeProxies({ source: "proxyscrape", country: "all", protocol: "socks5" });

    globalThis.fetch = originalFetch;

    expect(out).toHaveLength(3);
    expect(out.map((p) => p.url)).toEqual([
      "http://1.1.1.1:1",
      "socks5://2.2.2.2:2",
      "http://3.3.3.3:3",
    ]);
  });

  test("returns empty array when fetch fails (source failure is swallowed)", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    const { scrapeProxies } = await import("../../src/services/proxy-scraper");
    const out = await scrapeProxies({ source: "proxyscrape", country: "all", protocol: "all" });

    globalThis.fetch = originalFetch;

    expect(out).toEqual([]);
  });
});
