import { useEffect, useRef, useState, useCallback } from "react";
import { useWsEvent } from "@/hooks/useWebSocket";
import { Card, CardContent } from "@/components/ui/card";
import { fetchProviders, fetchRecentRequests } from "@/lib/api";
import ProviderTopology from "@/components/dashboard/ProviderTopology";
import { Activity, Network } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────

interface ProviderActivity {
  provider: string;
  requests: number;
  tokens: number;
  credits: number;
  cost: number;
  errors: number;
  color: string;
  activeNow: boolean;
}

const PROVIDER_COLORS: Record<string, string> = {
  kiro: "#10b981",
  "kiro-pro": "#059669",
  codebuddy: "#6366f1",
  "codebuddy-china": "#4f46e5",
  codex: "#f59e0b",
  canva: "#ec4899",
  qoder: "#8b5cf6",
  "gitlab-duo": "#e11d48",
  youmind: "#06b6d4",
  byok: "#78716c",
  alibaba: "#ef4444",
};

function providerColor(p: string): string {
  return PROVIDER_COLORS[p] || "#6b7280";
}

function shortProvider(p: string): string {
  const map: Record<string, string> = {
    "kiro-pro": "Kiro P",
    "codebuddy-china": "CBC CN",
    "gitlab-duo": "GL Duo",
  };
  return map[p] || p.charAt(0).toUpperCase() + p.slice(1);
}

// ── Component ───────────────────────────────────────────────────────

export default function Analytics() {
  const [providers, setProviders] = useState<Record<string, ProviderActivity>>({});
  const [recentRequests, setRecentRequests] = useState<any[]>([]);
  const [activeProviders, setActiveProviders] = useState<Set<string>>(new Set());
  const [errorProviders, setErrorProviders] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Load historical data on mount.
  // Uses /api/stats/providers, which returns every provider that has at least
  // one account (the quotaStats join on `accounts` guarantees presence even
  // with zero requests) — so the topology shows only providers-with-accounts,
  // not the full 11-provider registry.
  useEffect(() => {
    async function loadHistorical() {
      try {
        const [provRes, recent] = await Promise.all([
          fetchProviders(),
          fetchRecentRequests(15),
        ]);
        if (Array.isArray(provRes?.data)) {
          const map: Record<string, ProviderActivity> = {};
          for (const row of provRes.data as any[]) {
            if (!row?.provider) continue;
            map[row.provider] = {
              provider: row.provider,
              requests: row.totalRequests || 0,
              tokens: row.totalTokens || 0,
              credits: row.creditsUsed || 0,
              cost: Number(row.totalCost || 0),
              errors: row.errorRequests || 0,
              color: providerColor(row.provider),
              activeNow: false,
            };
          }
          setProviders((prev) => {
            // Preserve any live state already received since mount.
            const merged = { ...map };
            for (const [k, v] of Object.entries(prev)) {
              if (!merged[k]) merged[k] = v;
              else merged[k].activeNow = v.activeNow;
            }
            return merged;
          });
        }
        // Seed the live feed from the DB so a refresh doesn't wipe it.
        if (Array.isArray(recent?.data)) {
          setRecentRequests(
            recent.data.map((r: any) => ({
              provider: r.provider || "unknown",
              model: r.model || "unknown",
              input: r.promptTokens || 0,
              output: r.completionTokens || 0,
              tokens: r.totalTokens || 0,
              cost: Number(r.cost || 0),
              status: r.status === "error" ? "error" : "success",
              timestamp: r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
            })),
          );
        }
      } catch {
        // silently ignore
      } finally {
        setLoading(false);
      }
    }
    loadHistorical();
  }, []);

  // Handle incoming WebSocket events
  const handleEvent = useCallback((msg: any) => {
    const d = msg?.data;
    if (!d) return;

    const provider = d.provider || "unknown";
    const model = d.model || "unknown";
    const inputTokens = d.promptTokens || 0;
    const outputTokens = d.completionTokens || 0;
    const tokens = d.totalTokens || inputTokens + outputTokens || 0;
    const credits = d.creditsUsed || 0;
    const cost = Number(d.cost || 0);
    const isError = msg.type === "request_error" || d.status === "error";

    // Update provider stats
    setProviders((prev) => {
      const existing = prev[provider] || {
        provider,
        requests: 0,
        tokens: 0,
        credits: 0,
        cost: 0,
        errors: 0,
        color: providerColor(provider),
        activeNow: false,
      };
      return {
        ...prev,
        [provider]: {
          ...existing,
          requests: existing.requests + 1,
          tokens: existing.tokens + tokens,
          credits: existing.credits + credits,
          cost: Number(existing.cost || 0) + cost,
          errors: existing.errors + (isError ? 1 : 0),
        },
      };
    });

    // Update active providers
    if (msg.type === "request_log") {
      setActiveProviders((prev) => {
        const next = new Set(prev);
        next.add(provider);
        return next;
      });
      // Clear active state after 5s of no activity
      setTimeout(() => {
        setActiveProviders((prev) => {
          const next = new Set(prev);
          next.delete(provider);
          return next;
        });
      }, 5000);
    }

    if (isError) {
      setErrorProviders((prev) => {
        const next = new Set(prev);
        next.add(provider);
        return next;
      });
    }

    // Update recent requests (compact live feed — last 15)
    setRecentRequests((prev) => {
      const next = [{
        provider,
        model,
        input: inputTokens,
        output: outputTokens,
        tokens,
        cost,
        status: isError ? "error" : "success",
        timestamp: Date.now(),
      }, ...prev];
      return next.slice(0, 15);
    });
  }, []);

  useWsEvent(["request_log", "request_error"], handleEvent);

  // Build topology data — include EVERY loaded provider (providers-with-
  // accounts), not just ones with traffic, so idle providers render as gray
  // nodes. Sort by request count so busy nodes cluster near the hub.
  const topologyProviders = Object.values(providers)
    .sort((a, b) => b.requests - a.requests)
    .map((p) => ({
      provider: p.provider,
      count: p.requests,
      active: activeProviders.has(p.provider),
      error: errorProviders.has(p.provider),
    }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Analytics</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Live request map and provider activity
        </p>
      </div>

      {/* ═══ TOPOLOGY MAP ═══ */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Network className="w-5 h-5 text-[var(--primary)]" />
            <h2 className="text-base font-semibold text-[var(--foreground)]">
              Provider Topology
            </h2>
            <span className="text-xs text-[var(--muted-foreground)] ml-auto">
              {activeProviders.size > 0
                ? `${activeProviders.size} active · ${errorProviders.size} errors`
                : "Idle — activity will appear live"}
            </span>
          </div>
          {loading ? (
            <div className="h-[300px] sm:h-[400px] w-full rounded-lg border border-[var(--border)] flex items-center justify-center text-sm text-[var(--muted-foreground)]">
              Loading providers...
            </div>
          ) : (
            <ProviderTopology providers={topologyProviders} />
          )}
        </CardContent>
      </Card>

      {/* ═══ Legend ═══ */}
      <div className="flex items-center gap-4 px-1 text-xs text-[var(--muted-foreground)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full bg-[#22c55e]" />
          Active request
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full bg-[#ef4444]" />
          Error
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded border border-[var(--border)] bg-transparent" />
          Idle / connected
        </span>
        <span className="text-[var(--muted-foreground)] ml-auto">
          Pro tip: Drag to pan · Scroll to zoom
        </span>
      </div>

      {/* ═══ Live Request Feed ═══ */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-[var(--foreground)] flex items-center gap-2">
              <Activity className="w-4 h-4 text-[var(--muted-foreground)]" />
              Live Request Feed
            </h3>
            <span className="text-xs text-[var(--muted-foreground)]">
              {recentRequests.length > 0 ? `${recentRequests.length} recent` : "idle"}
            </span>
          </div>
          {recentRequests.length === 0 ? (
            <p className="text-xs text-[var(--muted-foreground)] py-4 text-center">
              No requests yet — activity will appear here live.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-md border border-[var(--border)]">
              <table className="w-full text-[11px] tabular-nums">
                <thead className="sticky top-0 z-10 bg-[var(--secondary)] text-[var(--muted-foreground)]">
                  <tr>
                    <th className="text-left font-medium px-2.5 py-1.5 w-[14%]">Provider</th>
                    <th className="text-left font-medium px-2.5 py-1.5">Model</th>
                    <th className="text-right font-medium px-2.5 py-1.5 w-[14%] text-[var(--primary)]">Input ↑</th>
                    <th className="text-right font-medium px-2.5 py-1.5 w-[14%]">Output ↓</th>
                    <th className="text-right font-medium px-2.5 py-1.5 w-[12%] text-[var(--success)]">Cost</th>
                    <th className="text-right font-medium px-2.5 py-1.5 w-[10%]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRequests.map((r, i) => (
                    <tr
                      key={i}
                      className="border-t border-[var(--border)] hover:bg-[var(--secondary)]/50"
                    >
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="inline-block w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: providerColor(r.provider || "") }}
                          />
                          <span className="text-[var(--muted-foreground)] font-medium truncate">
                            {shortProvider(r.provider || "")}
                          </span>
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5">
                        <span className="text-[var(--foreground)] truncate block max-w-[220px]">
                          {(r.model || "").split("/").pop()}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-[var(--primary)]" title="Input tokens (prompt)">
                        {(r.input || 0).toLocaleString()}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-[var(--muted-foreground)]" title="Output tokens (completion)">
                        {(r.output || 0).toLocaleString()}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-[var(--success)]" title="USD cost">
                        {Number(r.cost || 0) > 0 ? `$${Number(r.cost).toFixed(4)}` : "-"}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        <span className={r.status === "error" ? "text-[var(--destructive)]" : "text-[var(--success)]"}>
                          {r.status === "error" ? "ERR" : "OK"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
