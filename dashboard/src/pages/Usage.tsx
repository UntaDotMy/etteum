import TokenUsage from "@/components/dashboard/TokenUsage";
import { fetchDashboardStats, fetchModelUsage } from "@/lib/api";
import { modelColor } from "@/lib/utils";
import { useApiCache } from "@/hooks/useApiCache";

export default function Usage() {
  const { data: stats } = useApiCache<any>(
    "usage-stats",
    () => fetchDashboardStats(),
    { staleTime: 5000, wsEvents: ["request_log", "request_error"] }
  );

  const { data: modelStatsRes } = useApiCache<{ data: any[] }>(
    "usage-models",
    () => fetchModelUsage(),
    { staleTime: 5000, wsEvents: ["request_log", "request_error"] }
  );

  const modelStats = modelStatsRes?.data || [];

  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
  };

  const modelUsage = modelStats.map((m: any, idx: number) => ({
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
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Usage</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Detailed token and credit usage analytics
        </p>
      </div>

      <TokenUsage stats={tokenStats} modelUsage={modelUsage} />
    </div>
  );
}
