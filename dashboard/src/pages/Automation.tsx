import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import StartAutomationModal from "@/components/automation/StartAutomationModal";
import GrokFarmModal from "@/components/automation/GrokFarmModal";
import { fetchAuthQueue, importAccounts } from "@/lib/api";
import { fetchBrowserSessions, type BrowserSessionInfo } from "@/lib/browserApi";
import { fetchApi } from "@/lib/api";
import { useWsEvent, useWsStatus } from "@/hooks/useWebSocket";
import {
  ExternalLink,
  Zap,
  Bot,
  Globe,
  Palette,
  Rocket,
  Monitor,
  ArrowRight,
  Radio,
  CheckCircle2,
  CircleDashed,
  Sparkles,
  Loader2,
  Activity,
  Users,
  ListOrdered,
  XCircle,
  PlayCircle,
  Square,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface ProviderConfig {
  value: string;
  label: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
  comingSoon?: boolean;
  engine: "camoufox" | "native" | "api" | "farm";
  farmModal?: boolean;
}

const PROVIDERS: ProviderConfig[] = [
  {
    value: "kiro",
    label: "Kiro",
    subtitle: "Google SSO → OAuth tokens via Camoufox",
    description: "Stealth browser login. Frames and steps stream live into Browser Logs.",
    icon: Zap,
    engine: "camoufox",
  },
  {
    value: "codebuddy",
    label: "CodeBuddy",
    subtitle: "Google login → API key via Camoufox",
    description: "Landing + Google OAuth + region. Live preview on Browser Logs.",
    icon: Bot,
    engine: "camoufox",
  },
  {
    value: "canva",
    label: "Canva",
    subtitle: "Google OAuth popup via Camoufox",
    description: "Browser login with cookie capture. Connected to Browser Logs frames.",
    icon: Palette,
    engine: "camoufox",
  },
  {
    value: "qoder",
    label: "Qoder",
    subtitle: "Device flow + Google via Camoufox",
    description: "Device authorization with live progress and frame stream.",
    icon: Globe,
    engine: "camoufox",
  },
  {
    value: "antigravity",
    label: "Antigravity",
    subtitle: "Native Camoufox Google automation",
    description: "TS automation path with the same Browser Logs session registry.",
    icon: Rocket,
    engine: "native",
  },
  {
    value: "grok",
    label: "Grok",
    subtitle: "Farm free CLI accounts → Grok provider",
    description: "Temp-mail or Gmail/IMAP signup + OIDC. Accounts import into the Grok pool with credits.",
    icon: Sparkles,
    engine: "farm",
    farmModal: true,
  },
  {
    value: "codebuddy-cn",
    label: "CodeBuddy CN",
    subtitle: "OTP + HTTP API (no browser)",
    description: "Warpize OTP registration — no live frame stream.",
    icon: Bot,
    engine: "api",
    comingSoon: true,
  },
];

type LiveEvent = {
  ts: number;
  provider: string;
  step: string;
  message: string;
  level: "info" | "error" | "success";
  email?: string;
};

type QueueStatus = {
  queued: number;
  active: number;
  processing: boolean;
  totalProcessed: number;
  totalSuccess: number;
  totalFailed: number;
  retrying?: number;
  activeAccounts?: Array<{ id: number; email: string; provider: string }>;
  queuedAccounts?: Array<{ id: number; email: string; provider: string }>;
};

type GrokFarmJob = {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  imported?: number;
  failed?: number;
  lastMessage?: string;
  config?: { maxAccounts?: number; concurrent?: number; mailMode?: string };
  logTail?: string[];
};

function isWorkerSession(s: BrowserSessionInfo): boolean {
  if (
    s.provider === "grok" &&
    s.sessionId.startsWith("grok-farm-") &&
    !/-w\d+$/.test(s.sessionId)
  ) {
    return false;
  }
  return true;
}

function StatTile({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  tone: "default" | "primary" | "success" | "error" | "warning";
  icon: LucideIcon;
}) {
  const toneCls =
    tone === "primary"
      ? "text-[var(--primary)] border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_10%,var(--card))]"
      : tone === "success"
        ? "text-[var(--success)] border-[var(--success)]/30 bg-[color-mix(in_srgb,var(--success)_10%,var(--card))]"
        : tone === "error"
          ? "text-[var(--error)] border-[var(--error)]/30 bg-[color-mix(in_srgb,var(--error)_10%,var(--card))]"
          : tone === "warning"
            ? "text-[var(--warning)] border-[var(--warning)]/30 bg-[color-mix(in_srgb,var(--warning)_10%,var(--card))]"
            : "text-[var(--foreground)] border-[var(--border)] bg-[var(--secondary)]/40";
  return (
    <div className={`rounded-lg border px-3 py-3 ${toneCls}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide opacity-80">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

export default function Automation() {
  const navigate = useNavigate();
  const wsStatus = useWsStatus();
  const [modalProvider, setModalProvider] = useState<ProviderConfig | null>(null);
  const [grokFarmOpen, setGrokFarmOpen] = useState(false);
  const [live, setLive] = useState<LiveEvent[]>([]);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [sessions, setSessions] = useState<BrowserSessionInfo[]>([]);
  const [farmJob, setFarmJob] = useState<GrokFarmJob | null>(null);
  const [sessionSuccess, setSessionSuccess] = useState(0);
  const [sessionFailed, setSessionFailed] = useState(0);
  const [stopping, setStopping] = useState(false);

  const pushLive = useCallback((ev: LiveEvent) => {
    setLive((prev) => [...prev.slice(-79), ev]);
  }, []);

  const refreshCockpit = useCallback(async () => {
    try {
      const [q, sess, farm] = await Promise.all([
        fetchAuthQueue().catch(() => null) as Promise<QueueStatus | null>,
        fetchBrowserSessions().catch(() => [] as BrowserSessionInfo[]),
        fetchApi<{ job: GrokFarmJob | null }>("/api/grok-farm/jobs/latest").catch(() => ({ job: null })),
      ]);
      if (q) setQueue(q);
      setSessions((sess || []).filter(isWorkerSession));
      setFarmJob(farm?.job ?? null);
    } catch {
      /* ignore poll errors */
    }
  }, []);

  useEffect(() => {
    void refreshCockpit();
    const t = setInterval(() => void refreshCockpit(), 2000);
    return () => clearInterval(t);
  }, [refreshCockpit]);

  useWsEvent("login_progress", (msg) => {
    const e = msg?.data ?? msg;
    if (!e) return;
    pushLive({
      ts: Date.now(),
      provider: String(e.provider || ""),
      step: String(e.step || "progress"),
      message: String(e.message || ""),
      level: "info",
      email: e.email ? String(e.email) : undefined,
    });
    void refreshCockpit();
  });
  useWsEvent("login_failed", (msg) => {
    const e = msg?.data ?? msg;
    if (!e) return;
    setSessionFailed((n) => n + 1);
    pushLive({
      ts: Date.now(),
      provider: String(e.provider || ""),
      step: "failed",
      message: String(e.error || e.message || "login failed"),
      level: "error",
      email: e.email ? String(e.email) : undefined,
    });
    void refreshCockpit();
  });
  useWsEvent("login_success", (msg) => {
    const e = msg?.data ?? msg;
    if (!e) return;
    setSessionSuccess((n) => n + 1);
    pushLive({
      ts: Date.now(),
      provider: String(e.provider || ""),
      step: "success",
      message: String(e.message || "login succeeded"),
      level: "success",
      email: e.email ? String(e.email) : undefined,
    });
    void refreshCockpit();
  });
  useWsEvent("queue_processing", (msg) => {
    const e = msg?.data ?? msg;
    if (!e) return;
    pushLive({
      ts: Date.now(),
      provider: String(e.provider || ""),
      step: String(e.step || "queue"),
      message: String(e.message || `processing ${e.email || ""}`),
      level: "info",
      email: e.email ? String(e.email) : undefined,
    });
    void refreshCockpit();
  });
  useWsEvent("queue_added", () => {
    void refreshCockpit();
  });
  useWsEvent("browser_frame", () => {
    void refreshCockpit();
  });

  const liveSessions = useMemo(() => sessions.filter((s) => !s.terminal), [sessions]);
  const doneSessions = useMemo(() => sessions.filter((s) => s.terminal), [sessions]);

  const queued = queue?.queued ?? 0;
  const active = Math.max(queue?.active ?? 0, liveSessions.length);
  const processed = queue?.totalProcessed ?? 0;
  const success = Math.max(queue?.totalSuccess ?? 0, sessionSuccess);
  const failed = Math.max(queue?.totalFailed ?? 0, sessionFailed);
  const farmRunning = farmJob?.status === "running";
  const farmTarget = farmJob?.config?.maxAccounts ?? 0;
  const farmDone = (farmJob?.imported ?? 0) + (farmJob?.failed ?? 0);

  const batchTotal = useMemo(() => {
    // Best-effort total for progress bar: queue leftovers + already processed + farm target.
    const loginTotal = queued + active + processed;
    if (farmRunning && farmTarget > 0) return Math.max(loginTotal, farmTarget);
    return loginTotal;
  }, [queued, active, processed, farmRunning, farmTarget]);

  const batchDone = processed + (farmRunning ? farmDone : 0);
  const pct = batchTotal > 0 ? Math.min(100, Math.round((batchDone / batchTotal) * 100)) : 0;
  const isBusy = Boolean(queue?.processing) || active > 0 || queued > 0 || farmRunning;

  async function handleStart(config: {
    mode: "empas" | "refresh-token";
    empas: string;
    refreshTokens: string;
    concurrent: number;
    skipExisting: boolean;
    useProxy: boolean;
    captchaBehavior: "skip" | "handle";
    headless: boolean;
    autoUpgrade: boolean;
  }) {
    const text = config.mode === "empas" ? config.empas : config.refreshTokens;
    if (!text.trim()) {
      alert("Paste at least one line.");
      return;
    }
    try {
      const providerValue = modalProvider!.value;
      const providerLabel = modalProvider!.label;
      const res = (await importAccounts(text, [providerValue], {
        headless: config.headless,
        concurrency: config.concurrent,
      })) as { created?: number; queued?: number; message?: string };
      setModalProvider(null);
      setSessionSuccess(0);
      setSessionFailed(0);
      pushLive({
        ts: Date.now(),
        provider: providerValue,
        step: "queued",
        message:
          res.message ||
          `Queued ${res.queued ?? "?"} / created ${res.created ?? "?"} for ${providerLabel}`,
        level: "info",
      });
      await refreshCockpit();
      // Stay on Automation cockpit; Browser Logs still available for frames.
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to start");
    }
  }

  async function handleStopQueue() {
    setStopping(true);
    try {
      await fetchApi("/api/auth/queue", { method: "DELETE" });
      if (farmRunning) {
        await fetchApi("/api/grok-farm/cancel", { method: "POST" }).catch(() => null);
      }
      pushLive({
        ts: Date.now(),
        provider: "",
        step: "stopped",
        message: "Queue / farm cancelled",
        level: "error",
      });
      await refreshCockpit();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to stop");
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Automation</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Start logins or farms. Live counts and workers stay here; open Browser Logs for frames.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              wsStatus === "open"
                ? "border-[var(--primary)]/40 text-[var(--primary)]"
                : "text-[var(--muted-foreground)]"
            }
          >
            <Radio className={`mr-1.5 h-3 w-3 ${wsStatus === "open" ? "animate-pulse text-[var(--primary)]" : ""}`} />
            WS {wsStatus}
          </Badge>
          {isBusy && (
            <Button variant="outline" size="sm" onClick={() => void handleStopQueue()} disabled={stopping}
              className="border-[var(--error)]/40 text-[var(--error)]">
              {stopping ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1.5 h-3.5 w-3.5" />}
              Stop
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => navigate("/bot-logs")}>
            <Monitor className="mr-2 h-4 w-4" />
            Browser Logs
            <ArrowRight className="ml-1.5 h-3.5 w-3.5 opacity-60" />
          </Button>
        </div>
      </div>

      {/* ── Live cockpit (enowxai-style progress) ───────────────────── */}
      <Card className="border-[var(--primary)]/20 shadow-[var(--shadow-card)]">
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-[var(--primary)]" />
              Live progress
              {isBusy && (
                <Badge variant="info" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  in progress
                </Badge>
              )}
              {!isBusy && (processed > 0 || farmJob) && (
                <Badge variant="success">idle</Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1 text-xs">
              Queue + browser workers + farm job · same events as Browser Logs
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refreshCockpit()}>
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Queued" value={queued} tone="warning" icon={ListOrdered} />
            <StatTile label="Active" value={active} tone="primary" icon={PlayCircle} />
            <StatTile label="Workers" value={liveSessions.length} tone="primary" icon={Users} />
            <StatTile label="Success" value={success} tone="success" icon={CheckCircle2} />
            <StatTile label="Failed" value={failed} tone="error" icon={XCircle} />
            <StatTile
              label="Processed"
              value={processed}
              tone="default"
              icon={Activity}
            />
          </div>

          {(isBusy || batchTotal > 0) && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                <span>
                  {batchDone} / {batchTotal || "—"} complete
                  {farmRunning ? ` · farm ${farmJob?.imported ?? 0} ok / ${farmJob?.failed ?? 0} fail` : ""}
                </span>
                <span className="tabular-nums font-medium text-[var(--foreground)]">{pct}%</span>
              </div>
              <Progress value={pct} className="h-2" />
            </div>
          )}

          {/* Farm job strip */}
          {farmJob && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Sparkles className="h-3.5 w-3.5 text-[var(--primary)]" />
                <span className="font-medium text-[var(--foreground)]">Grok Farm</span>
                <Badge
                  variant={
                    farmJob.status === "running"
                      ? "info"
                      : farmJob.status === "completed"
                        ? "success"
                        : farmJob.status === "failed" || farmJob.status === "cancelled"
                          ? "error"
                          : "secondary"
                  }
                >
                  {farmJob.status}
                </Badge>
                <span className="text-[var(--muted-foreground)]">
                  target {farmJob.config?.maxAccounts ?? "—"} · concurrent{" "}
                  {farmJob.config?.concurrent ?? "—"} · mail {farmJob.config?.mailMode ?? "—"}
                </span>
                <span className="ml-auto tabular-nums text-[var(--muted-foreground)]">
                  +{farmJob.imported ?? 0} imported
                </span>
              </div>
              {farmJob.lastMessage && (
                <p className="mt-1 truncate text-[11px] text-[var(--muted-foreground)]">
                  {farmJob.lastMessage}
                </p>
              )}
            </div>
          )}

          {/* Active workers */}
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--background)]/40">
              <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Active workers
                </span>
                <span className="text-[10px] tabular-nums text-[var(--muted-foreground)]">
                  {liveSessions.length}
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto p-2">
                {liveSessions.length === 0 && !(queue?.activeAccounts?.length) ? (
                  <p className="px-1 py-4 text-center text-[11px] text-[var(--muted-foreground)]">
                    No live workers. Start a provider to fill this list.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {liveSessions.map((s) => (
                      <li
                        key={s.sessionId}
                        className="flex items-center gap-2 rounded-md border border-[var(--border)]/60 bg-[var(--card)] px-2 py-1.5 text-[11px]"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--primary)]" />
                        <span className="min-w-0 flex-1 truncate font-medium text-[var(--foreground)]">
                          {s.email}
                        </span>
                        <Badge variant="outline" className="text-[9px] uppercase">
                          {s.provider}
                        </Badge>
                        <span className="max-w-[7rem] truncate text-[var(--muted-foreground)]">
                          {s.phase}
                        </span>
                      </li>
                    ))}
                    {(queue?.activeAccounts || [])
                      .filter((a) => !liveSessions.some((s) => s.accountId === a.id))
                      .map((a) => (
                        <li
                          key={`q-${a.id}`}
                          className="flex items-center gap-2 rounded-md border border-[var(--border)]/60 bg-[var(--card)] px-2 py-1.5 text-[11px]"
                        >
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--primary)]" />
                          <span className="min-w-0 flex-1 truncate font-medium">{a.email}</span>
                          <Badge variant="outline" className="text-[9px] uppercase">
                            {a.provider}
                          </Badge>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--background)]/40">
              <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Queued
                </span>
                <span className="text-[10px] tabular-nums text-[var(--muted-foreground)]">
                  {queue?.queuedAccounts?.length ?? queued}
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto p-2">
                {!(queue?.queuedAccounts?.length) ? (
                  <p className="px-1 py-4 text-center text-[11px] text-[var(--muted-foreground)]">
                    Queue empty.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {(queue?.queuedAccounts || []).slice(0, 40).map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center gap-2 rounded-md border border-[var(--border)]/60 bg-[var(--card)] px-2 py-1.5 text-[11px]"
                      >
                        <ListOrdered className="h-3 w-3 shrink-0 text-[var(--warning)]" />
                        <span className="min-w-0 flex-1 truncate">{a.email}</span>
                        <Badge variant="outline" className="text-[9px] uppercase">
                          {a.provider}
                        </Badge>
                      </li>
                    ))}
                    {(queue?.queuedAccounts?.length || 0) > 40 && (
                      <p className="px-1 pt-1 text-[10px] text-[var(--muted-foreground)]">
                        +{(queue!.queuedAccounts!.length) - 40} more…
                      </p>
                    )}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* Event stream */}
          <div className="rounded-lg border border-[var(--border)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Activity stream
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--muted-foreground)]">{live.length} events</span>
                <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setLive([])}>
                  Clear
                </Button>
                <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => navigate("/bot-logs")}>
                  Frames
                  <ExternalLink className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </div>
            {live.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-[var(--muted-foreground)]">
                No events yet. Start a provider — steps and outcomes stream here.
              </div>
            ) : (
              <div className="max-h-44 overflow-y-auto font-mono text-[11px]">
                {live
                  .slice()
                  .reverse()
                  .map((ev, i) => (
                    <div
                      key={`${ev.ts}-${i}`}
                      className="flex gap-2 border-b border-[var(--border)]/50 px-3 py-1.5 last:border-0"
                    >
                      <span className="shrink-0 text-[var(--muted-foreground)]">
                        {new Date(ev.ts).toLocaleTimeString()}
                      </span>
                      <span className="shrink-0 text-[var(--primary)]">{ev.provider || "—"}</span>
                      <span
                        className={
                          ev.level === "error"
                            ? "shrink-0 text-[var(--error)]"
                            : ev.level === "success"
                              ? "shrink-0 text-[var(--success)]"
                              : "shrink-0 text-[var(--warning)]"
                        }
                      >
                        {ev.step}
                      </span>
                      {ev.email && (
                        <span className="max-w-[8rem] shrink-0 truncate text-[var(--muted-foreground)]">
                          {ev.email}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{ev.message}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {doneSessions.length > 0 && (
            <p className="text-[11px] text-[var(--muted-foreground)]">
              {doneSessions.length} finished browser session(s) still listed on Browser Logs.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Provider grid */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-[var(--foreground)]">Providers</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {PROVIDERS.map((p) => {
            const Icon = p.icon;
            return (
              <Card
                key={p.value}
                className={`group relative overflow-hidden transition-shadow hover:shadow-[var(--glow)] ${
                  p.comingSoon ? "opacity-55" : ""
                }`}
              >
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--primary)]/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))]">
                        <Icon className="h-5 w-5 text-[var(--primary)]" />
                      </div>
                      <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                          {p.label}
                          <Badge variant="outline" className="text-[10px] font-normal uppercase tracking-wide">
                            {p.engine}
                          </Badge>
                        </CardTitle>
                        <CardDescription className="mt-1 text-xs">{p.subtitle}</CardDescription>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  <p className="min-h-[2.5rem] text-xs leading-relaxed text-[var(--muted-foreground)]">
                    {p.description}
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    {p.comingSoon ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                        <CircleDashed className="h-3.5 w-3.5" /> Coming soon
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--primary)]">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Ready
                      </span>
                    )}
                    {p.comingSoon ? (
                      <Button variant="outline" size="sm" disabled>
                        Coming soon
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => {
                          if (p.farmModal) setGrokFarmOpen(true);
                          else setModalProvider(p);
                        }}
                      >
                        Start
                        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {modalProvider && (
        <StartAutomationModal
          provider={modalProvider.value}
          providerLabel={modalProvider.label}
          subtitle={`Run ${modalProvider.label} login. Progress stays on this page; open Browser Logs for live frames.`}
          onClose={() => setModalProvider(null)}
          onStart={handleStart}
        />
      )}

      {grokFarmOpen && (
        <GrokFarmModal
          onClose={() => setGrokFarmOpen(false)}
          onStarted={(jobId) => {
            setGrokFarmOpen(false);
            setSessionSuccess(0);
            setSessionFailed(0);
            pushLive({
              ts: Date.now(),
              provider: "grok",
              step: "farm",
              message: jobId ? `Farm started ${jobId}` : "Farm started",
              level: "info",
            });
            void refreshCockpit();
            // Stay on Automation; user can open Browser Logs for frames.
          }}
        />
      )}
    </div>
  );
}
