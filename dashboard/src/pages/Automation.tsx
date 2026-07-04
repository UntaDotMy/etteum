import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Play, Loader2, ExternalLink, Globe, Zap, X } from "lucide-react";
import { importAccounts } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";

// Providers that have an automation (bulk) flow. Antigravity first; others can
// be added as their automation is wired.
const AUTOMATION_PROVIDERS = [
  { value: "antigravity", label: "Antigravity", blurb: "Auto-add Antigravity accounts using empas.", color: "var(--primary)" },
];

interface LiveAccount {
  accountId?: number;
  email?: string;
  provider?: string;
  status: "queued" | "running" | "success" | "failed" | "challenge";
  step?: string;
  message?: string;
  browserHost?: string;
  updatedAt: number;
}

/**
 * Automation tab — bulk batch account login, separated from the manual
 * single-account Add button (which lives in the Accounts tab).
 *
 * One provider card per automatable provider. Pick a provider, paste
 * email|password lines (empas), set concurrency (1..8), click Start → calls
 * /api/auth/import (loginQueue.bulkAdd → batch_login) which spawns N concurrent
 * visible-frame workers. Live per-account status streams in via WebSocket.
 */
export default function Automation() {
  const navigate = useNavigate();
  const [provider, setProvider] = useState(AUTOMATION_PROVIDERS[0]!.value);
  const [text, setText] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [headless, setHeadless] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState<Record<string, LiveAccount>>({});

  const upsert = (email: string, patch: Partial<LiveAccount>) => {
    setLive((prev) => ({ ...prev, [email]: { ...(prev[email] ?? { email, status: "running", updatedAt: Date.now() }), ...patch, updatedAt: Date.now() } }));
  };

  useWsEvent("queue_processing", (d: unknown) => {
    const e = d as any;
    if (!e?.email) return;
    upsert(e.email, { accountId: e.accountId, email: e.email, provider: e.provider, status: "running", step: e.step, message: e.message });
  });
  useWsEvent("login_progress", (d: unknown) => {
    const e = d as any;
    if (!e?.email) return;
    const status: LiveAccount["status"] = e.step === "manual_challenge" ? "challenge" : "running";
    const host = e.step === "browser_host" ? e.message : live[e.email]?.browserHost;
    upsert(e.email, { accountId: e.accountId, email: e.email, provider: e.provider, status, step: e.step, message: e.message, browserHost: host });
  });
  useWsEvent("login_success", (d: unknown) => {
    const e = d as any;
    if (!e?.email) return;
    upsert(e.email, { email: e.email, provider: e.provider, status: "success" });
  });
  useWsEvent("login_failed", (d: unknown) => {
    const e = d as any;
    if (!e?.email) return;
    upsert(e.email, { email: e.email, provider: e.provider, status: "failed", message: e.error });
  });

  const parsedLines = useMemo(
    () => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("|")),
    [text],
  );

  async function start() {
    setError("");
    const c = Number(concurrency);
    if (!Number.isFinite(c) || c < 1 || c > 8) {
      setError("Concurrent browser count must be between 1 and 8.");
      return;
    }
    if (parsedLines.length === 0) {
      setError("Paste at least one email|password line.");
      return;
    }
    setRunning(true);
    setLive({});
    try {
      await importAccounts(text, [provider], { headless, browserEngine: "nodriver", concurrency: c });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setRunning(false);
    }
  }

  const counts = useMemo(() => {
    const vals = Object.values(live);
    return {
      total: vals.length,
      running: vals.filter((v) => v.status === "running" || v.status === "challenge").length,
      success: vals.filter((v) => v.status === "success").length,
      failed: vals.filter((v) => v.status === "failed").length,
    };
  }, [live]);

  const activeProvider = AUTOMATION_PROVIDERS.find((p) => p.value === provider) ?? AUTOMATION_PROVIDERS[0]!;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Automation</h1>
          <p className="text-sm text-[var(--muted-foreground)]">Bulk batch login — pick a provider, paste empas, start.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/bot-logs")}>
          <ExternalLink className="h-4 w-4" /> Browser Log
        </Button>
      </div>

      {/* Provider cards — one per automatable provider. Antigravity only for now. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {AUTOMATION_PROVIDERS.map((p) => (
          <button
            key={p.value}
            onClick={() => setProvider(p.value)}
            className={`text-left rounded-lg border p-4 transition-colors ${provider === p.value ? "border-[var(--primary)] bg-[var(--primary)]/5" : "border-[var(--border)] bg-[var(--card)] hover:bg-[var(--secondary)]/50"}`}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md" style={{ background: `${p.color}1a`, color: p.color }}>
                <Zap className="h-4 w-4" />
              </span>
              <span className="text-sm font-semibold uppercase tracking-wider" style={{ color: p.color }}>{p.label}</span>
            </div>
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">{p.blurb}</p>
          </button>
        ))}
        {/* Placeholder slots for providers not yet automated */}
        {["kiro", "codebuddy", "qoder", "canva", "codex", "gitlab-duo"].filter((p) => !AUTOMATION_PROVIDERS.some((ap) => ap.value === p)).slice(0, 2).map((p) => (
          <div key={p} className="rounded-lg border border-dashed border-[var(--border)] p-4 opacity-50">
            <div className="text-sm font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{p}</div>
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">Automation coming soon.</p>
          </div>
        ))}
      </div>

      {/* Form card for the selected provider */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold uppercase tracking-wider" style={{ color: activeProvider.color }}>{activeProvider.label}</div>
              <p className="text-xs text-[var(--muted-foreground)]">{activeProvider.blurb}</p>
            </div>
            <Badge variant="secondary">empas</Badge>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Concurrent</label>
              <Input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-[var(--muted-foreground)]">Mode</label>
              <Select value={headless ? "true" : "false"} onChange={(e) => setHeadless(e.target.value === "true")}>
                <option value="false">Headed (visible frame)</option>
                <option value="true">Headless</option>
              </Select>
            </div>
            <div className="flex items-end">
              {running ? (
                <Button variant="outline" className="w-full" disabled>
                  <Loader2 className="h-4 w-4 animate-spin" /> Running…
                </Button>
              ) : (
                <Button className="w-full" onClick={start} disabled={parsedLines.length === 0}>
                  <Play className="h-4 w-4" /> Start ({parsedLines.length})
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-[var(--muted-foreground)]">Accounts — one email|password per line ({parsedLines.length} parsed)</label>
            <Textarea
              rows={7}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"email1@x.com|password1\nemail2@x.com|password2\n# lines starting with # are ignored"}
              className="font-mono text-xs"
            />
          </div>

          {error && <p className="text-xs text-[var(--error)]">{error}</p>}
        </CardContent>
      </Card>

      {/* Automation status — live per-account */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold">Automation Status</div>
            <div className="flex gap-2 text-xs">
              <Badge variant="secondary">{counts.total} total</Badge>
              <Badge variant="warning">{counts.running} active</Badge>
              <Badge variant="success">{counts.success} done</Badge>
              <Badge variant="error">{counts.failed} failed</Badge>
            </div>
          </div>
          {counts.total === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--muted-foreground)]">Start a batch to see live per-account status.</p>
          ) : (
            <div className="space-y-2">
              {Object.values(live).sort((a, b) => b.updatedAt - a.updatedAt).map((a) => (
                <div key={a.email} className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs">
                  <span className={`h-2 w-2 rounded-full ${a.status === "success" ? "bg-[var(--success)]" : a.status === "failed" ? "bg-[var(--error)]" : a.status === "challenge" ? "bg-[var(--warning)]" : "bg-[var(--primary)] animate-pulse"}`} />
                  <span className="w-48 truncate font-mono">{a.email}</span>
                  {a.browserHost && <span className="flex items-center gap-1 text-[var(--primary)]"><Globe className="h-3 w-3" />{a.browserHost.replace("Browser at ", "")}</span>}
                  <span className="flex-1 truncate text-[var(--muted-foreground)]">{a.step || a.message || a.status}</span>
                  <Badge variant={a.status === "success" ? "success" : a.status === "failed" ? "error" : a.status === "challenge" ? "warning" : "secondary"}>{a.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
