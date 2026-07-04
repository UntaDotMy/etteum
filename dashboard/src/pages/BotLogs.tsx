import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clearAuthLogs, fetchAuthLogs, fetchAuthQueue, fetchWarmupQueue, loginAccount, loginAccounts, stopAllAccounts, stopWarmup } from "@/lib/api";
import { useWsEvent, useWsStatus } from "@/hooks/useWebSocket";
import { useApiCache } from "@/hooks/useApiCache";
import { AlertTriangle, CheckCircle, ChevronDown, Loader2, RefreshCw, RotateCcw, Trash2, Radio, StopCircle, Globe } from "lucide-react";
import { formatTimeID } from "@/lib/utils";

interface AuthLog {
  id: number;
  timestamp: string;
  type: string;
  accountId?: number;
  email?: string;
  provider?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
}

interface ProcessLog {
  key: string;
  operation: string;
  latest: AuthLog;
  events: AuthLog[];
  startedAt: string;
  updatedAt: string;
}

const liveTypes: string[] = [
  "queue_added", "queue_processing", "login_progress", "login_success", "login_failed", "queue_complete", "queue_cleared",
];

function statusVariant(type: string): "success" | "warning" | "error" | "secondary" {
  if (type.includes("success") || type === "queue_complete" || type === "warmup_complete") return "success";
  if (type.includes("failed") || type.includes("auth_error")) return "error";
  if (type.includes("processing") || type.includes("progress") || type.includes("exhausted") || type.includes("transient") || type.includes("unsupported")) return "warning";
  return "secondary";
}

function processStatusVariant(process: ProcessLog): "success" | "warning" | "error" | "secondary" {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusVariant(process.latest.type);
}

function processStatusLabel(process: ProcessLog) {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusLabel(process.latest.type);
}

function providerLabel(provider?: string) {
  if (!provider) return "-";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  if (provider === "gitlab-duo") return "GitLab Duo";
  if (provider === "antigravity") return "Antigravity";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function operationFor(type: string) {
  if (type.startsWith("login_")) return "login";
  if (type.startsWith("warmup_")) return "warmup";
  if (type.startsWith("queue_")) return "queue";
  return type;
}

function processKey(log: AuthLog) {
  const operation = operationFor(log.type);
  const account = log.email || `#${log.accountId}`;
  return `${operation}-${account}`;
}

function statusLabel(type: string) {
  return type.replace(/^login_/, "").replace(/^warmup_/, "").replace(/^queue_/, "").replace(/_/g, " ");
}

function mergeLogs(current: AuthLog[], incoming: AuthLog[]) {
  const map = new Map<string, AuthLog>();
  for (const log of [...current, ...incoming]) {
    const key = `${log.id}-${log.timestamp}-${log.type}-${log.accountId || ""}-${log.step || ""}`;
    map.set(key, log);
  }
  return [...map.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function logsToProcesses(logs: AuthLog[]): ProcessLog[] {
  const groups = new Map<string, ProcessLog>();
  const oldestFirst = [...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const log of oldestFirst) {
    const key = processKey(log);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        operation: operationFor(log.type),
        latest: log,
        events: [log],
        startedAt: log.timestamp,
        updatedAt: log.timestamp,
      });
    } else {
      existing.events.push(log);
      existing.latest = log;
      existing.updatedAt = log.timestamp;
    }
  }

  return [...groups.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export default function BotLogs() {
  const [logs, setLogs] = useState<AuthLog[]>([]);
  const [stoppingWarmup, setStoppingWarmup] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [liveConsole, setLiveConsole] = useState<AuthLog[]>([]);
  const [captchaText, setCaptchaText] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const perPage = 25;
  const queueRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsStatus = useWsStatus();
  const connected = wsStatus === "open";

  const { data: queue, mutate: mutateQueue } = useApiCache(
    "botlogs-queue",
    () => fetchAuthQueue().catch(() => null),
    { staleTime: 2000, wsEvents: ["queue_added", "queue_processing", "queue_complete", "queue_cleared"] }
  );

  const { data: warmupQueue } = useApiCache(
    "botlogs-warmup-queue",
    () => fetchWarmupQueue().catch(() => null),
    { staleTime: 5000, wsEvents: ["warmup_added", "warmup_processing", "warmup_complete", "warmup_cleared"] }
  );

  const { data: logsRes } = useApiCache(
    "botlogs-logs",
    () => fetchAuthLogs(200).catch(() => []),
    { staleTime: 5000, wsEvents: liveTypes }
  );

  useEffect(() => {
    if (logsRes && Array.isArray(logsRes)) {
      const filtered = logsRes.filter((log: AuthLog) => !log.type.startsWith("warmup_"));
      setLogs((current) => mergeLogs(current, filtered));
    }
  }, [logsRes]);

  const load = useCallback(async () => {
    await mutateQueue();
    try {
      const fresh = await fetchAuthLogs(200);
      if (Array.isArray(fresh)) {
        const filtered = fresh.filter((log: AuthLog) => !log.type.startsWith("warmup_"));
        setLogs((current) => mergeLogs(current, filtered));
      }
    } catch (err) {
      console.error("Failed to load logs:", err);
    }
  }, [mutateQueue]);

  const scheduleQueueRefresh = useCallback(() => {
    if (queueRefreshTimerRef.current) clearTimeout(queueRefreshTimerRef.current);
    queueRefreshTimerRef.current = setTimeout(() => {
      mutateQueue();
      queueRefreshTimerRef.current = null;
    }, 1500);
  }, [mutateQueue]);

  useWsEvent(liveTypes, (msg) => {
    if (msg.type.startsWith("warmup_")) return;

    const data = msg.data || {};
    const log: AuthLog = {
      id: data.logId || data.id || Date.now(),
      timestamp: data.timestamp || new Date().toISOString(),
      type: msg.type,
      accountId: data.accountId || data.id,
      email: data.email,
      provider: data.provider,
      step: data.step,
      message: data.message || data.error || msg.type,
      error: data.error,
      data,
    };
    setLogs((current) => mergeLogs(current, [log]));
    if (log.step === "browser_host" || log.step === "manual_challenge" || msg.type === "login_progress" || msg.type === "queue_processing") {
      setLiveConsole((current) => {
        const next = [...current, log];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    }
    scheduleQueueRefresh();
  });

  const failed = useMemo(() => logs.filter((log) => log.type === "login_failed"), [logs]);
  const failedAccounts = useMemo(() => {
    const map = new Map<string, AuthLog>();
    for (const log of failed) {
      const key = `${log.accountId || log.email || log.id}-${log.provider || "unknown"}`;
      if (!map.has(key) || new Date(log.timestamp).getTime() > new Date(map.get(key)!.timestamp).getTime()) {
        map.set(key, log);
      }
    }
    return [...map.values()];
  }, [failed]);

  const processes = useMemo(() => logsToProcesses(logs), [logs]);
  const totalQueued = queue?.queued || 0;
  const totalProgress = queue?.active || 0;
  const totalSuccess = logs.filter((log) => log.type === "login_success").length;
  const totalFailed = failedAccounts.length;
  const warmupRunning = warmupQueue?.active || 0;
  const warmupQueued = warmupQueue?.queued || 0;

  async function handleStopAll() {
    await stopAllAccounts();
    await load().catch(() => {});
  }

  async function handleStopWarmup() {
    setStoppingWarmup(true);
    try {
      await stopWarmup();
    } finally {
      setStoppingWarmup(false);
    }
  }

  async function handleClear() {
    await clearAuthLogs();
    setLogs([]);
    setLiveConsole([]);
    await load().catch(() => {});
  }

  async function handleRetry(accountId?: number) {
    if (!accountId) return;
    await loginAccount(accountId);
    await load().catch(() => {});
  }

  async function handleRetryAll() {
    const ids = Array.from(new Set(failedAccounts.map((log) => log.accountId).filter((id): id is number => Boolean(id))));
    if (ids.length === 0) return;
    await loginAccounts(ids);
    await load().catch(() => {});
  }

  async function handleCaptchaSubmit() {
    if (!captchaText.trim()) return;
    setCaptchaLoading(true);
    try {
      // TODO: send captcha text to the running session via API
      console.log("Captcha text:", captchaText);
      setCaptchaText("");
    } finally {
      setCaptchaLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Browser Logs</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Live progress for auto-login bot, including failed accounts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={connected ? "success" : "secondary"}>{connected ? "Live" : "Disconnected"}</Badge>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4 mr-2" />Refresh</Button>
          <Button variant="destructive" size="sm" onClick={handleStopAll}><StopCircle className="w-4 h-4 mr-2" />Stop All</Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleStopWarmup}
            disabled={stoppingWarmup || (warmupRunning === 0 && warmupQueued === 0)}
            title="Drop queued warmup jobs and abort in-flight provider calls"
          >
            {stoppingWarmup ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <StopCircle className="w-4 h-4 mr-2" />}
            Stop WarmUp
          </Button>
          <Button variant="outline" size="sm" onClick={handleClear}><Trash2 className="w-4 h-4 mr-2" />Clear</Button>
        </div>
      </div>

      {/* Browser surface — live console */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2"><Radio className="w-4 h-4 text-[var(--primary)]" />Browser surface</CardTitle>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">Click and type to forward input into the browser. Live raw events below; solve CAPTCHAs in the popup modal.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setLiveConsole([])} disabled={liveConsole.length === 0}>
              <Trash2 className="w-4 h-4 mr-2" />Clear live console
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {liveConsole.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--primary)] mb-3"></div>
              <p className="text-sm text-[var(--muted-foreground)]">Browser frame ended with the session.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* CAPTCHA input */}
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={captchaText}
                  onChange={(e) => setCaptchaText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCaptchaSubmit(); }}
                  placeholder="Enter captcha text"
                  disabled={captchaLoading}
                  className="flex-1"
                />
                <Button onClick={handleCaptchaSubmit} disabled={!captchaText.trim() || captchaLoading}>
                  {captchaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit"}
                </Button>
              </div>
              {/* Live console */}
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-xs">
                {[...liveConsole].reverse().map((log, i) => (
                  <div key={`${log.id}-${i}`} className="flex items-center gap-2">
                    <span className="text-[var(--muted-foreground)]">{formatTimeID(log.timestamp)}</span>
                    {log.step === "browser_host" && <Globe className="h-3 w-3 text-[var(--primary)]" />}
                    {log.step === "manual_challenge" && <AlertTriangle className="h-3 w-3 text-[var(--warning)]" />}
                    <span className={log.step === "browser_host" ? "text-[var(--primary)]" : log.step === "manual_challenge" ? "text-[var(--warning)]" : "text-[var(--foreground)]"}>
                      {log.step || log.type}
                    </span>
                    <span className="flex-1 truncate text-[var(--muted-foreground)]">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {!queue && !logsRes ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--primary)]"></div>
        </div>
      ) : (
      <>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">Queue</p><p className="text-2xl font-bold">{totalQueued}</p></CardContent></Card>
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">Progress</p><p className="text-2xl font-bold text-[var(--warning)]">{totalProgress}</p></CardContent></Card>
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">Success</p><p className="text-2xl font-bold text-[var(--success)]">{totalSuccess}</p></CardContent></Card>
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">Failed</p><p className="text-2xl font-bold text-[var(--error)]">{totalFailed}</p></CardContent></Card>
      </div>

      {(totalProgress > 0 || totalQueued > 0) && (
        <div className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-sm text-[var(--warning)] flex items-center gap-2">
          <Radio className="w-4 h-4 animate-pulse" />
          Sedang berjalan: {totalProgress} processing, {totalQueued} queued. Log akan update otomatis.
        </div>
      )}

      {failedAccounts.length > 0 && (
        <Card className="border-[var(--error)]/30 bg-[var(--error)]/5">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-[var(--error)]" /> Failed Accounts</CardTitle>
              <Button variant="outline" size="sm" onClick={handleRetryAll}>
                <RotateCcw className="mr-2 h-4 w-4" /> Retry All ({failedAccounts.length})
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-md border border-[var(--error)]/20">
              {failedAccounts.map((log) => (
                <div key={`failed-${log.accountId || log.id}-${log.provider || "unknown"}`} className="grid grid-cols-[1fr_auto] gap-3 border-b border-[var(--error)]/10 px-3 py-2 text-sm last:border-0 md:grid-cols-[240px_140px_1fr_auto]">
                  <div className="truncate font-medium text-[var(--foreground)]">{log.email || `Account #${log.accountId}`}</div>
                  <div className="text-xs text-[var(--muted-foreground)] md:text-sm">{providerLabel(log.provider)}</div>
                  <div className="col-span-2 truncate text-xs text-[var(--error)] md:col-span-1" title={log.error || log.message}>{log.error || log.message}</div>
                  <Button variant="ghost" size="sm" onClick={() => handleRetry(log.accountId)} disabled={!log.accountId}>
                    <RotateCcw className="mr-1 h-3 w-3" /> Retry
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-[var(--border)]">
        <CardHeader><CardTitle className="text-base">Browser Sessions</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Time</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Status</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden md:table-cell">Account</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden md:table-cell">Provider</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden lg:table-cell">Step</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Message</th>
                </tr>
              </thead>
              <tbody>
                {processes.slice((page - 1) * perPage, page * perPage).map((process) => (
                  <Fragment key={process.key}>
                    <tr
                      className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50"
                      onClick={() => setExpanded((current) => current === process.key ? null : process.key)}
                    >
                      <td className="p-4 text-xs text-[var(--muted-foreground)] font-mono">{formatTimeID(process.updatedAt)}</td>
                      <td className="p-4"><Badge variant={processStatusVariant(process)}>{processStatusLabel(process)}</Badge></td>
                      <td className="p-4 text-sm text-[var(--foreground)] hidden md:table-cell">{process.latest.email || (process.latest.accountId ? `#${process.latest.accountId}` : "-")}</td>
                      <td className="p-4 text-sm text-[var(--muted-foreground)] hidden md:table-cell">{providerLabel(process.latest.provider)}</td>
                      <td className="p-4 text-xs text-[var(--muted-foreground)] hidden lg:table-cell">{process.latest.step || process.operation}</td>
                      <td className="p-4 text-sm text-[var(--muted-foreground)]">
                        <div className="flex items-center gap-2">
                          {processStatusLabel(process) === "success" && <CheckCircle className="w-4 h-4 text-[var(--success)]" />}
                          {processStatusLabel(process) === "error" && <AlertTriangle className="w-4 h-4 text-[var(--error)]" />}
                          {processStatusLabel(process) !== "success" && processStatusLabel(process) !== "error" && (process.latest.type === "login_progress" || process.latest.type === "queue_processing" || process.latest.type === "warmup_processing") && <span className="h-2 w-2 rounded-full bg-[var(--warning)]" />}
                          {(() => {
                            const host = [...process.events].reverse().find((e) => e.step === "browser_host")?.message;
                            if (!host || processStatusLabel(process) === "success" || processStatusLabel(process) === "error") return null;
                            return <span className="inline-flex items-center gap-1 rounded bg-[var(--primary)]/10 px-1.5 py-0.5 text-xs text-[var(--primary)]"><Radio className="w-3 h-3" />{host.replace("Browser at ", "")}</span>;
                          })()}
                          <span className="min-w-0 flex-1 truncate">{process.latest.error || process.latest.message || "-"}</span>
                          <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{process.events.length} steps</span>
                          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${expanded === process.key ? "rotate-180" : ""}`} />
                        </div>
                      </td>
                    </tr>
                    {expanded === process.key && (
                      <tr className="border-b border-[var(--border)] bg-[var(--secondary)]/20">
                        <td colSpan={6} className="p-4">
                          <div className="space-y-2">
                            {process.events.map((log) => {
                              const isBrowserHost = log.step === "browser_host";
                              const isChallenge = log.step === "manual_challenge";
                              return (
                                <div
                                  key={`${log.id}-${log.timestamp}`}
                                  className={`grid grid-cols-[80px_120px_1fr] gap-3 rounded-md border px-3 py-2 text-xs ${
                                    isChallenge
                                      ? "border-[var(--warning)]/50 bg-[var(--warning)]/10"
                                      : isBrowserHost
                                        ? "border-[var(--primary)]/30 bg-[var(--primary)]/5"
                                        : "border-[var(--border)] bg-[var(--card)]"
                                  }`}
                                >
                                  <span className="font-mono text-[var(--muted-foreground)]">{formatTimeID(log.timestamp)}</span>
                                  <span className={isChallenge ? "font-semibold text-[var(--warning)]" : isBrowserHost ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}>
                                    {isBrowserHost ? "🌐 browser" : isChallenge ? " challenge" : log.step || statusLabel(log.type)}
                                  </span>
                                  <span className={log.error ? "text-[var(--error)]" : "text-[var(--foreground)]"}>{log.error || log.message || "-"}</span>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {processes.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No login logs yet. Add an account or start login to see progress.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {processes.length > perPage && (
        <div className="flex items-center justify-between border-t border-[var(--border)] pt-4">
          <p className="text-xs text-[var(--muted-foreground)]">
            {(page - 1) * perPage + 1}–{Math.min(page * perPage, processes.length)} of {processes.length}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>Previous</Button>
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(Math.ceil(processes.length / perPage), p + 1))} disabled={page >= Math.ceil(processes.length / perPage)}>Next</Button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
