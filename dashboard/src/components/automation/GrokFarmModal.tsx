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
  headless: boolean;
  activateWeb: boolean;
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
  headless: false,
  activateWeb: true,
};

interface Props {
  onClose: () => void;
  onStarted: () => void;
}

export default function GrokFarmModal({ onClose, onStarted }: Props) {
  const [form, setForm] = useState<GrokFarmForm>(empty);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ ok: boolean; errors: string[]; python: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfgRes, setupRes] = await Promise.all([
          fetchApi<{ config: Partial<GrokFarmForm> }>("/api/grok-farm/config"),
          fetchApi<{ ok: boolean; errors: string[]; python: string | null }>("/api/grok-farm/setup"),
        ]);
        if (cancelled) return;
        setForm((f) => ({ ...f, ...cfgRes.config, imapPass: cfgRes.config.imapPass === "••••••••" ? "" : (cfgRes.config.imapPass || "") }));
        setSetup(setupRes);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
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
      await fetchApi("/api/grok-farm/start", {
        method: "POST",
        body: JSON.stringify({ ...form, saveConfig: true }),
      });
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
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
          {loading && <p className="text-sm text-[var(--muted-foreground)]">Loading config…</p>}

          {setup && !setup.ok && (
            <div className="rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
              Setup issues: {setup.errors.join("; ")}
            </div>
          )}
          {setup?.ok && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Python ready{setup.python ? `: ${setup.python}` : ""}. Farm script vendored under scripts/auth/grok-farm.
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

          <div className="grid grid-cols-2 gap-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] p-3">
              <input type="checkbox" className="mt-0.5" checked={form.headless} onChange={(e) => set("headless", e.target.checked)} />
              <div>
                <div className="text-sm font-medium">Headless</div>
                <div className="text-xs text-[var(--muted-foreground)]">Prefer off for Turnstile reliability</div>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] p-3">
              <input type="checkbox" className="mt-0.5" checked={form.activateWeb} onChange={(e) => set("activateWeb", e.target.checked)} />
              <div>
                <div className="text-sm font-medium">Activate web</div>
                <div className="text-xs text-[var(--muted-foreground)]">Open grok.com after OAuth (avoids 403)</div>
              </div>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
          <Button variant="outline" onClick={onClose} disabled={starting}>Cancel</Button>
          <Button onClick={handleStart} disabled={starting || loading}>
            {starting ? "Starting…" : "Start farm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
