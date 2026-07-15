import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Minus, Plus, X, Sparkles } from "lucide-react";
import { fetchApi } from "@/lib/api";

export type GrokMailMode = "tempmail" | "google";

export interface GrokFarmForm {
  mailMode: GrokMailMode;
  imapUser: string;
  imapPass: string;
  imapHost: string;
  imapPort: number;
  emailMode: "domain" | "plus_trick";
  emailDomain: string;
  gmailBase: string;
  accountPassword: string;
  maxAccounts: number;
  concurrent: number;
  activateWeb: boolean;
  /** Maps to GROK_* env — defaults match farm .env.example */
  workerIsolation: boolean;
  spawnDelay: number;
  autoStagger: boolean;
  autoSpawnDelay: number;
  launchParallel: number;
  tempmailBlockImages: boolean;
  turnstileParallel: number;
  uiRetries: number;
  uiRetryBackoff: number;
  probeRetries: number;
  probeRetryBackoff: number;
  proxyPool: string;
}

const empty: GrokFarmForm = {
  mailMode: "tempmail",
  imapUser: "",
  imapPass: "",
  imapHost: "imap.gmail.com",
  imapPort: 993,
  emailMode: "domain",
  emailDomain: "",
  gmailBase: "",
  accountPassword: "",
  maxAccounts: 5,
  concurrent: 1,
  activateWeb: true,
  workerIsolation: true,
  spawnDelay: 0,
  autoStagger: true,
  autoSpawnDelay: 1,
  launchParallel: 4,
  tempmailBlockImages: true,
  turnstileParallel: 64,
  uiRetries: 3,
  uiRetryBackoff: 2,
  probeRetries: 5,
  probeRetryBackoff: 1.0,
  proxyPool: "",
};

interface Props {
  onClose: () => void;
  onStarted: (jobId?: string) => void;
}

export default function GrokFarmModal({ onClose, onStarted }: Props) {
  const [form, setForm] = useState<GrokFarmForm>(empty);
  /** Config is a fast DB read — form is usable immediately with defaults. */
  const [configLoading, setConfigLoading] = useState(true);
  /** Setup probes Python/camoufox (cached server-side) — do not block the form. */
  const [setupLoading, setSetupLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{
    ok: boolean;
    errors: string[];
    python: string | null;
    hasCamoufox?: boolean;
    authVenv?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Load config first (settings row) so the form fills without waiting on Python.
    (async () => {
      try {
        const cfgRes = await fetchApi<{ config: Partial<GrokFarmForm> }>("/api/grok-farm/config");
        if (cancelled) return;
        setForm((f) => ({
          ...f,
          ...cfgRes.config,
          imapPass: cfgRes.config.imapPass === "••••••••" ? "" : (cfgRes.config.imapPass || ""),
        }));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setConfigLoading(false);
      }
    })();
    // Setup in parallel; may take longer the first time (Python import), then cached.
    (async () => {
      try {
        const setupRes = await fetchApi<{
          ok: boolean;
          errors: string[];
          python: string | null;
          hasCamoufox?: boolean;
          authVenv?: string;
        }>("/api/grok-farm/setup");
        if (cancelled) return;
        setSetup(setupRes);
      } catch (e) {
        if (!cancelled) {
          setSetup({
            ok: false,
            errors: [e instanceof Error ? e.message : String(e)],
            python: null,
          });
        }
      } finally {
        if (!cancelled) setSetupLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof GrokFarmForm>(key: K, value: GrokFarmForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleStart() {
    setError(null);
    if (!form.accountPassword.trim()) {
      setError("Account password is required (used for every farmed xAI signup)");
      return;
    }
    if (form.mailMode === "google") {
      if (!form.imapUser.trim() || !form.imapPass.trim()) {
        setError("IMAP user and app password are required for Gmail/IMAP mode");
        return;
      }
      if (form.emailMode === "domain" && !form.emailDomain.trim()) {
        setError("Catch-all email domain is required for domain mode");
        return;
      }
    }
    setStarting(true);
    try {
      const res = await fetchApi<{ job: { id: string } }>("/api/grok-farm/start", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          headless: true, // always headless in etteum
          saveConfig: true,
        }),
      });
      // Hand off to parent: navigate to Browser Logs so the farm session card is visible.
      onStarted(res.job?.id);
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e && "message" in e
            ? String((e as any).message)
            : String(e);
      setError(msg || "Start failed");
      setStarting(false);
      return;
    }
    setStarting(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
        <div className="flex items-start justify-between border-b border-[var(--border)] p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_14%,var(--card))]">
              <Sparkles className="h-5 w-5 text-[var(--primary)]" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Grok Farm Automation</h2>
              <p className="text-sm text-[var(--muted-foreground)]">
                Create free CLI accounts and import them into the Grok provider automatically
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-6">
          {configLoading && (
            <p className="text-xs text-[var(--muted-foreground)]">Loading saved config…</p>
          )}
          {setupLoading && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Checking Python / Camoufox (first open can take a few seconds; then cached)…
            </p>
          )}

          {setup && !setup.ok && (
            <div className="rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)] space-y-1">
              <p className="font-medium">Setup issues</p>
              {setup.errors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
              <p className="text-[11px] opacity-90">
                Farm reuses <code>scripts/auth/.venv</code> (same as other etteum bots) — no separate farm venv.
              </p>
            </div>
          )}
          {setup?.ok && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Using etteum Python{setup.python ? `: ${setup.python}` : ""} · camoufox ready · farm at scripts/auth/grok-farm
            </p>
          )}

          {error && (
            <div className="rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">{error}</div>
          )}

          {/* Mail mode */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Email source</div>
            <div className="flex gap-2 rounded-lg border border-[var(--border)] p-1">
              <button
                type="button"
                onClick={() => set("mailMode", "tempmail")}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${form.mailMode === "tempmail" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"}`}
              >
                Temp mail
              </button>
              <button
                type="button"
                onClick={() => set("mailMode", "google")}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${form.mailMode === "google" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"}`}
              >
                Gmail / IMAP
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
              {form.mailMode === "tempmail"
                ? "Uses generator.email in a browser — no IMAP. Good for quick farms."
                : "OTP lands in your IMAP inbox (Gmail App Password + catch-all or plus-trick)."}
            </p>
          </div>

          {form.mailMode === "google" && (
            <div className="space-y-3 rounded-lg border border-[var(--border)] p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">IMAP user</label>
                  <Input className="mt-1" value={form.imapUser} onChange={(e) => set("imapUser", e.target.value)} placeholder="you@gmail.com" />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">IMAP app password</label>
                  <Input className="mt-1" type="password" value={form.imapPass} onChange={(e) => set("imapPass", e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">IMAP host</label>
                  <Input className="mt-1" value={form.imapHost} onChange={(e) => set("imapHost", e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">IMAP port</label>
                  <Input className="mt-1" type="number" value={form.imapPort} onChange={(e) => set("imapPort", Number(e.target.value) || 993)} />
                </div>
              </div>
              <div className="flex gap-2 rounded-lg border border-[var(--border)] p-1">
                <button type="button" onClick={() => set("emailMode", "domain")} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${form.emailMode === "domain" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)]"}`}>
                  Catch-all domain
                </button>
                <button type="button" onClick={() => set("emailMode", "plus_trick")} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${form.emailMode === "plus_trick" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)]"}`}>
                  Gmail plus-trick
                </button>
              </div>
              {form.emailMode === "domain" ? (
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">Email domain (no @)</label>
                  <Input className="mt-1" value={form.emailDomain} onChange={(e) => set("emailDomain", e.target.value)} placeholder="koemail.my.id" />
                </div>
              ) : (
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">Gmail base (optional)</label>
                  <Input className="mt-1" value={form.gmailBase} onChange={(e) => set("gmailBase", e.target.value)} placeholder="defaults to IMAP user" />
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-xs text-[var(--muted-foreground)]">xAI account password (all farmed accounts)</label>
            <Input className="mt-1 font-mono" type="password" value={form.accountPassword} onChange={(e) => set("accountPassword", e.target.value)} placeholder="$YourGrokPass" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-[var(--border)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Accounts</div>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)]" onClick={() => set("maxAccounts", Math.max(1, form.maxAccounts - 1))}>
                  <Minus className="h-4 w-4" />
                </button>
                <Input type="number" min={1} max={100} value={form.maxAccounts} onChange={(e) => set("maxAccounts", Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="text-center" />
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)]" onClick={() => set("maxAccounts", Math.min(100, form.maxAccounts + 1))}>
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Concurrent</div>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)]" onClick={() => set("concurrent", Math.max(1, form.concurrent - 1))}>
                  <Minus className="h-4 w-4" />
                </button>
                <Input type="number" min={1} max={8} value={form.concurrent} onChange={(e) => set("concurrent", Math.max(1, Math.min(8, Number(e.target.value) || 1)))} className="text-center" />
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)]" onClick={() => set("concurrent", Math.min(8, form.concurrent + 1))}>
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] p-3">
            <input type="checkbox" className="mt-0.5" checked={form.activateWeb} onChange={(e) => set("activateWeb", e.target.checked)} />
            <div>
              <div className="text-sm font-medium">Activate web</div>
              <div className="text-xs text-[var(--muted-foreground)]">
                After OAuth, open grok.com to attach free Build chat (avoids 403). Browser always runs headless in etteum.
              </div>
            </div>
          </label>

          {/* Advanced farm env (GROK_* — same as standalone .env.example) */}
          <div className="rounded-lg border border-[var(--border)]">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium text-[var(--foreground)] hover:bg-[var(--secondary)]/50"
            >
              <span>Advanced farm settings</span>
              <span className="text-xs text-[var(--muted-foreground)]">
                {showAdvanced ? "hide" : "spawn · launch · retries"}
              </span>
            </button>
            {showAdvanced && (
              <div className="space-y-3 border-t border-[var(--border)] p-3">
                <p className="text-[11px] text-[var(--muted-foreground)]">
                  These map to <code className="rounded bg-[var(--secondary)] px-1">GROK_*</code> env
                  vars in <code className="rounded bg-[var(--secondary)] px-1">scripts/auth/grok-farm/.env.example</code>.
                  Saved with your farm config and applied on Start.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">Spawn delay (s)</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={0}
                      max={600}
                      value={form.spawnDelay}
                      onChange={(e) => set("spawnDelay", Math.max(0, Number(e.target.value) || 0))}
                    />
                    <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                      Worker N starts after delay × (N−1). 0 = use auto-stagger only when c≥3.
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">Auto spawn delay (s)</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={0}
                      max={600}
                      value={form.autoSpawnDelay}
                      onChange={(e) => set("autoSpawnDelay", Math.max(0, Number(e.target.value) || 0))}
                    />
                    <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                      Used when spawn delay is 0 and concurrent ≥ 3.
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">Launch parallel</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={1}
                      max={16}
                      value={form.launchParallel}
                      onChange={(e) =>
                        set("launchParallel", Math.max(1, Math.min(16, Number(e.target.value) || 1)))
                      }
                    />
                    <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                      Max simultaneous Camoufox boots (not total workers).
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">Turnstile parallel</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={1}
                      max={256}
                      value={form.turnstileParallel}
                      onChange={(e) =>
                        set("turnstileParallel", Math.max(1, Math.min(256, Number(e.target.value) || 1)))
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">UI retries</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={0}
                      max={20}
                      value={form.uiRetries}
                      onChange={(e) => set("uiRetries", Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">UI retry backoff (s)</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={0}
                      max={60}
                      step={0.5}
                      value={form.uiRetryBackoff}
                      onChange={(e) => set("uiRetryBackoff", Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">Probe retries</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={0}
                      max={20}
                      value={form.probeRetries}
                      onChange={(e) => set("probeRetries", Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--muted-foreground)]">Probe retry backoff (s)</label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={0}
                      max={60}
                      step={0.5}
                      value={form.probeRetryBackoff}
                      onChange={(e) => set("probeRetryBackoff", Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">
                    Proxy pool (optional, comma-separated)
                  </label>
                  <Input
                    className="mt-1 font-mono text-xs"
                    value={form.proxyPool}
                    onChange={(e) => set("proxyPool", e.target.value)}
                    placeholder="http://user:pass@host:port,socks5://…"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--border)] p-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.workerIsolation}
                      onChange={(e) => set("workerIsolation", e.target.checked)}
                    />
                    <div>
                      <div className="text-xs font-medium">Worker isolation</div>
                      <div className="text-[10px] text-[var(--muted-foreground)]">
                        Each worker own browser + Turnstile (recommended).
                      </div>
                    </div>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--border)] p-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.autoStagger}
                      onChange={(e) => set("autoStagger", e.target.checked)}
                    />
                    <div>
                      <div className="text-xs font-medium">Auto stagger</div>
                      <div className="text-[10px] text-[var(--muted-foreground)]">
                        When spawn delay is 0 and concurrent ≥ 3, stagger starts automatically.
                      </div>
                    </div>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--border)] p-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.tempmailBlockImages}
                      onChange={(e) => set("tempmailBlockImages", e.target.checked)}
                    />
                    <div>
                      <div className="text-xs font-medium">Temp-mail block images</div>
                      <div className="text-[10px] text-[var(--muted-foreground)]">
                        Cuts bandwidth on generator.email (OTP is text-only).
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            )}
          </div>

          <p className="text-[11px] text-[var(--muted-foreground)]">
            Runs Camoufox <strong>headless</strong> (no OS popup). Screenshots stream to{" "}
            <strong>Browser Logs</strong>. Farm env knobs match{" "}
            <code className="rounded bg-[var(--secondary)] px-1">scripts/auth/grok-farm/.env.example</code>.
            Uses etteum’s Python env (
            <code className="rounded bg-[var(--secondary)] px-1">scripts/auth/.venv</code>), not a separate farm venv.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
          <Button variant="outline" onClick={onClose} disabled={starting}>Cancel</Button>
          <Button
            onClick={handleStart}
            disabled={starting || configLoading || (setup !== null && !setup.ok)}
          >
            {starting ? "Starting…" : "Start farm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
