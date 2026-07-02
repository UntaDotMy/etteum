import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetchAlibabaModelGroups } from "@/lib/api";
import { AlertCircle, CheckCircle2, Layers } from "lucide-react";

interface ModelGroup {
  accounts: number[];
  count: number;
  emails: string[];
  quota: {
    totalLimit: number;
    totalRemaining: number;
  };
}

interface ErrorGroup {
  accounts: number[];
  count: number;
  emails: string[];
  reasons: string[];
}

interface Summary {
  totalAccounts: number;
  activeAccounts: number;
  errorAccounts: number;
  modelCount: number;
}

export function AlibabaModelGroups() {
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<Record<string, ModelGroup>>({});
  const [error, setError] = useState<ErrorGroup | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    loadModelGroups();
  }, []);

  const loadModelGroups = async () => {
    try {
      const response = await fetchAlibabaModelGroups();
      setModels(response.data.models);
      setError(response.data.error);
      setSummary(response.data.summary);
    } catch (err) {
      console.error("Failed to load model groups:", err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            Alibaba Model Groups
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">Loading model groups...</div>
        </CardContent>
      </Card>
    );
  }

  if (!summary) {
    return null;
  }

  const sortedModels = Object.entries(models).sort((a, b) => b[1].count - a[1].count);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5" />
          Alibaba Model Groups
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary */}
        <div className="grid grid-cols-4 gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold">{summary.totalAccounts}</div>
            <div className="text-sm text-muted-foreground">Total Accounts</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{summary.activeAccounts}</div>
            <div className="text-sm text-muted-foreground">Active</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-600">{summary.errorAccounts}</div>
            <div className="text-sm text-muted-foreground">Error</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">{summary.modelCount}</div>
            <div className="text-sm text-muted-foreground">Models</div>
          </div>
        </div>

        {/* Model Groups */}
        <div className="space-y-3">
          <h3 className="text-lg font-semibold">Queryable Models</h3>
          {sortedModels.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground">
              No models verified yet. Run warmup to verify model access.
            </div>
          ) : (
            <div className="grid gap-3">
              {sortedModels.map(([model, group]) => {
                const pct = group.quota.totalLimit > 0
                  ? (group.quota.totalRemaining / group.quota.totalLimit) * 100
                  : 0;
                const tone = pct <= 10
                  ? "bg-[var(--error)]"
                  : pct <= 40
                  ? "bg-[var(--warning)]"
                  : "bg-[var(--success)]";

                return (
                  <div
                    key={model}
                    className="p-4 border rounded-lg hover:bg-accent/50 transition-colors space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                        <div>
                          <div className="font-medium">{model}</div>
                          <div className="text-sm text-muted-foreground">
                            {group.count} account{group.count !== 1 ? "s" : ""}
                          </div>
                        </div>
                      </div>
                      <Badge variant="secondary">{group.count}</Badge>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-[var(--muted-foreground)]">
                          Aggregated Quota
                        </span>
                        <span className="text-[var(--foreground)] font-medium">
                          {group.quota.totalRemaining.toLocaleString()} / {group.quota.totalLimit.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
                        <div
                          className={`h-full ${tone} transition-all`}
                          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Error Group */}
        {error && error.count > 0 && (
          <div className="space-y-3">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-600" />
              Error / Not Verified
            </h3>
            <div className="p-4 border border-red-200 bg-red-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-red-900">
                  {error.count} account{error.count !== 1 ? "s" : ""} with issues
                </div>
                <Badge variant="destructive">{error.count}</Badge>
              </div>
              {error.reasons.length > 0 && (
                <div className="text-sm text-red-700 mt-2">
                  <div className="font-medium">Common issues:</div>
                  <ul className="list-disc list-inside mt-1">
                    {[...new Set(error.reasons)].slice(0, 3).map((reason, idx) => (
                      <li key={idx}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
