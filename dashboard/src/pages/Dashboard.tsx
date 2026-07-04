import StatsCards from "@/components/dashboard/StatsCards";
import TokenUsage from "@/components/dashboard/TokenUsage";
import { fetchDashboardStats, fetchModelUsage } from "@/lib/api";
import { modelColor } from "@/lib/utils";
import { useApiCache } from "@/hooks/useApiCache";

export default function Dashboard() {
  // SWR-style caching: instant load from cache, revalidate in background
  const { data: stats } = useApiCache<any>(
    "dashboard-stats",
    () => fetchDashboardStats(undefined, "all"),
    {
      staleTime: 5000,
      wsEvents: [
        "request_log", "request_error", "account_status",
        "account_updated", "account_created", "account_deleted",
        "accounts_updated", "accounts_bulk_created", "provider_toggled",
      ],
    }
  );

  const { data: modelStatsRes } = useApiCache<{ data: any[] }>(
    "dashboard-models",
    () => fetchModelUsage(undefined, "all"),
    { staleTime: 5000, wsEvents: ["request_log", "request_error"] }
  );

  const modelStats = modelStatsRes?.data || [];

  const totalRequests = Number(stats?.requests?.total || 0);
  const successRequests = Number(stats?.requests?.success || 0);
  const dashboardStats = {
    accounts: {
      active: Number(stats?.pool?.active || 0),
      total: Number(stats?.pool?.total || 0),
    },
    requests: totalRequests,
    successRate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(1)) : 0,
    totalTokens: Number(stats?.tokens?.total || 0),
  };

  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
  };

  const modelUsage = modelStats
    .filter((m: any) => Number(m.totalTokens || 0) > 0 || Number(m.credits || 0) > 0)
    .slice(0, 8)
    .map((m: any, idx: number) => ({
      provider: m.provider || "unknown",
      model: m.model || "unknown",
      tokens: Number(m.totalTokens || 0),
      promptTokens: Number(m.promptTokens || 0),
      completionTokens: Number(m.completionTokens || 0),
      credits: Number(m.credits || 0),
      requests: Number(m.totalRequests || 0),
      creditSource: m.creditSource || "estimated",
      color: modelColor(`${m.provider || "unknown"}/${m.model || "unknown"}`, idx),
    }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Dashboard</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Overview of your proxy pool status
        </p>
      </div>

      <StatsCards data={dashboardStats} />
      <TokenUsage stats={tokenStats} modelUsage={modelUsage} />
    </div>
  );
}
