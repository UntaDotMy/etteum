import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, RefreshCw, Zap, Flame, Globe, Wand2, Download, Upload, CheckCircle2, AlertCircle, Loader2, HardDrive } from "lucide-react";
import {
  fetchSettings,
  updateSettings,
  fetchProviderList,
  fetchAutoWarmupStatus,
  fetchUpdateStatus,
  applyUpdate,
  fetchBackupStatus,
  createAndDownloadBackup,
  importBackupZip,
  type AutoWarmupStatus,
  type UpdateStatus,
  type ApplyResult,
  type BackupStatusCounts,
} from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";
import { useApi } from "@/hooks/useApi";
import { useTimedMessage } from "@/hooks/useTimedMessage";

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  "codebuddy-china": "CodeBuddy CN",
  canva: "Canva",
};

function labelFor(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export default function Settings() {
  const [form, setForm] = useState<Record<string, string>>({
    // All defaults are now served by GET /api/settings — the backend merges
    // DEFAULT_COMPRESSION_CONFIG into every response so the dashboard has zero
    // hardcoded fallbacks. Initial state is empty; load() fills it from the API.
  });
  const [warmupStatus, setWarmupStatus] = useState<AutoWarmupStatus | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  // ── Update awareness ──────────────────────────────────────────────────────
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  // ── Backup export / import ────────────────────────────────────────────────
  const [backupCounts, setBackupCounts] = useState<BackupStatusCounts | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);

  async function checkUpdate(force = false) {
    setCheckingUpdate(true);
    try {
      const res = await fetchUpdateStatus(force);
      setUpdateStatus(res.data);
    } catch {
      // Non-fatal — leave previous status.
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function refreshBackupStatus() {
    try {
      const res = await fetchBackupStatus();
      setBackupCounts(res.data);
    } catch {
      /* non-fatal */
    }
  }

  async function handleExportBackup(mode: "essential" | "full" = "essential") {
    if (mode === "full") {
      const ok = confirm(
        "Full export includes request history and can be multi-GB.\n\n" +
          "Prefer “Export accounts & config” for moving to another PC.\n\nContinue with full export?",
      );
      if (!ok) return;
    }
    setExporting(true);
    setBackupMsg(null);
    try {
      const data = await createAndDownloadBackup(mode);
      const mb = (data.databaseBytes / (1024 * 1024)).toFixed(1);
      setBackupMsg(
        data.downloadUrl
          ? `Downloaded ${mode} backup (${mb} MB DB). Keep it private — includes ENCRYPTION_KEY and tokens. Also on disk: ${data.dir}`
          : `Pack created (${mb} MB DB) at ${data.dir} — copy that folder to the other PC (zip was unavailable).`,
      );
      void refreshBackupStatus();
    } catch (e: any) {
      setBackupMsg(e?.message || "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportBackup(file: File | null, mode: "merge" | "replace" = "merge") {
    if (!file) return;
    if (mode === "replace") {
      const ok = confirm(
        "FULL REPLACE will overwrite this PC's database and .env with the backup.\n\n" +
          "After import you MUST run: etteum restart\n" +
          "(page reload alone is not enough — that was why accounts looked empty).\n\n" +
          "Prefer “Import zip (merge)” to append accounts without wiping.\n\nContinue with full replace?",
      );
      if (!ok) return;
    } else {
      const ok = confirm(
        "Merge import will APPEND accounts from the backup.\n\n" +
          "• Same provider + email already here → update tokens (no duplicate row)\n" +
          "• New accounts → added\n" +
          "• Your existing accounts stay\n\n" +
          "No full DB wipe. Continue?",
      );
      if (!ok) return;
    }
    setImporting(true);
    setBackupMsg(null);
    try {
      const res = await importBackupZip(file, mode);
      const d = res.data;
      if (d.mode === "merge" || (d.inserted != null && d.updated != null)) {
        setBackupMsg(
          d.message +
            (d.inserted != null
              ? ` (added ${d.inserted}, updated ${d.updated}, skipped ${d.skipped ?? 0})`
              : ""),
        );
      } else {
        setBackupMsg(d.message);
      }
      void refreshBackupStatus();
      if (d.needsRestart) {
        setBackupMsg(
          (m) =>
            (m || "") +
            " → Run in terminal: etteum restart  (then refresh this page). Page reload alone will NOT load the new DB.",
        );
      } else {
        // Merge is live — soft reload so account lists refresh.
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      }
    } catch (e: any) {
      setBackupMsg(
        (e?.message || "Import failed") +
          (mode === "replace"
            ? " If the DB is locked: etteum stop → bun scripts/backup.ts import <zip> --replace --yes → etteum start"
            : ""),
      );
    } finally {
      setImporting(false);
    }
  }

  async function runUpdate() {
    if (!confirm("Apply the update now? This will git pull, rebuild the dashboard, run migrations, and restart the server. The dashboard will briefly go offline.")) return;
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await applyUpdate();
      setApplyResult(res.data);
      if (res.data.restarted) {
        // Wait for the server to come back, then reload.
        setMessage("Update applied — restarting…");
        setTimeout(() => pollForRestart(), 2500);
      }
    } catch (e: any) {
      setApplyResult({ ok: false, steps: [], restarted: false, supervisor: "manual", manualCommand: e?.message || "Update request failed" });
    } finally {
      setApplying(false);
    }
  }

  async function pollForRestart(attempt = 0) {
    if (attempt > 20) { setMessage("Restart taking long — refresh manually."); return; }
    try {
      await fetchUpdateStatus(true);
      // Server is back — reload the page to pick up new dashboard assets.
      window.location.reload();
    } catch {
      setTimeout(() => pollForRestart(attempt + 1), 2000);
    }
  }

  // Check on load + hourly. Cheap: status is cached 5 min server-side.
  useEffect(() => {
    checkUpdate();
    const id = setInterval(() => checkUpdate(), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const providerListApi = useApi<{ data: string[] }>(fetchProviderList, []);

  const providers = useMemo(
    () => providerListApi.data?.data || [],
    [providerListApi.data]
  );

  async function load() {
    const res = (await fetchSettings()) as { data: Record<string, string> };
    setForm((current) => ({ ...current, ...(res.data || {}) }));
    setDirty(false);
    fetchAutoWarmupStatus().then(setWarmupStatus).catch(() => {});
    void refreshBackupStatus();
    setLoading(false);
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  // Keep warmup status live via WebSocket — the Settings page is long-lived
  // and the scheduler broadcasts every tick, reload, and stop. Without this
  // the dashboard freezes on the first fetch indefinitely.
  useWsEvent("auto_warmup_status", (msg: any) => {
    if (msg.data) setWarmupStatus(msg.data);
  });

  // Fallback poll: refresh warmup status every 60s in case WS is disconnected.
  useEffect(() => {
    const id = setInterval(() => {
      fetchAutoWarmupStatus().then(setWarmupStatus).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  function setValue(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function lbMethodFor(provider: string): string {
    return (
      form[`provider_${provider}_lb_method`] ||
      form.load_balancing_method ||
      "round_robin"
    );
  }

  function isOverride(provider: string): boolean {
    return Boolean(form[`provider_${provider}_lb_method`]);
  }

  async function save() {
    setSaving(true);
    try {
      await updateSettings(form);
      setSavedAt(new Date());
      setDirty(false);
      setMessage("Settings saved.");
    } finally {
      setSaving(false);
    }
  }

  const globalMethod = form.load_balancing_method || "round_robin";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Proxy Settings</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Configure load balancing and auto warmup
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <span className="text-xs text-[var(--warning)] px-2 py-1 rounded bg-[var(--warning)]/10">
              Unsaved
            </span>
          )}
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="w-4 h-4 mr-2" /> Reload
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            <Save className="w-4 h-4 mr-2" /> {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--primary)]" />
        </div>
      ) : (
        <>
          {message && (
            <div className="rounded-md bg-[var(--success)]/10 p-3 text-sm text-[var(--success)]">
              {message}
            </div>
          )}

      {/* ── Updates ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="w-5 h-5" /> Software Update
          </CardTitle>
          <CardDescription>
            Check for and install the latest version from the repository.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-[var(--muted-foreground)]">
              Current: <span className="font-mono text-[var(--foreground)]">{updateStatus?.currentVersion ?? "—"}</span>
            </span>
            {updateStatus?.currentCommit && (
              <span className="text-xs text-[var(--muted-foreground)] font-mono">
                ({updateStatus.currentCommit.slice(0, 7)})
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => checkUpdate(true)} disabled={checkingUpdate || applying}>
              {checkingUpdate ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Check for updates
            </Button>
            {updateStatus?.lastCheckedAt && (
              <span className="text-xs text-[var(--muted-foreground)]">
                checked {new Date(updateStatus.lastCheckedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {updateStatus?.error && (
            <div className="flex items-start gap-2 rounded-md bg-[var(--warning)]/10 p-3 text-sm text-[var(--warning)]">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="font-mono text-xs">{updateStatus.error}</span>
            </div>
          )}

          {updateStatus?.updateAvailable && (
            <div className="flex flex-col gap-3 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/5 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--primary)]" />
                <div>
                  <div className="font-medium text-[var(--foreground)]">Update available</div>
                  <div className="text-xs text-[var(--muted-foreground)] font-mono">
                    {updateStatus.currentCommit?.slice(0, 7)} → {updateStatus.latestCommit?.slice(0, 7)}
                  </div>
                </div>
              </div>
              <Button size="sm" onClick={runUpdate} disabled={applying}>
                {applying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                {applying ? "Updating…" : "Update now"}
              </Button>
            </div>
          )}

          {updateStatus && !updateStatus.updateAvailable && !updateStatus.error && (
            <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
              You're on the latest version.
            </div>
          )}

          {applyResult && (
            <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-3">
              <div className="text-sm font-medium flex items-center gap-2">
                {applyResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-[var(--destructive)]" />
                )}
                {applyResult.ok ? "Update applied" : "Update failed"}
              </div>
              {applyResult.steps.length > 0 && (
                <ul className="space-y-1 text-xs font-mono">
                  {applyResult.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className={s.ok ? "text-[var(--success)]" : "text-[var(--destructive)]"}>
                        {s.ok ? "✓" : "✗"}
                      </span>
                      <span className="text-[var(--muted-foreground)]">
                        {s.name}{s.detail ? ` — ${s.detail.slice(0, 120)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {applyResult.restarted && (
                <div className="text-xs text-[var(--muted-foreground)]">
                  Restarting via {applyResult.supervisor}… the dashboard will reload automatically.
                </div>
              )}
              {applyResult.manualCommand && !applyResult.restarted && (
                <div className="space-y-1">
                  <div className="text-xs text-[var(--warning)]">
                    Automatic restart unavailable ({applyResult.supervisor}). Run this to finish:
                  </div>
                  <pre className="text-xs font-mono bg-[var(--background)] border border-[var(--border)] rounded p-2 overflow-x-auto whitespace-pre-wrap">
                    {applyResult.manualCommand}
                  </pre>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Backup / migrate to another PC ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="w-5 h-5" /> Backup &amp; migrate
          </CardTitle>
          <CardDescription>
            Export accounts + config, then import on another PC. Default import is{" "}
            <strong>merge</strong> (append accounts, no duplicates). Full replace still
            available but requires <code className="font-mono">etteum restart</code> after.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {backupCounts && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)] font-mono">
              <span>accounts={backupCounts.accounts}</span>
              <span>settings={backupCounts.settings}</span>
              <span>api_keys={backupCounts.apiKeys}</span>
              <span>proxies={backupCounts.proxyPool}</span>
              <span>request_logs={backupCounts.requestLogs}</span>
              <span>filters={backupCounts.filterRules}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void handleExportBackup("essential")} disabled={exporting || importing}>
              {exporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
              {exporting ? "Exporting…" : "Export accounts & config"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleExportBackup("full")}
              disabled={exporting || importing}
            >
              Export full (incl. logs)
            </Button>
            <label className="inline-flex">
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                disabled={exporting || importing}
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  e.target.value = "";
                  void handleImportBackup(f, "merge");
                }}
              />
              <Button size="sm" variant="outline" asChild disabled={exporting || importing}>
                <span>
                  {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin inline" /> : <Upload className="w-4 h-4 mr-2 inline" />}
                  {importing ? "Importing…" : "Import zip (merge)"}
                </span>
              </Button>
            </label>
            <label className="inline-flex">
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                disabled={exporting || importing}
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  e.target.value = "";
                  void handleImportBackup(f, "replace");
                }}
              />
              <Button size="sm" variant="ghost" asChild disabled={exporting || importing}>
                <span>
                  {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin inline" /> : null}
                  Full replace…
                </span>
              </Button>
            </label>
            <Button size="sm" variant="ghost" onClick={() => void refreshBackupStatus()}>
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh counts
            </Button>
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">
            Merge uses (provider + email) so re-importing the same pack updates tokens instead of
            duplicating. Essential export skips request history. CLI:{" "}
            <code className="font-mono">etteum export</code>
            {" · "}
            <code className="font-mono">etteum import backup.zip</code>
            {" (merge) · "}
            <code className="font-mono">bun scripts/backup.ts import backup.zip --replace --yes</code>
          </p>
          {backupMsg && (
            <div className="rounded-md bg-[var(--secondary)]/50 border border-[var(--border)] p-3 text-sm text-[var(--foreground)]">
              {backupMsg}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Load Balancing */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--primary)]" />
              Load Balancing
            </CardTitle>
            <CardDescription>
              Control how requests are distributed across accounts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Global Method
              </label>
              <select
                value={form.load_balancing_method || "round_robin"}
                onChange={(e) => setValue("load_balancing_method", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {globalMethod === "sequential"
                  ? "Uses accounts in order, moves to next only when current is exhausted."
                  : "Distributes requests evenly across all active accounts."}
              </p>
            </div>

            {providers.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-[var(--foreground)]">
                  Per-Provider Override
                </div>
                <div className="space-y-2">
                  {providers.map((provider) => {
                    const key = `provider_${provider}_lb_method`;
                    const effective = lbMethodFor(provider);
                    const overriden = isOverride(provider);
                    return (
                      <div
                        key={provider}
                        className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[var(--secondary)] border border-transparent hover:border-[var(--border)] transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--foreground)] flex items-center gap-2">
                            {labelFor(provider)}
                            {overriden && (
                              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--primary)]/20 text-[var(--primary)]">
                                override
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-[var(--muted-foreground)]">
                            {effective === "sequential" ? "Sequential" : "Round Robin"}
                            {!overriden && (
                              <span className="ml-1 text-[var(--muted-foreground)]/70">
                                (inherits global)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={form[key] || ""}
                            onChange={(e) => setValue(key, e.target.value)}
                            className="h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
                          >
                            <option value="">Inherit</option>
                            <option value="round_robin">Round Robin</option>
                            <option value="sequential">Sequential</option>
                          </select>
                          {overriden && (
                            <button
                              type="button"
                              onClick={() => setValue(key, "")}
                              className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-2 py-1 rounded hover:bg-[var(--secondary)]"
                              title="Clear override"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Auto WarmUp */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Flame className="w-4 h-4 text-[var(--primary)]" />
              Auto WarmUp
            </CardTitle>
            <CardDescription>
              Automatically warm up enabled providers on a schedule
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm text-[var(--foreground)]">Default Interval (minutes)</label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={form.auto_warmup_interval_minutes || ""}
                onChange={(e) => setValue("auto_warmup_interval_minutes", e.target.value)}
                placeholder="15"
                className="mt-1"
              />
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                Default interval for all providers. Override per-provider on the Accounts page.
              </p>
            </div>

            <div>
              <label className="text-sm text-[var(--foreground)]">Warmup Concurrency</label>
              <Input
                type="number"
                min={0}
                value={form.warmup_concurrency ?? ""}
                onChange={(e) => setValue("warmup_concurrency", e.target.value)}
                placeholder="50"
                className="mt-1"
              />
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                Max accounts warmed in parallel. Raise for faster warmup of large pools (500+).
                Set <code className="px-0.5">0</code> for unbounded. Watch upstream 429s and proxy-pool capacity.
              </p>
            </div>

            {warmupStatus?.providerIntervals &&
              warmupStatus.enabledProviders.length > 0 &&
              Object.keys(warmupStatus.providerIntervals).length > 0 && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-3 space-y-1.5">
                  <p className="text-xs text-[var(--muted-foreground)] mb-2">Per-provider intervals</p>
                  {warmupStatus.enabledProviders.map((p) => {
                    const interval = warmupStatus.providerIntervals?.[p] ?? warmupStatus.intervalMinutes ?? 15;
                    const isOverride =
                      warmupStatus.providerIntervals?.[p] !== undefined &&
                      warmupStatus.providerIntervals?.[p] !== warmupStatus.intervalMinutes;
                    const nextStr = warmupStatus.providerNextRunAt?.[p];
                    return (
                      <div key={p} className="flex items-center justify-between text-xs">
                        <span className="text-[var(--foreground)]">{labelFor(p)}</span>
                        <span className="text-[var(--muted-foreground)]">
                          {interval}m{isOverride ? " (custom)" : ""}
                          {nextStr && ` · next ${new Date(nextStr).toLocaleTimeString()}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-3 space-y-2">
              <p className="text-xs text-[var(--muted-foreground)]">Status</p>
              <p className="text-sm font-medium text-[var(--foreground)]">
                {warmupStatus && warmupStatus.enabledProviders.length > 0
                  ? `${warmupStatus.enabledProviders.length} provider${warmupStatus.enabledProviders.length === 1 ? "" : "s"} enabled`
                  : "No provider enabled"}
              </p>
              {warmupStatus?.enabledProviders && warmupStatus.enabledProviders.length > 0 && (
                <p className="text-xs text-[var(--muted-foreground)] truncate">
                  {warmupStatus.enabledProviders.map(labelFor).join(", ")}
                </p>
              )}
              {warmupStatus?.nextRunAt && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  Next run: {new Date(warmupStatus.nextRunAt).toLocaleTimeString()}
                </p>
              )}
              {savedAt && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  Last saved: {savedAt.toLocaleTimeString()}
                </p>
              )}
            </div>

            <p className="text-xs text-[var(--muted-foreground)]">
              Auto WarmUp checks accounts with status active, exhausted, or error (skips pending). Enable/disable and set per-provider intervals on the Accounts page.
            </p>
          </CardContent>
        </Card>

        {/* Proxy Pool */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="w-4 h-4 text-[var(--primary)]" />
              Proxy Pool
            </CardTitle>
            <CardDescription>
              Configure how the proxy pool is used for outgoing requests
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Usage Scope
              </label>
              <select
                value={form.proxy_pool_usage || "all"}
                onChange={(e) => setValue("proxy_pool_usage", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="all">All — Model + Auth</option>
                <option value="model">Model Only — API requests only</option>
                <option value="auth">Auth Only — Login automation only</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {form.proxy_pool_usage === "model"
                  ? "Proxies are only used for upstream model API calls. Auth/login runs without proxy."
                  : form.proxy_pool_usage === "auth"
                    ? "Proxies are only used for login automation. Model API calls go direct."
                    : "Proxies are used for both model API calls and login automation."}
              </p>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Rotation Strategy
              </label>
              <select
                value={form.proxy_pool_rotation || "round_robin"}
                onChange={(e) => setValue("proxy_pool_rotation", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {form.proxy_pool_rotation === "sequential"
                  ? "Uses one proxy until it fails, then moves to the next in the list."
                  : "Distributes requests evenly across all active proxies in rotation."}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Compression — token saver pipeline */}
        <Card className="border-[var(--border)] lg:col-span-2">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wand2 className="w-4 h-4 text-[var(--primary)]" />
                  Compression
                </CardTitle>
                <CardDescription className="mt-1">
                  Reduce token usage by compressing tool outputs, deduplicating context, and shortening prompts.
                  Pipeline: Headroom (opt) → TSC → DCP → RTK → Ponytail → Caveman → Injections → Image Dedupe → Cache Markers.
                  Over-aggressive RTK (tiny caps / few protected turns) makes CLI agents re-read files and look “dumb” — prefer Balanced or Conservative for Claude Code / Codex.
                </CardDescription>
              </div>
              <a
                href="https://github.com/priyo000/etteum-pool/blob/main/docs/compression.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--primary)] hover:underline shrink-0 mt-1"
                title="Open the compression docs"
              >
                docs ↗
              </a>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* RTK */}
            <CompressionRow
              title="RTK"
              subtitle="Tool Result Compression"
              description="Compress large tool outputs — git diff, grep, ls, tree, file reads"
              enabled={form.compression_rtk_enabled === "true"}
              onToggle={(v) => setValue("compression_rtk_enabled", v ? "true" : "false")}
            >
              <div className="space-y-3 mt-3">
                {/* Quick presets — primary control */}
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { name: "Conservative", chars: "8000", turns: "6", smart: "true", hint: "Max context for long CLI sessions. Lowest “dumb agent” risk." },
                      { name: "Balanced", chars: "1500", turns: "4", smart: "true", hint: "Recommended default for Claude Code / Codex. Matches backend." },
                      { name: "Aggressive", chars: "500", turns: "2", smart: "true", hint: "Max savings. Older tool output is heavily truncated — model may re-read files." },
                    ] as const
                  ).map((preset) => {
                    const selected =
                      form.compression_rtk_max_tool_chars === preset.chars &&
                      form.compression_rtk_keep_last_n_turns_full === preset.turns;
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        title={preset.hint}
                        onClick={() => {
                          setValue("compression_rtk_max_tool_chars", preset.chars);
                          setValue("compression_rtk_keep_last_n_turns_full", preset.turns);
                        }}
                        className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors text-left ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                            : "border-[var(--border)] bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{preset.name}</div>
                        <div className="text-[10px] mt-0.5 opacity-70">
                          {preset.chars} chars · keep {preset.turns}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Advanced disclosure */}
                <Disclosure label="Advanced settings">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs text-[var(--muted-foreground)]">Max chars per tool result</label>
                      <Input
                        type="number"
                        min={500}
                        max={50000}
                        step={500}
                        value={form.compression_rtk_max_tool_chars}
                        onChange={(e) => setValue("compression_rtk_max_tool_chars", e.target.value)}
                        className="mt-1"
                      />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1 leading-relaxed">
                        ~4 chars = 1 token. Default: <code>1500</code> (≈375 tokens) for older turns only.
                      </p>
                    </div>
                    <div>
                      <label className="text-xs text-[var(--muted-foreground)]">Keep last N turns full</label>
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        value={form.compression_rtk_keep_last_n_turns_full}
                        onChange={(e) => setValue("compression_rtk_keep_last_n_turns_full", e.target.value)}
                        className="mt-1"
                      />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1 leading-relaxed">
                        Recent turns left untouched. Default: <code>4</code> (CLI-safe).
                      </p>
                    </div>
                    <div>
                      <label className="text-xs text-[var(--muted-foreground)]">Smart truncate</label>
                      <label className="mt-1 flex items-center gap-2 h-9 px-3 rounded-md border border-[var(--border)] bg-[var(--background)] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.compression_rtk_smart_truncate === "true"}
                          onChange={(e) => setValue("compression_rtk_smart_truncate", e.target.checked ? "true" : "false")}
                        />
                        <span className="text-xs text-[var(--foreground)]">Pattern-aware</span>
                      </label>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1 leading-relaxed">
                        git diff / tree aware. Default: <code>on</code>.
                      </p>
                    </div>
                  </div>
                </Disclosure>
              </div>
            </CompressionRow>

            {/* DCP */}
            <CompressionRow
              title="DCP"
              subtitle="Context Deduplication"
              description="When the same read-only tool (Read, Glob, Grep, LS, WebFetch) is called twice with identical input, the older result is replaced with a short reference stub. Lossless from the model's perspective."
              enabled={form.compression_dcp_enabled === "true"}
              onToggle={(v) => setValue("compression_dcp_enabled", v ? "true" : "false")}
            />

            {/* Caveman */}
            <CompressionRow
              title="Caveman"
              subtitle="Terse System Prompt"
              description="Strips filler words and compacts the system prompt. ⚠️ Off by default — aggressive levels can change model behaviour. Test with your own prompts before enabling Full or Ultra."
              enabled={form.compression_caveman_enabled === "true"}
              onToggle={(v) => setValue("compression_caveman_enabled", v ? "true" : "false")}
              alwaysShowChildren
            >
              <div className="mt-3 space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  Compression level
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { lvl: "lite", title: "Lite", subtitle: "Drop filler", hint: "~5–15% saving · safest" },
                      { lvl: "full", title: "Full", subtitle: "Bullet form", hint: "~30–50% saving · moderate risk" },
                      { lvl: "ultra", title: "Ultra", subtitle: "Telegraphic", hint: "~50–70% saving · may degrade output" },
                    ] as const
                  ).map(({ lvl, title, subtitle, hint }) => {
                    const selected = form.compression_caveman_level === lvl;
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setValue("compression_caveman_level", lvl)}
                        title={hint}
                        className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors text-left ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                            : "border-[var(--border)] bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{title}</div>
                        <div className="text-[10px] mt-0.5 opacity-70">{subtitle}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
                  {form.compression_caveman_level === "lite" &&
                    "Lite: removes politeness fillers (\"please\", \"make sure to\") and verbose connectors. Sentence structure preserved. Saves ~5–15%."}
                  {form.compression_caveman_level === "full" &&
                    "Full: lite + collapses narrative connectors (\"furthermore\", \"that being said\"), drops \"the following\" lead-ins, simplifies if/when clauses. Saves ~30–50%. Test before deploying."}
                  {form.compression_caveman_level === "ultra" &&
                    "Ultra: full + drops articles (a/an/the), drops modal helpers (you can/may/might), forces imperative voice. Saves ~50–70% but may degrade model behaviour. Use only after benchmarking."}
                </p>
              </div>
            </CompressionRow>

            {/* Cache Markers */}
            <CompressionRow
              title="Cache Markers"
              subtitle="Anthropic Prompt Caching"
              description="Tags the stable system-prompt prefix with cache_control:ephemeral so upstream providers can cache it. Auto-skips when prefix contains timestamps or UUIDs (would never cache anyway). Pays off as ~75% discount on repeat input tokens."
              enabled={form.compression_cache_markers_enabled === "true"}
              onToggle={(v) => setValue("compression_cache_markers_enabled", v ? "true" : "false")}
            />

            {/* Image Dedupe */}
            <CompressionRow
              title="Image Dedupe"
              subtitle="Duplicate Image Detection"
              description="When the same image is attached more than once in a request, later occurrences are replaced with a reference stub. Lossless — the image is still in earlier context."
              enabled={form.compression_image_dedupe_enabled === "true"}
              onToggle={(v) => setValue("compression_image_dedupe_enabled", v ? "true" : "false")}
            />

            {/* TSC — Tool Schema Compaction */}
            <CompressionRow
              title="TSC"
              subtitle="Tool Schema Compaction"
              description="Lossless compaction of the tools[] array — strips JSON-Schema metadata ($schema, $id, additionalProperties:false) and collapses whitespace runs in tool descriptions. Provider-agnostic; runs first in pipeline. Typical agent traffic: 5-15% saving."
              enabled={form.compression_tsc_enabled === "true"}
              onToggle={(v) => setValue("compression_tsc_enabled", v ? "true" : "false")}
            />

            {/* Ponytail */}
            <CompressionRow
              title="Ponytail"
              subtitle="Structural Compression"
              description="Collapses repeated path prefixes and deduplicates consecutive near-identical lines in tool output. Lossless — only removes scaffolding, never semantic content. Off by default."
              enabled={form.compression_ponytail_enabled === "true"}
              onToggle={(v) => setValue("compression_ponytail_enabled", v ? "true" : "false")}
            />

            {/* Caveman Injection */}
            <CompressionRow
              title="Caveman Injection"
              subtitle="Terse Output Prompt"
              description="Appends instructions to the system prompt telling the model to respond tersely. ⚠️ Off by default — can cause models to skip tool calls or be too brief. Never use when tool calling matters."
              enabled={form.compression_caveman_injection_enabled === "true"}
              onToggle={(v) => setValue("compression_caveman_injection_enabled", v ? "true" : "false")}
            />

            {/* Ponytail Injection */}
            <CompressionRow
              title="Ponytail Injection"
              subtitle="Lazy Developer Prompt"
              description="Appends instructions to the system prompt telling the model to be a 'lazy senior developer' who avoids unnecessary code. ⚠️ Off by default — may skip tool calls. Use only for simple completions."
              enabled={form.compression_ponytail_injection_enabled === "true"}
              onToggle={(v) => setValue("compression_ponytail_injection_enabled", v ? "true" : "false")}
            />

            {/* Headroom */}
            <CompressionRow
              title="Headroom"
              subtitle="LLM Pre-Compression"
              description="Sends the entire message list to an external LLM for semantic compression before the upstream request. ⚠️ Off by default — the external model can rewrite tool calls, arguments, or system prompts unpredictably. Only use for simple completions without tools."
              enabled={form.compression_headroom_enabled === "true"}
              onToggle={(v) => setValue("compression_headroom_enabled", v ? "true" : "false")}
            />
          </CardContent>
        </Card>
      </div>
      </>
      )}
    </div>
  );
}

/**
 * Native <details> disclosure with chevron. Used to hide power-user controls
 * inside a CompressionRow so the default view stays simple (mirroring the
 * router-style toggle UX while keeping advanced knobs reachable).
 */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border border-[var(--border)] bg-[var(--background)]/40">
      <summary className="cursor-pointer list-none select-none px-3 py-2 flex items-center justify-between text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
        <span>{label}</span>
        <span className="transition-transform group-open:rotate-180" aria-hidden>▾</span>
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-[var(--border)]">{children}</div>
    </details>
  );
}

function CompressionRow({
  title,
  subtitle,
  description,
  enabled,
  onToggle,
  children,
  alwaysShowChildren = false,
}: {
  title: string;
  subtitle: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
  /** When true, children render even when toggle is off (visually dimmed). */
  alwaysShowChildren?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--foreground)]">{title}</span>
            <span className="text-xs text-[var(--muted-foreground)]">({subtitle})</span>
          </div>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{description}</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <div className="w-10 h-5 bg-[var(--border)] peer-checked:bg-[var(--primary)] rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-5"></div>
        </label>
      </div>
      {children && (alwaysShowChildren || enabled) && (
        <div className={alwaysShowChildren && !enabled ? "opacity-50 pointer-events-none" : ""}>
          {children}
        </div>
      )}
    </div>
  );
}
