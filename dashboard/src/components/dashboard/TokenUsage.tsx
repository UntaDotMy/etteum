import { useEffect, useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import UsageChart from "./UsageChart";
import { formatNumber, parseUtcDate, modelColor } from "@/lib/utils";
import { fetchUsage } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";

interface TokenStats {
  total: number;
  prompt: number;
  completion: number;
  credits?: number;
}

interface ModelUsage {
  provider?: string;
  model: string;
  tokens: number;
  promptTokens?: number;
  completionTokens?: number;
  credits?: number;
  requests?: number;
  creditSource?: string;
  color: string;
}

interface TokenUsageProps {
  stats?: TokenStats;
  modelUsage?: ModelUsage[];
}

const defaultStats: TokenStats = {
  total: 0,
  prompt: 0,
  completion: 0,
  credits: 0,
};

const defaultModelUsage: ModelUsage[] = [];

/**
 * How many hours of data to request from the backend.
 *
 * We intentionally over-fetch so that the current local-timezone period is
 * fully covered regardless of the user's UTC offset.  The extra rows are
 * discarded during local-bucket mapping — only rows that land inside the
 * visible buckets contribute to the chart AND the summary cards.
 */
function getChartHours(period: string): number | null {
  if (period === "1d") return 48;
  if (period === "7d") return 24 * 8;
  if (period === "30d") return 24 * 31;
  return null; // "all"
}

function modelKey(row: { provider?: string; model?: string }) {
  return `${row.provider || "unknown"}/${row.model || "unknown"}`;
}

// ─── Local-timezone bucket helpers ──────────────────────────────────────────

/** Truncate a Date to the start of its hour in the user's local timezone */
function truncHourLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
}

/** Truncate a Date to the start of its day in the user's local timezone */
function truncDayLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Truncate a Date to the start of its month in the user's local timezone */
function truncMonthLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * Snap a UTC epoch (from the backend bucket key) to the corresponding
 * local-timezone bucket epoch.
 */
function snapToLocalBucket(utcEpoch: number, period: string): number {
  const d = new Date(utcEpoch);
  if (period === "1d") return truncHourLocal(d);
  if (period === "7d" || period === "30d") return truncDayLocal(d);
  return truncMonthLocal(d);
}

/** Convert a backend hour key (ISO UTC) to a numeric epoch (ms) */
function parseBucketKey(isoKey: string): number {
  return parseUtcDate(isoKey).getTime();
}

/** Format a bucket epoch to a display label in user's local timezone */
function formatLabel(epoch: number, period: string): string {
  const d = new Date(epoch);
  if (period === "1d") {
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  }
  if (period === "7d" || period === "30d") {
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Generate ordered bucket epochs for the chart, all in the user's local
 * timezone so labels read naturally.
 *
 * - **1d** — 25 hourly buckets as a rolling 24h window (now-24h → now).
 * - **7d** — 7 daily buckets ending today.
 * - **30d** — 30 daily buckets ending today.
 * - **all** — last 12 monthly buckets.
 */
function generateBuckets(period: string): number[] {
  const now = new Date();
  const buckets: number[] = [];

  if (period === "1d") {
    // Full calendar day: 00:00 → 00:00 (today)
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    for (let i = 0; i <= 24; i++) {
      buckets.push(todayStart + i * 3600_000);
    }
    return buckets;
  }

  if (period === "7d" || period === "30d") {
    const days = period === "7d" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      buckets.push(d.getTime());
    }
    return buckets;
  }

  // "all" — last 12 months
  for (let i = 11; i >= 0; i--) {
    buckets.push(new Date(now.getFullYear(), now.getMonth() - i, 1).getTime());
  }
  return buckets;
}

/** A single backend usage row */
interface UsageRow {
  hour: string;
  provider?: string;
  model?: string;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  credits?: number;
  count?: number;
}

/**
 * Filter backend rows to only those that fall inside the visible buckets,
 * then build chart data, stats totals, and per-model breakdown — all from
 * the **same** filtered dataset so the numbers always match the chart.
 */
function processUsageData(rows: UsageRow[], period: string) {
  const bucketEpochs = generateBuckets(period);
  const bucketSet = new Set(bucketEpochs);

  // ── 1. Identify which rows land inside visible buckets ────────────
  const visibleRows: Array<UsageRow & { localEpoch: number }> = [];
  for (const row of rows) {
    const utcEpoch = parseBucketKey(row.hour);
    const localEpoch = snapToLocalBucket(utcEpoch, period);
    if (bucketSet.has(localEpoch)) {
      visibleRows.push({ ...row, localEpoch });
    }
  }

  // ── 2. Build chart data (model × bucket) ──────────────────────────
  const models = Array.from(new Set(visibleRows.map(modelKey)));
  const byEpoch = new Map<number, Record<string, number | string>>();
  for (const epoch of bucketEpochs) {
    const entry: Record<string, number | string> = {
      hour: String(epoch),
      label: formatLabel(epoch, period),
    };
    for (const model of models) entry[model] = 0;
    byEpoch.set(epoch, entry);
  }
  for (const row of visibleRows) {
    const model = modelKey(row);
    const bucket = byEpoch.get(row.localEpoch)!;
    bucket[model] = Number(bucket[model] || 0) + Number(row.tokens || 0);
  }
  const chartData = bucketEpochs.map((epoch) => byEpoch.get(epoch)!);

  // ── 3. Compute stats totals from visible rows only ────────────────
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let credits = 0;
  for (const row of visibleRows) {
    totalTokens += Number(row.tokens || 0);
    promptTokens += Number(row.promptTokens || 0);
    completionTokens += Number(row.completionTokens || 0);
    credits += Number(row.credits || 0);
  }
  const stats: TokenStats = {
    total: totalTokens,
    prompt: promptTokens,
    completion: completionTokens,
    credits,
  };

  // ── 4. Compute per-model breakdown from visible rows only ─────────
  const modelMap = new Map<string, {
    provider: string;
    model: string;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    credits: number;
    requests: number;
  }>();
  for (const row of visibleRows) {
    const key = modelKey(row);
    const existing = modelMap.get(key);
    if (existing) {
      existing.tokens += Number(row.tokens || 0);
      existing.promptTokens += Number(row.promptTokens || 0);
      existing.completionTokens += Number(row.completionTokens || 0);
      existing.credits += Number(row.credits || 0);
      existing.requests += Number(row.count || 0);
    } else {
      modelMap.set(key, {
        provider: row.provider || "unknown",
        model: row.model || "unknown",
        tokens: Number(row.tokens || 0),
        promptTokens: Number(row.promptTokens || 0),
        completionTokens: Number(row.completionTokens || 0),
        credits: Number(row.credits || 0),
        requests: Number(row.count || 0),
      });
    }
  }
  const modelUsage: ModelUsage[] = Array.from(modelMap.values())
    .filter((m) => m.tokens > 0 || m.credits > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8)
    .map((m, idx) => ({
      ...m,
      creditSource: "estimated",
      color: modelColor(`${m.provider}/${m.model}`, idx),
    }));

  return { chartData, stats, modelUsage };
}

export default function TokenUsage({
  stats: externalStats = defaultStats,
  modelUsage: externalModelUsage = defaultModelUsage,
}: TokenUsageProps) {
  const [period, setPeriod] = useState("1d");
  const [chartData, setChartData] = useState<any[]>([]);
  const [filteredStats, setFilteredStats] = useState<TokenStats>(defaultStats);
  const [filteredModelUsage, setFilteredModelUsage] = useState<ModelUsage[]>([]);

  const stats = filteredStats;
  const modelUsage = filteredModelUsage;

  const maxTokens = Math.max(1, ...modelUsage.map((m) => Number(m.tokens || 0)));
  const colorsByModel = Object.fromEntries(
    modelUsage.map((model) => [`${model.provider || "unknown"}/${model.model || "unknown"}`, model.color]),
  );

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadData() {
    const hours = getChartHours(period);
    const range = period === "all" ? "all" : undefined;
    try {
      const usageRes = await fetchUsage(hours, range) as { data: UsageRow[] };
      const { chartData: chart, stats: s, modelUsage: m } = processUsageData(usageRes.data || [], period);
      setChartData(chart);
      setFilteredStats(s);
      setFilteredModelUsage(m);
    } catch {
      setChartData([]);
      setFilteredStats(defaultStats);
      setFilteredModelUsage([]);
    }
  }

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { loadData(); }, 500);
  };

  useEffect(() => {
    loadData();
    return () => { if (reloadRef.current) clearTimeout(reloadRef.current); };
  }, [period]);

  useWsEvent(["request_log", "request_error"], scheduleReload);

  return (
    <Card className="border-[var(--border)]">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Token Usage</CardTitle>
          <Tabs value={period} onValueChange={setPeriod}>
            <TabsList>
              <TabsTrigger value="1d">1d</TabsTrigger>
              <TabsTrigger value="7d">7d</TabsTrigger>
              <TabsTrigger value="30d">30d</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg bg-[var(--secondary)] p-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Total</p>
            <p className="text-xl font-bold mt-1">{formatNumber(stats.total)}</p>
          </div>
          <div className="rounded-lg bg-[var(--secondary)] p-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Prompt</p>
            <p className="text-xl font-bold mt-1">{formatNumber(stats.prompt)}</p>
          </div>
          <div className="rounded-lg bg-[var(--secondary)] p-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Completion</p>
            <p className="text-xl font-bold mt-1">{formatNumber(stats.completion)}</p>
          </div>
        </div>

        {/* Chart */}
        <div>
          <h4 className="text-sm font-medium text-[var(--muted-foreground)] mb-4">Token Usage Over Time</h4>
          <UsageChart data={chartData} period={period} colorsByModel={colorsByModel} />
        </div>

        {/* By Model */}
        <div>
          <h4 className="text-sm font-medium text-[var(--muted-foreground)] mb-4">By Model</h4>
          <div className="space-y-3">
            {modelUsage.map((model) => (
              <div key={`${model.provider || "unknown"}/${model.model}`} className="space-y-1">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span className="text-[var(--foreground)]">{model.provider ? `${model.provider}/` : ""}{model.model}</span>
                    <span className="ml-2 text-[10px] uppercase text-[var(--muted-foreground)]">{model.creditSource || "estimated"}</span>
                  </div>
                  <span className="shrink-0 text-[var(--muted-foreground)]">
                    {formatNumber(model.tokens)} tokens · {model.requests || 0} req
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[var(--secondary)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${(Number(model.tokens || 0) / maxTokens) * 100}%`,
                      backgroundColor: model.color,
                    }}
                  />
                </div>
              </div>
            ))}
            {modelUsage.length === 0 && (
              <p className="text-sm text-[var(--muted-foreground)]">No model usage yet</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
