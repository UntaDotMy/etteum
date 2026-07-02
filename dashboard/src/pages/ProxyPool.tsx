import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Globe, Plus, Trash2, Upload, RefreshCw, Power, PowerOff, Download } from "lucide-react";
import { fetchApi, fetchProxyCountries, scrapeProxies, type ProxyCountry } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ProxyEntry {
  id: number;
  url: string;
  type: string;
  label: string | null;
  status: string;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  successCount: number;
  failCount: number;
  createdAt: string;
}

interface ProxyPoolStatus {
  count: number;
  activeCount: number;
  proxies: ProxyEntry[];
}

export default function ProxyPool() {
  const [pool, setPool] = useState<ProxyPoolStatus>({ count: 0, activeCount: 0, proxies: [] });
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState("");
  const [checking, setChecking] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  // Scrape controls
  const [countries, setCountries] = useState<ProxyCountry[]>([]);
  const [scrapeSource, setScrapeSource] = useState<"all" | "proxyscrape" | "geonode" | "proxifly">("all");
  const [scrapeCountry, setScrapeCountry] = useState("all");
  const [scrapeProtocol, setScrapeProtocol] = useState<"all" | "http" | "socks5">("all");
  const [scrapeLimit, setScrapeLimit] = useState(50);
  const [scrapeVerify, setScrapeVerify] = useState(true);
  const [scraping, setScraping] = useState(false);

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<ProxyPoolStatus>("/api/proxy-pool/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, activeCount: 0, proxies: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPool();
    fetchProxyCountries()
      .then((data) => setCountries(data.countries))
      .catch(() => setCountries([{ code: "all", name: "Any region" }]));
  }, [loadPool]);

  const handleScrape = async () => {
    setScraping(true);
    try {
      const result = await scrapeProxies({
        source: scrapeSource,
        country: scrapeCountry,
        protocol: scrapeProtocol,
        limit: scrapeLimit,
        verify: scrapeVerify,
      });
      if (result.added > 0) {
        setMessage(
          `Scraped ${result.scraped}, ${result.added} added` +
            (scrapeVerify ? ` (${result.verified} alive)` : "") +
            (result.skipped > 0 ? `, ${result.skipped} duplicates skipped` : ""),
        );
      } else if (result.scraped === 0) {
        setMessage("No proxies found for that region/source");
      } else {
        setMessage(
          scrapeVerify && result.verified === 0
            ? `Scraped ${result.scraped} but none passed health check`
            : "All scraped proxies already in pool",
        );
      }
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Scrape failed");
    } finally {
      setScraping(false);
    }
  };

  const handleBulkAdd = async () => {
    if (!bulkText.trim()) {
      setMessage("Paste proxy list first");
      return;
    }

    const proxies = bulkText
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (proxies.length === 0) {
      setMessage("No valid proxies found");
      return;
    }

    try {
      const result = await fetchApi<{ added: number }>("/api/proxy-pool/pool", {
        method: "POST",
        body: JSON.stringify({ proxies }),
      });
      setBulkText("");
      setMessage(`${result.added} proxy added`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to add proxies");
    }
  };

  const handleToggle = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to toggle proxy");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
      setMessage("Proxy removed");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to remove proxy");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all proxies from pool?")) return;
    try {
      await fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
      setMessage("Pool cleared");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to clear pool");
    }
  };

  const handleCheckSingle = async (id: number) => {
    try {
      const result = await fetchApi<{ ok: boolean; latencyMs: number; error?: string }>(
        `/api/proxy-pool/pool/${id}/check`,
        { method: "POST" }
      );
      setMessage(result.ok ? `Healthy (${result.latencyMs}ms)` : `Failed: ${result.error}`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Health check failed");
    }
  };

  const handleCheckAll = async () => {
    setChecking(true);
    try {
      const result = await fetchApi<{ checked: number }>("/api/proxy-pool/pool/check-all", {
        method: "POST",
      });
      setMessage(`Checked ${result.checked} proxies`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Check all failed");
    } finally {
      setChecking(false);
    }
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: "bg-[var(--success)]/10 text-[var(--success)]",
      disabled: "bg-[var(--warning)]/10 text-[var(--warning)]",
      error: "bg-[var(--error)]/10 text-[var(--error)]",
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded ${colors[status] || "bg-[var(--muted)]/10 text-[var(--muted-foreground)]"}`}>
        {status}
      </span>
    );
  };

  const latencyBadge = (ms: number | null) => {
    if (ms == null) return null;
    const color =
      ms < 1000 ? "text-[var(--success)]" :
      ms < 3000 ? "text-[var(--warning)]" :
      "text-[var(--error)]";
    return (
      <span className={`text-xs font-mono shrink-0 ${color}`}>
        {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
      </span>
    );
  };

  const maskUrl = (url: string) => {
    try {
      const u = new URL(url);
      const masked = u.password ? `${u.protocol}//${u.username}:***@${u.host}` : `${u.protocol}//${u.host}`;
      return masked;
    } catch {
      return url;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Proxy Pool</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Manage HTTP/SOCKS5 proxies for upstream requests and auth
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">
            {pool.activeCount}/{pool.count} active
          </span>
          <Button variant="outline" size="sm" onClick={handleCheckAll} disabled={checking}>
            <RefreshCw className={`w-3 h-3 mr-1 ${checking ? "animate-spin" : ""}`} />
            Check All
          </Button>
          {pool.count > 0 && (
            <Button variant="outline" size="sm" onClick={handleClearAll}>
              <Trash2 className="w-3 h-3 mr-1" />
              Clear All
            </Button>
          )}
        </div>
      </div>

      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">
          {message}
        </div>
      )}

      {/* Add Proxies */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Add Proxies
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            className="w-full h-[120px] px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            placeholder={"Paste proxy list (one per line):\n\nhttp://user:pass@host:port\nsocks5://host:port\nhttp://host:port"}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <Button onClick={handleBulkAdd} className="w-full">
            <Upload className="w-4 h-4 mr-2" />
            Add to Pool
          </Button>
        </CardContent>
      </Card>

      {/* Scrape Proxies */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Download className="w-4 h-4" />
            Scrape Proxies
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--muted-foreground)]">
            Pull fresh proxies from free public sources and add them straight to the pool.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Source</label>
              <select
                className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                value={scrapeSource}
                onChange={(e) => setScrapeSource(e.target.value as typeof scrapeSource)}
              >
                <option value="all">All sources</option>
                <option value="proxyscrape">ProxyScrape</option>
                <option value="geonode">Geonode</option>
                <option value="proxifly">Proxifly</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Region</label>
              <select
                className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                value={scrapeCountry}
                onChange={(e) => setScrapeCountry(e.target.value)}
              >
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Protocol</label>
              <select
                className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                value={scrapeProtocol}
                onChange={(e) => setScrapeProtocol(e.target.value as typeof scrapeProtocol)}
              >
                <option value="all">HTTP + SOCKS5</option>
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Max count</label>
              <input
                type="number"
                min={1}
                max={500}
                className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                value={scrapeLimit}
                onChange={(e) => setScrapeLimit(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] cursor-pointer">
              <input
                type="checkbox"
                checked={scrapeVerify}
                onChange={(e) => setScrapeVerify(e.target.checked)}
              />
              Health-check before adding (slower, but only keeps working proxies)
            </label>
            <Button onClick={handleScrape} disabled={scraping}>
              <Download className={`w-4 h-4 mr-2 ${scraping ? "animate-pulse" : ""}`} />
              {scraping ? "Scraping..." : "Scrape & Add"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Proxy List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="w-4 h-4" />
            Proxy List
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
          ) : pool.proxies.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              No proxies in pool. Add proxies above to enable IP rotation.
            </p>
          ) : (
            <div className="space-y-2">
              {pool.proxies.map((proxy) => (
                <div
                  key={proxy.id}
                  className="flex items-center justify-between px-4 py-3 rounded-md bg-[var(--secondary)]"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Globe className="w-4 h-4 text-[var(--muted-foreground)] shrink-0" />
                    <span className="font-mono text-sm truncate">{maskUrl(proxy.url)}</span>
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0">{proxy.type}</span>
                    {statusBadge(proxy.status)}
                    {latencyBadge(proxy.latencyMs)}
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                      {proxy.successCount}ok / {proxy.failCount}fail
                    </span>
                    {proxy.lastUsedAt && (
                      <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                        used {new Date(proxy.lastUsedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCheckSingle(proxy.id)}
                      title="Health check"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggle(proxy.id, proxy.status)}
                      title={proxy.status === "active" ? "Disable" : "Enable"}
                    >
                      {proxy.status === "active" ? (
                        <PowerOff className="w-3 h-3" />
                      ) : (
                        <Power className="w-3 h-3" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(proxy.id)}
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
