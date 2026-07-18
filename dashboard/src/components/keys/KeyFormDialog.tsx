import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Loader2 } from "lucide-react";
import {
  createManagedKey,
  updateManagedKey,
  fetchAvailableModels,
  type ManagedKey,
  type ManagedKeyInput,
} from "@/lib/api";

/**
 * Create / edit dialog for a managed (friend) API key. When `editing` is null it
 * creates; otherwise it patches the given key. Only the fields present in the
 * form are sent, so editing never clobbers limits the admin didn't touch.
 */
export default function KeyFormDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ManagedKey | null;
  onCreated: (fullKey: string) => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { open, onOpenChange, editing, onCreated, onSaved, onError } = props;
  const isEdit = editing != null;

  const [name, setName] = useState("");
  const [machineId, setMachineId] = useState("");
  const [unlimitedModels, setUnlimitedModels] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quota, setQuota] = useState("");
  const [rate, setRate] = useState("");
  const [expiry, setExpiry] = useState("");
  const [models, setModels] = useState<Array<{ id: string; owned_by: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  // Load the model catalog once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setModelsLoading(true);
    fetchAvailableModels()
      .then((res) => {
        if (!cancelled) setModels(res.models || []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset / prefill the form whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setName(editing?.name ?? "");
    setMachineId(editing?.machineId ?? "");
    const allow = editing?.allowedModels ?? null;
    setUnlimitedModels(allow == null);
    setSelected(new Set(allow ?? []));
    setQuota(editing?.tokenQuota != null ? String(editing.tokenQuota) : "");
    setRate(editing?.rateLimit != null ? String(editing.rateLimit) : "");
    setExpiry(editing?.expiresAt ? toLocalInput(editing.expiresAt) : "");
  }, [open, editing]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? models.filter(
          (m) => m.id.toLowerCase().includes(q) || m.owned_by.toLowerCase().includes(q),
        )
      : models;
    const byProvider = new Map<string, Array<{ id: string; owned_by: string }>>();
    for (const m of filtered) {
      const list = byProvider.get(m.owned_by) || [];
      list.push(m);
      byProvider.set(m.owned_by, list);
    }
    return Array.from(byProvider.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function buildPayload(): ManagedKeyInput {
    const quotaNum = quota.trim() === "" ? null : Math.round(Number(quota));
    const rateNum = rate.trim() === "" ? null : Math.round(Number(rate));
    return {
      name: name.trim() || null,
      machineId: machineId.trim() || null,
      allowedModels: unlimitedModels ? null : Array.from(selected),
      tokenQuota: quotaNum != null && Number.isFinite(quotaNum) && quotaNum > 0 ? quotaNum : null,
      rateLimit: rateNum != null && Number.isFinite(rateNum) && rateNum > 0 ? rateNum : null,
      expiresAt: expiry ? new Date(expiry).toISOString() : null,
    };
  }

  async function handleSubmit() {
    const payload = buildPayload();
    setSaving(true);
    try {
      if (isEdit) {
        await updateManagedKey(editing.id, payload);
        onSaved();
        onOpenChange(false);
      } else {
        const res = await createManagedKey(payload);
        onCreated(res.key);
        onOpenChange(false);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit friend key" : "New friend key"}</DialogTitle>
          <DialogDescription>
            Limit what this key can use: a model allowlist, token quota, rate cap, and
            expiry. All are optional — leave blank for unrestricted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Label">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Khai · laptop"
              />
            </Field>
            <Field label="Machine binding (optional)">
              <Input
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                placeholder="x-machine-id the client must send"
                className="font-mono"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Token quota" hint="blank = unlimited">
              <Input
                type="number"
                min={1}
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
                placeholder="500000000"
                className="font-mono"
              />
            </Field>
            <Field label="Rate limit /min" hint="blank = no cap">
              <Input
                type="number"
                min={1}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="60"
                className="font-mono"
              />
            </Field>
            <Field label="Expiry" hint="blank = never">
              <Input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </Field>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <label className="text-sm font-medium text-[var(--foreground)]">Models</label>
              <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={unlimitedModels}
                  onChange={(e) => setUnlimitedModels(e.target.checked)}
                  className="accent-[var(--primary)]"
                />
                all models (no allowlist)
              </label>
            </div>

            {unlimitedModels ? (
              <div className="rounded-md border border-dashed border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">
                This key can use every model in the catalog.
              </div>
            ) : (
              <div className="rounded-md border border-[var(--border)]">
                <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
                  <Search className="w-4 h-4 text-[var(--muted-foreground)]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="filter models…"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)]"
                  />
                  <span className="text-xs text-[var(--muted-foreground)] whitespace-nowrap">
                    {selected.size} selected
                  </span>
                </div>
                <div className="max-h-64 overflow-y-auto p-3 space-y-4">
                  {modelsLoading ? (
                    <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] py-6 justify-center">
                      <Loader2 className="w-4 h-4 animate-spin" /> loading catalog…
                    </div>
                  ) : grouped.length === 0 ? (
                    <div className="text-sm text-[var(--muted-foreground)] py-6 text-center">
                      no models match
                    </div>
                  ) : (
                    grouped.map(([provider, list]) => (
                      <div key={provider}>
                        <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1.5">
                          {provider}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {list.map((m) => {
                            const on = selected.has(m.id);
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => toggle(m.id)}
                                className={`font-mono text-xs rounded-full border px-2.5 py-1 transition-colors ${
                                  on
                                    ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--foreground)]/40"
                                }`}
                              >
                                {m.id}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving || (!unlimitedModels && selected.size === 0)}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {isEdit ? "Save changes" : "Create key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-[var(--foreground)]">{props.label}</label>
        {props.hint && <span className="text-[11px] text-[var(--muted-foreground)]">{props.hint}</span>}
      </div>
      {props.children}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
