import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, Trash2, RefreshCw, RotateCcw, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, XCircle, Key, Copy } from "lucide-react";
import { formatDateTimeID } from "@/lib/utils";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  bulkDeleteAccounts,
  deleteAccount,
  fetchAccounts,
  loginAccount,
  loginAccounts,
  openPanel,
  toggleAccountEnabled,
  toggleAllAccounts,
  warmupAccount,
  warmupAllAccounts,
  revealApiKey,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "codebuddy-china" | "canva" | "codex" | "qoder" | "alibaba";
type Status = "active" | "exhausted" | "error" | "pending" | "disabled";

/** Providers that authenticate with static API keys, not browser login.
 *  The login button is replaced with a reveal-key button for these. */
const NON_LOGINABLE = new Set(["byok", "codebuddy-china", "youmind", "alibaba"]);

interface CodexQuotaWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: string | null;
  reset_after_seconds: number;
}

interface CodexQuotaMetadata {
  plan_type?: string;
  primary?: CodexQuotaWindow;
  secondary?: CodexQuotaWindow;
  rate_limited?: boolean;
}

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: Status;
  enabled?: boolean;
  quotaLimit?: number;
  quotaRemaining?: number;
  freeLimit?: number;
  freeRemaining?: number;
  freeResetAt?: string | null;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  tokens?: AlibabaQuotaTokens | ByokTokens | null;
  metadata?: {
    codex_quota?: CodexQuotaMetadata;
    overage?: { enabled: boolean; capable: boolean; used: number; cap: number; remaining: number } | null;
    inferenceProbe?: string;
    activityQuota?: QoderActivityQuota | null;
    activityQuotaError?: string | null;
    serverQuota?: QoderServerQuota | null;
  } | null;
}

// Qoder /quota/usage snapshot persisted by warmup. Account-wide credit pool.
interface QoderServerQuota {
  limit?: number;
  remaining?: number;
  used?: number;
  resetAt?: string | null;
  source?: string | null;
  reportedExhausted?: boolean;
  reportedAt?: string;
}

// Qoder /activity endpoint shape — per-model promo buckets.
// Mirrors `QoderActivity` in src/proxy/providers/qoder.ts.
interface QoderActivityBucket {
  type?: string;
  activityId?: string;
  modelName?: string;
  modelKeys?: string[];           // upstream keys (e.g. ["qmodel_latest"])
  limit?: number;
  used?: number;
  remaining?: number;
  resetAt?: number;               // unix ms
  resetStrategy?: string;
  eligible?: boolean;
  description?: string;
  statusText?: string;
}

// ── Alibaba per-model quota from tokens ────────────────────────────

interface AlibabaModelQuota {
  limit: number;
  remaining: number;
  periodDays: number;
  resetAt: string | null;
}

interface AlibabaQuotaTokens {
  modelQuotas: Record<string, AlibabaModelQuota>;
  updatedAt: string;
}

interface ByokTokens {
  base_url?: string;
  model_prefix?: string;
  key_label?: string;
}

interface QoderActivityQuota {
  activities?: QoderActivityBucket[];
  queryAt?: number;
  fetchedAt?: string;
  [key: string]: unknown;
}

const statusVariants: Record<string, "success" | "warning" | "error" | "secondary"> = {
  active: "success",
  exhausted: "warning",
  error: "error",
  pending: "secondary",
  disabled: "secondary",
};

function labelProvider(provider: string) {
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  if (provider === "alibaba") return "Alibaba";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatCredit(value?: number | null) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : "0.0";
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return formatDateTimeID(value);
}

function formatWindow(seconds: number) {
  if (!seconds || seconds <= 0) return "?";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function formatResetIn(seconds: number) {
  if (!seconds || seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function CodexQuotaCell({ codex, fallbackRemaining, fallbackLimit }: { codex?: CodexQuotaMetadata; fallbackRemaining?: number; fallbackLimit?: number }) {
  if (!codex || (!codex.primary && !codex.secondary)) {
    return <span className="text-xs text-[var(--muted-foreground)]">{formatCredit(fallbackRemaining)}/{formatCredit(fallbackLimit)}</span>;
  }
  const renderBar = (label: string, w?: CodexQuotaWindow) => {
    if (!w) return null;
    const used = Math.max(0, Math.min(100, w.used_percent || 0));
    const remaining = 100 - used;
    const tone = remaining <= 10 ? "bg-[var(--error)]" : remaining <= 40 ? "bg-[var(--warning)]" : "bg-[var(--success)]";
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
          <span className="font-medium">{label} ({formatWindow(w.limit_window_seconds)})</span>
          <span>{remaining.toFixed(1)}% left · reset {formatResetIn(w.reset_after_seconds)}</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
          <div className={`h-full ${tone}`} style={{ width: `${remaining}%` }} />
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-1.5 min-w-[200px]">
      {codex.plan_type && <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Plan: {codex.plan_type}{codex.rate_limited && <span className="ml-2 text-[var(--error)]">RATE LIMITED</span>}</div>}
      {renderBar("Session", codex.primary)}
      {renderBar("Weekly", codex.secondary)}
    </div>
  );
}

function findQoderActivityBucket(activity: QoderActivityQuota | null | undefined, modelKey: string): QoderActivityBucket | null {
  if (!activity || !Array.isArray(activity.activities)) return null;
  return activity.activities.find((b) => Array.isArray(b?.modelKeys) && b.modelKeys.includes(modelKey)) ?? null;
}

function secondsUntil(unixMs?: number): number | null {
  if (!unixMs || !Number.isFinite(unixMs)) return null;
  const diff = Math.floor((unixMs - Date.now()) / 1000);
  return diff > 0 ? diff : null;
}

function QoderQuotaCell({
  account,
}: {
  account: Account;
}) {
  const activity = account.metadata?.activityQuota ?? null;
  const activityErr = account.metadata?.activityQuotaError ?? null;
  const bucket = findQoderActivityBucket(activity, "qmodel_latest");

  // ---- Free bar (top): live DB columns are source of truth — they're
  // overridden by warmup every cycle from /activity bucket qmodel_latest,
  // and decremented per-request when a Free-promo model is used. ----
  const freeLimit = Number(account.freeLimit ?? bucket?.limit ?? 0);
  const freeRemaining = Number(account.freeRemaining ?? bucket?.remaining ?? 0);
  const freeHasData = freeLimit > 0;
  const freePct = freeHasData ? Math.max(0, Math.min(100, (freeRemaining / freeLimit) * 100)) : 0;
  const freeTone = freePct <= 10 ? "bg-[var(--error)]" : freePct <= 40 ? "bg-[var(--warning)]" : "bg-[var(--success)]";
  const freeResetSec = secondsUntil(bucket?.resetAt);
  const freeReset = freeResetSec ? formatResetIn(freeResetSec) : null;

  // ---- All bar (bottom): account-wide credit from /quota/usage (metadata.serverQuota) ----
  // NOTE: account.quotaLimit/Remaining is owned by the custom-credit (200/day) system
  // for Qoder, not by warmup. The authoritative server credit lives in metadata.serverQuota.
  const server = account.metadata?.serverQuota ?? null;
  const allLimit = Number(server?.limit ?? 0);
  const allRemaining = Number(server?.remaining ?? 0);
  const allHasData = server != null && allLimit > 0;
  const allPct = allHasData ? Math.max(0, Math.min(100, (allRemaining / allLimit) * 100)) : 0;
  const allTone = allPct <= 10 ? "bg-[var(--error)]" : allPct <= 40 ? "bg-[var(--warning)]" : "bg-[var(--success)]";
  const allReportedExhausted = server?.reportedExhausted === true;

  return (
    <div className="space-y-1.5 min-w-[200px]">
      {/* Free (promo) */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
          <span className="font-medium">
            Free
            {bucket?.eligible === false && <span className="ml-1 text-[var(--warning)]">(ineligible)</span>}
          </span>
          <span>
            {freeHasData
              ? <>{freeRemaining}/{freeLimit}{freeReset ? ` · reset ${freeReset}` : ""}</>
              : activityErr
                ? <span className="text-[var(--error)]" title={activityErr}>err</span>
                : <span className="opacity-60">n/a</span>}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
          {freeHasData && <div className={`h-full ${freeTone}`} style={{ width: `${freePct}%` }} />}
        </div>
      </div>
      {/* All (server credit from /quota/usage) */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
          <span className="font-medium">
            All
            {allReportedExhausted && <span className="ml-1 text-[var(--warning)]" title="Server reported exhausted (probe may have overridden)">(rpt 0)</span>}
          </span>
          <span>
            {allHasData
              ? <>{formatCredit(allRemaining)}/{formatCredit(allLimit)}</>
              : <span className="opacity-60">n/a</span>}
            {account.metadata?.overage?.enabled && account.metadata.overage.remaining > 0 && (
              <span className="ml-1 inline-block px-1 py-0 rounded text-[9px] bg-[var(--success)] text-white">
                PAYG: {Math.round(account.metadata.overage.used)}
              </span>
            )}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
          {allHasData && <div className={`h-full ${allTone}`} style={{ width: `${allPct}%` }} />}
        </div>
      </div>
    </div>
  );
}

// ── Alibaba per-model quota cell ────────────────────────────────────

function AlibabaQuotaCell({ tokens }: { tokens?: AlibabaQuotaTokens | null }) {
  const quotas = tokens?.modelQuotas;
  if (!quotas || Object.keys(quotas).length === 0) {
    return <span className="text-xs text-[var(--muted-foreground)]">No quota data</span>;
  }

  // Only show the key probe models
  const KEY_MODELS = ["qwen3.7-max", "qwen3.7-plus", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "kimi-k2.7-code"];
  const entries = KEY_MODELS
    .map((model) => {
      const q = quotas[model];
      if (!q) return null;
      return {
        model,
        limit: q.limit,
        remaining: q.remaining,
        pct: q.limit > 0 ? (q.remaining / q.limit) * 100 : 0,
        exhausted: q.remaining <= 0,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (entries.length === 0) {
    return <span className="text-xs text-[var(--muted-foreground)]">No quota data</span>;
  }

  return (
    <div className="min-w-[220px] space-y-1.5">
      {entries.map((e) => {
        const tone = e.exhausted
          ? "bg-[var(--error)]"
          : e.pct <= 10
          ? "bg-[var(--error)]"
          : e.pct <= 40
          ? "bg-[var(--warning)]"
          : "bg-[var(--success)]";
        const label = e.model
          .replace("deepseek-v4-pro", "DS v4 Pro")
          .replace("deepseek-v4-flash", "DS v4 Flash")
          .replace("qwen3.7-max", "Qwen 3.7 Max")
          .replace("qwen3.7-plus", "Qwen 3.7+")
          .replace("glm-5.2", "GLM 5.2")
          .replace("kimi-k2.7-code", "Kimi K2.7");
        return (
          <div key={e.model} className="space-y-0">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-[var(--foreground)] font-medium">{label}</span>
              <span className={`text-[var(--muted-foreground)] shrink-0 ml-2 ${e.exhausted ? "text-[var(--error)]" : ""}`}>
                {e.remaining.toLocaleString()}/{e.limit.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
              <div className={`h-full ${tone} transition-all`} style={{ width: `${Math.max(0, Math.min(100, e.pct))}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

type SortKey = "email" | "status" | "enabled" | "credit" | "lastLogin";
type SortDir = "asc" | "desc";

export default function AccountList() {
  const { provider } = useParams<{ provider: string }>();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 25;
  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 4000);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("email");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ column }: { column: SortKey }) {
    if (sortKey !== column) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 ml-1" />
      : <ArrowDown className="w-3 h-3 ml-1" />;
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchAccounts() as { data: Account[] };
      setAccounts((res.data || []).filter((a) => a.provider === provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [provider]);

  function showSuccess(text: string) { setTimedMessage(text); setError(null); }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); clearMessage(); }

  async function handleWarmup(id: number) {
    try { await warmupAccount(id); showSuccess(`WarmUp queued #${id}`); await load(); } catch (err) { showError(err); }
  }

  async function handleWarmupAll() {
    try {
      const res = await warmupAllAccounts({ providers: [provider!], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || "WarmUp All queued.");
      await load();
    } catch (err) { showError(err); }
  }

  async function handleLogin(id: number) {
    try { await loginAccount(id); showSuccess(`Login queued #${id}`); await load(); } catch (err) { showError(err); }
  }

  const [revealedKey, setRevealedKey] = useState<{ id: number; key: string } | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);

  async function handleRevealKey(id: number) {
    if (revealedKey?.id === id) { setRevealedKey(null); return; }
    setRevealBusy(true);
    try {
      const res = await revealApiKey(id);
      setRevealedKey({ id, key: res.apiKey });
    } catch (err) {
      showError(err);
    } finally {
      setRevealBusy(false);
    }
  }

  async function handleCopyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      showSuccess("API key copied to clipboard");
    } catch {
      showError(new Error("Failed to copy"));
    }
  }

  async function handleOpenPanel(id: number) {
    try { await openPanel(id); showSuccess(`Panel opened #${id}`); } catch (err) { showError(err); }
  }

  async function handleRetryErrors() {
    const ids = accounts.filter((a) => a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} error accounts for retry.`);
    await load();
  }

  async function handleDelete(id: number) {
    if (!confirm(`Delete account #${id}?`)) return;
    try {
      await deleteAccount(id);
      showSuccess(`Deleted #${id}`);
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
    } catch (err) { showError(err); }
  }

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected ${labelProvider(provider || "")} account(s)? This cannot be undone.`)) return;
    setBulkDeleting(true);
    try {
      const res = await bulkDeleteAccounts(ids);
      showSuccess(`Deleted ${res.deleted} account(s)${res.notFound.length ? ` · ${res.notFound.length} not found` : ""}`);
      setSelectedIds(new Set());
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBulkDeleting(false);
    }
  }

  async function handleToggle(id: number, currentEnabled: boolean) {
    const next = !currentEnabled;
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: next } : a)));
    try {
      await toggleAccountEnabled(id, next);
      showSuccess(next ? `Aktifkan #${id}` : `Non-aktifkan #${id}`);
    } catch (err) {
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: currentEnabled } : a)));
      showError(err);
    }
  }

  async function handleToggleAll(enabled: boolean) {
    if (!provider) return;
    const prev = accounts.map((a) => ({ id: a.id, enabled: a.enabled !== false }));
    setAccounts((prev) => prev.map((a) => ({ ...a, enabled })));
    try {
      const res = await toggleAllAccounts(provider, enabled);
      showSuccess(enabled ? `Aktifkan ${res.count} akun ${labelProvider(provider)}` : `Non-aktifkan ${res.count} akun ${labelProvider(provider)}`);
    } catch (err) {
      setAccounts((list) => list.map((a) => {
        const orig = prev.find((p) => p.id === a.id);
        return orig ? { ...a, enabled: orig.enabled } : a;
      }));
      showError(err);
    }
  }

  const filtered = useMemo(() => {
    let result = accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
    if (statusFilter !== "all") {
      result = result.filter((a) => a.status === statusFilter);
    }
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "email":
          cmp = a.email.localeCompare(b.email);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "enabled":
          cmp = (a.enabled === false ? 0 : 1) - (b.enabled === false ? 0 : 1);
          break;
        case "credit":
          cmp = (a.quotaRemaining ?? 0) - (b.quotaRemaining ?? 0);
          break;
        case "lastLogin": {
          const da = new Date(a.lastLoginAt || a.lastUsedAt || 0).getTime();
          const db = new Date(b.lastLoginAt || b.lastUsedAt || 0).getTime();
          cmp = da - db;
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [accounts, search, statusFilter, sortKey, sortDir]);

  useEffect(() => { setPage(1); }, [search, provider, statusFilter]);

  // Drop selections for rows that no longer exist (after reload/delete).
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(accounts.map((a) => a.id));
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [accounts]);

  // Clear selection entirely when switching provider.
  useEffect(() => { setSelectedIds(new Set()); }, [provider]);

  const filteredIds = useMemo(() => filtered.map((a) => a.id), [filtered]);
  const selectedVisibleCount = useMemo(
    () => filteredIds.reduce((n, id) => (selectedIds.has(id) ? n + 1 : n), 0),
    [filteredIds, selectedIds],
  );
  const allVisibleSelected = filteredIds.length > 0 && selectedVisibleCount === filteredIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of filteredIds) next.delete(id);
      } else {
        for (const id of filteredIds) next.add(id);
      }
      return next;
    });
  }

  const errorCount = accounts.filter((a) => a.status === "error").length;
  const enabledCount = accounts.filter((a) => a.enabled !== false).length;
  const disabledCount = accounts.filter((a) => a.enabled === false).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/accounts")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-[var(--foreground)]">{labelProvider(provider || "")}</h1>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">{accounts.length} accounts</p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleWarmupAll}>
            <RefreshCw className="w-4 h-4 mr-2" /> Warmup All
          </Button>
          {!NON_LOGINABLE.has((provider || "") as Provider) && (
            <Button variant="outline" size="sm" onClick={handleRetryErrors} disabled={errorCount === 0}>
              <RotateCcw className="w-4 h-4 mr-2" /> Retry Errors ({errorCount})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => handleToggleAll(true)} disabled={disabledCount === 0}>
            <CheckCircle2 className="w-4 h-4 mr-2 text-[var(--success)]" /> Enable All ({disabledCount})
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleToggleAll(false)} disabled={enabledCount === 0}>
            <XCircle className="w-4 h-4 mr-2 text-[var(--error)]" /> Disable All ({enabledCount})
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
          <Input placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["all", "active", "exhausted", "error", "pending", "disabled"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                statusFilter === s
                  ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/[0.06] p-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-[var(--foreground)]">
            {selectedIds.size} selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())} disabled={bulkDeleting}>
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
            >
              <Trash2 className="w-4 h-4 mr-2" /> {bulkDeleting ? "Deleting..." : `Delete (${selectedIds.size})`}
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <Card className="border-[var(--border)]">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="w-10 p-4">
                    <input
                      type="checkbox"
                      aria-label="Select all visible accounts"
                      className="h-4 w-4 rounded border-[var(--border)] cursor-pointer accent-[var(--primary)]"
                      checked={allVisibleSelected}
                      ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                      onChange={toggleSelectAllVisible}
                    />
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("email")}>
                    <span className="inline-flex items-center">Email<SortIcon column="email" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("status")}>
                    <span className="inline-flex items-center">Status<SortIcon column="status" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("enabled")}>
                    <span className="inline-flex items-center">Enabled<SortIcon column="enabled" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)] hidden sm:table-cell" onClick={() => handleSort("credit")}>
                    <span className="inline-flex items-center">Credit<SortIcon column="credit" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)] hidden md:table-cell" onClick={() => handleSort("lastLogin")}>
                    <span className="inline-flex items-center">Last Login<SortIcon column="lastLogin" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice((page - 1) * perPage, page * perPage).map((account) => {
                  const isEnabled = account.enabled !== false;
                  return (
                  <Fragment key={account.id}>
                  <tr className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50 ${selectedIds.has(account.id) ? "bg-[var(--primary)]/[0.04]" : ""} ${isEnabled && account.status === "active" ? "" : "opacity-50"}`}>
                    <td className="p-4">
                      <input
                        type="checkbox"
                        aria-label={`Select ${account.email}`}
                        className="h-4 w-4 rounded border-[var(--border)] cursor-pointer accent-[var(--primary)]"
                        checked={selectedIds.has(account.id)}
                        onChange={() => toggleSelect(account.id)}
                      />
                    </td>
                    <td className="p-4 text-sm text-[var(--foreground)]">
                      <div>{account.email}</div>
                      {account.errorMessage && <div className="text-xs text-[var(--error)] mt-1 line-clamp-1" title={account.errorMessage}>{account.errorMessage}</div>}
                    </td>
                    <td className="p-4"><Badge variant={statusVariants[account.status]}>{account.status}</Badge></td>
                    <td className="p-4">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isEnabled}
                        onClick={() => handleToggle(account.id, isEnabled)}
                        title={isEnabled ? "Klik untuk non-aktifkan" : "Klik untuk aktifkan"}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-1 focus:ring-offset-[var(--background)] ${isEnabled ? "bg-[var(--success)]" : "bg-[var(--secondary)]"}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </td>
                    <td className="p-4 text-sm text-[var(--muted-foreground)] hidden sm:table-cell">
                      {account.provider === "codex"
                        ? <CodexQuotaCell codex={account.metadata?.codex_quota} fallbackRemaining={account.quotaRemaining} fallbackLimit={account.quotaLimit} />
                        : account.provider === "qoder"
                        ? <QoderQuotaCell account={account} />
                        : account.provider === "alibaba"
                        ? <AlibabaQuotaCell tokens={account.tokens as AlibabaQuotaTokens | null | undefined} />
                        : <span className="flex items-center gap-1.5">
                            {formatCredit(account.quotaRemaining)}/{formatCredit(account.quotaLimit)}
                            {account.metadata?.overage?.enabled && account.metadata.overage.remaining > 0 && (
                              <Badge variant="success" className="text-[10px] px-1 py-0">
                                PAYG: {Math.round(account.metadata.overage.used)}
                              </Badge>
                            )}
                          </span>}
                    </td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden md:table-cell">{formatDate(account.lastLoginAt || account.lastUsedAt)}</td>
                    <td className="p-4">
                      <div className="flex gap-1">
                        {(account.provider.startsWith("kiro") || account.provider === "qoder") && (
                          <Button variant="ghost" size="icon" onClick={() => handleOpenPanel(account.id)} title={`Open ${account.provider === "qoder" ? "Qoder" : "Kiro"} Panel`}>
                            <ExternalLink className="w-4 h-4 text-[var(--info)]" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={() => handleWarmup(account.id)} title="WarmUp">
                          <RefreshCw className="w-4 h-4 text-[var(--warning)]" />
                        </Button>
                        {NON_LOGINABLE.has(account.provider) ? (
                          <Button variant="ghost" size="icon" onClick={() => handleRevealKey(account.id)} title="Reveal API key">
                            <Key className="w-4 h-4 text-[var(--muted-foreground)]" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="icon" onClick={() => handleLogin(account.id)} title="Queue login" disabled={account.status !== "pending" && account.status !== "error"}>
                            <RotateCcw className="w-4 h-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(account.id)} title="Delete">
                          <Trash2 className="w-4 h-4 text-[var(--error)]" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {revealedKey?.id === account.id && (
                    <tr key={`reveal-${account.id}`} className="bg-[var(--secondary)]/30">
                      <td colSpan={7} className="p-3">
                        <div className="flex items-center gap-2">
                          <Key className="w-4 h-4 text-[var(--muted-foreground)] shrink-0" />
                          <code className="flex-1 text-xs text-[var(--foreground)] bg-[var(--background)] border border-[var(--border)] rounded px-2 py-1 font-mono break-all">
                            {revealBusy ? "Loading…" : revealedKey.key}
                          </code>
                          {revealedKey.key && (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => handleCopyKey(revealedKey.key)} title="Copy key">
                                Copy
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setRevealedKey(null)} title="Hide">
                                Hide
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
                })}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No accounts found</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > perPage && (
            <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
              <p className="text-xs text-[var(--muted-foreground)]">
                {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
                <span className="text-xs text-[var(--muted-foreground)]">{page}/{Math.ceil(filtered.length / perPage)}</span>
                <Button variant="outline" size="sm" disabled={page >= Math.ceil(filtered.length / perPage)} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
