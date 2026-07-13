import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Minus, Plus, X, Bot } from "lucide-react";
import { fetchApi } from "@/lib/api";

interface Form {
  fiveSimToken: string;
  count: number;
  concurrent: number;
  country: string;
  headless: boolean;
}

const empty: Form = {
  fiveSimToken: "",
  count: 3,
  concurrent: 1,
  country: "hongkong",
  headless: true,
};

interface Props {
  onClose: () => void;
  onStarted: (jobId?: string) => void;
}

export default function CodeBuddyCnModal({ onClose, onStarted }: Props) {
  const [form, setForm] = useState<Form>(empty);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchApi<{ config: Partial<Form> }>("/api/automation/codebuddy-cn/config");
        if (cancelled) return;
        setForm((f) => ({
          ...f,
          ...res.config,
          fiveSimToken: res.config.fiveSimToken === "••••••••" ? "" : (res.config.fiveSimToken || ""),
        }));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleStart() {
    if (!form.fiveSimToken.trim()) {
      setError("5sim API token is required (https://5sim.net)");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const res = await fetchApi<{ job: { id: string } }>("/api/automation/codebuddy-cn/start", {
        method: "POST",
        body: JSON.stringify({
          fiveSimToken: form.fiveSimToken.trim(),
          count: form.count,
          concurrent: form.concurrent,
          country: form.country.trim() || "hongkong",
          headless: form.headless,
          saveConfig: true,
        }),
        timeoutMs: 60_000,
      });
      onStarted(res.job?.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
        <div className="flex items-start justify-between border-b border-[var(--border)] p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_14%,var(--card))]">
              <Bot className="h-5 w-5 text-[var(--primary)]" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[var(--foreground)]">CodeBuddy CN Farm</h2>
              <p className="text-sm text-[var(--muted-foreground)]">
                5sim phone OTP → mint ck_* API key → codebuddy-china pool
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          {loading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading config…</p>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)]">5sim API token</label>
                <Input
                  type="password"
                  className="mt-1"
                  value={form.fiveSimToken}
                  onChange={(e) => set("fiveSimToken", e.target.value)}
                  placeholder="Your 5sim.net API token"
                  autoComplete="off"
                />
                <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                  Stored in settings (masked). Used to rent SMS numbers for codebuddy.cn signup.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-[var(--muted-foreground)]">Accounts</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => set("count", Math.max(1, form.count - 1))}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={form.count}
                      onChange={(e) => set("count", Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                      className="text-center"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => set("count", Math.min(50, form.count + 1))}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--muted-foreground)]">Concurrent</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => set("concurrent", Math.max(1, form.concurrent - 1))}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={form.concurrent}
                      onChange={(e) =>
                        set("concurrent", Math.max(1, Math.min(5, Number(e.target.value) || 1)))
                      }
                      className="text-center"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => set("concurrent", Math.min(5, form.concurrent + 1))}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)]">5sim country</label>
                <Input
                  className="mt-1"
                  value={form.country}
                  onChange={(e) => set("country", e.target.value)}
                  placeholder="hongkong"
                />
                <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                  Common: hongkong, china, philippines (must have stock for product codebuddy)
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={form.headless}
                  onChange={(e) => set("headless", e.target.checked)}
                  className="rounded border-[var(--border)]"
                />
                Headless browser (frames still stream to Browser Logs)
              </label>

              {error && (
                <div className="rounded-lg border border-[var(--error)]/40 bg-[color-mix(in_srgb,var(--error)_10%,var(--card))] px-3 py-2 text-xs text-[var(--error)]">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={() => void handleStart()} disabled={loading || starting}>
            {starting ? "Starting…" : "Start farm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
