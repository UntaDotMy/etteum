import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Download, Eye, EyeOff, FlaskConical, Key, ListPlus, Plus, RefreshCw, Save, Trash2, Zap } from "lucide-react";
import {
  addByokKeys,
  deleteAccount,
  fetchByokProviderModels,
  fetchByokProviders,
  revealByokKey,
  testByokProvider,
  toggleAccountEnabled,
  updateByokProvider,
  type ByokKeyInfo,
  type ByokProvider,
} from "@/lib/api";
import { formatDateTimeID } from "@/lib/utils";
import { freshUpstreamModels, mergeModels, paginateKeys, parseBulkLines } from "@/lib/byok-logic";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useApiCache } from "@/hooks/useApiCache";
import { useWsEvent } from "@/hooks/useWebSocket";

type LbMethod = "round_robin" | "sequential" | "least_inflight";
type ApiFormat = "openai" | "anthropic" | "auto";

type KeyDraft = {
  id?: number;
  label: string;
  key: string;
  enabled: boolean;
  status?: string;
  errorMessage?: string | null;
};

const MASK = "••••••••";
const KEYS_PAGE_SIZE = 10;

function emptyKey(index = 0): KeyDraft {
  return { label: index === 0 ? "default" : `key-${index + 1}`, key: "", enabled: true };
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return formatDateTimeID(value);
}

function lbLabel(method?: string) {
  if (method === "sequential") return "Sequential";
  if (method === "least_inflight") return "Least in-flight";
  return "Round Robin";
}

export default function ByokAccountList() {
  const { prefix } = useParams<{ prefix: string }>();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [showAllKeys, setShowAllKeys] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelPicker, setModelPicker] = useState<{ options: string[]; selected: Set<string> } | null>(null);
  const [testingKey, setTestingKey] = useState<number | null>(null);
  const [revealingKey, setRevealingKey] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const { message, setMessage, clearMessage } = useTimedMessage<string>(null, 4000);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    base_url: "",
    format: "auto" as ApiFormat,
    load_balancing_method: "round_robin" as LbMethod,
    models: "",
    keys: [emptyKey()] as KeyDraft[],
  });

  // Full refetch only on structural BYOK changes (not per-key account_status).
  const { data: byokData, mutate } = useApiCache<{ providers: ByokProvider[] }>(
    "byok-providers",
    () => fetchByokProviders(),
    {
      staleTime: 5000,
      wsEvents: ["byok_created", "byok_updated", "byok_deleted", "account_deleted"],
    }
  );

  // Live key status/error without reloading the whole form.
  useWsEvent(["account_status", "account_updated"], (msg) => {
    const d = (msg as { data?: Record<string, unknown> })?.data ?? (msg as Record<string, unknown>);
    if (!d || typeof d.id !== "number") return;
    setForm((current) => ({
      ...current,
      keys: current.keys.map((key) =>
        key.id !== d.id
          ? key
          : {
              ...key,
              ...(typeof d.status === "string" ? { status: d.status } : null),
              ...(d.error !== undefined ? { errorMessage: String(d.error) } : null),
              ...(d.errorMessage !== undefined ? { errorMessage: String(d.errorMessage) } : null),
              ...(typeof d.enabled === "boolean" ? { enabled: d.enabled } : null),
            },
      ),
    }));
    void mutate((prev) => {
      if (!prev?.providers) return prev;
      return {
        ...prev,
        providers: prev.providers.map((p) => ({
          ...p,
          keys: (p.keys || []).map((k) =>
            k.id !== d.id
              ? k
              : {
                  ...k,
                  ...(typeof d.status === "string" ? { status: d.status } : null),
                  ...(d.error !== undefined ? { errorMessage: String(d.error) } : null),
                  ...(typeof d.enabled === "boolean" ? { enabled: d.enabled } : null),
                },
          ),
        })),
      };
    });
  });

  // Derive provider from cached data
  const provider = useMemo(() => {
    if (!byokData?.providers || !prefix) return null;
    return byokData.providers.find((p) => p.label === prefix) || null;
  }, [byokData, prefix]);

  // Error if provider not found
  useEffect(() => {
    if (byokData && !provider && prefix) {
      setError(`BYOK provider "${prefix}" not found`);
    } else {
      setError(null);
    }
  }, [byokData, provider, prefix]);

  // Sync provider data to form when provider changes
  useEffect(() => {
    if (provider) {
      setForm({
        base_url: provider.base_url || "",
        format: provider.format || "auto",
        load_balancing_method: provider.load_balancing_method || "round_robin",
        models: (provider.models || []).join(", "),
        keys: (provider.keys && provider.keys.length > 0)
          ? provider.keys.map((key) => ({
              id: key.id,
              label: key.label,
              key: MASK,
              enabled: key.enabled !== false,
              status: key.status,
              errorMessage: key.errorMessage,
            }))
          : [emptyKey()],
      });
    }
  }, [provider]);

  const models = useMemo(() => form.models.split(",").map((m) => m.trim()).filter(Boolean), [form.models]);
  const activeKeyCount = form.keys.filter((k) => k.enabled && k.status !== "error").length;
  // Only cap the list when there is something worth collapsing.
  const visibleKeys = useMemo(
    () => paginateKeys(form.keys, showAllKeys, KEYS_PAGE_SIZE),
    [form.keys, showAllKeys]
  );
  const hiddenKeyCount = form.keys.length - visibleKeys.length;

  function secretVisibilityId(key: KeyDraft, index: number) {
    return key.id ? `id-${key.id}` : `new-${index}`;
  }

  async function toggleSecretVisibility(key: KeyDraft, index: number) {
    const visibilityId = secretVisibilityId(key, index);
    const isVisible = visibleSecrets.has(visibilityId);

    if (isVisible) {
      setVisibleSecrets((current) => {
        const next = new Set(current);
        next.delete(visibilityId);
        return next;
      });
      return;
    }

    if (key.id && key.key === MASK) {
      setRevealingKey(visibilityId);
      try {
        const revealed = await revealByokKey(key.id);
        updateKey(index, { key: revealed.key });
      } catch (err) {
        showError(err);
        setRevealingKey(null);
        return;
      }
      setRevealingKey(null);
    }

    setVisibleSecrets((current) => {
      const next = new Set(current);
      next.add(visibilityId);
      return next;
    });
  }

  function updateKey(index: number, patch: Partial<KeyDraft>) {
    setForm((current) => ({
      ...current,
      keys: current.keys.map((key, i) => i === index ? { ...key, ...patch } : key),
    }));
  }

  function addKey() {
    setForm((current) => ({ ...current, keys: [...current.keys, emptyKey(current.keys.length)] }));
  }

  function showSuccess(text: string) { setMessage(text); setError(null); }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); clearMessage(); }

  async function handleBulkAdd() {
    if (!provider) return;
    const parsed = parseBulkLines(bulkText, (provider.keys || []).map((k) => k.label));
    if (parsed.length === 0) return;
    setBulkAdding(true);
    try {
      const res = await addByokKeys(provider.id, parsed.map((k) => ({ label: k.label, key: k.key, enabled: true })));
      showSuccess(
        res.skipped > 0
          ? `Added ${res.added} key(s), skipped ${res.skipped} duplicate(s)`
          : `Added ${res.added} key(s)`
      );
      setBulkText("");
      setBulkOpen(false);
      await mutate();
    } catch (err) {
      showError(err);
    } finally {
      setBulkAdding(false);
    }
  }

  // Pull the upstream model catalog using the provider's stored key, then offer
  // only the models not already listed so adding never duplicates.
  async function handleFetchModels() {
    if (!provider) return;
    setFetchingModels(true);
    clearMessage();
    try {
      const res = await fetchByokProviderModels(provider.id);
      if (res.error) {
        showError(res.error);
        return;
      }
      const fresh = freshUpstreamModels(res.models || [], models);
      if (fresh.length === 0) {
        showSuccess(res.total ? `Already up to date, all ${res.total} upstream models are listed` : "No new models found upstream");
        return;
      }
      setModelPicker({ options: fresh, selected: new Set(fresh) });
    } catch (err) {
      showError(err);
    } finally {
      setFetchingModels(false);
    }
  }

  function toggleModelPick(model: string) {
    setModelPicker((current) => {
      if (!current) return current;
      const selected = new Set(current.selected);
      if (selected.has(model)) selected.delete(model);
      else selected.add(model);
      return { ...current, selected };
    });
  }

  function addPickedModels() {
    if (!modelPicker) return;
    const picked = modelPicker.options.filter((m) => modelPicker.selected.has(m));
    if (picked.length > 0) {
      setForm((current) => ({ ...current, models: mergeModels(models, picked) }));
      showSuccess(`Added ${picked.length} model(s), save to apply`);
    }
    setModelPicker(null);
  }

  async function removeKey(index: number) {
    const key = form.keys[index];
    if (!key) return;
    if (key.id) {
      if (!confirm(`Delete API key "${key.label}"?`)) return;
      try {
        await deleteAccount(key.id);
        showSuccess(`Deleted key ${key.label}`);
        await mutate();
      } catch (err) { showError(err); }
      return;
    }
    setForm((current) => ({
      ...current,
      keys: current.keys.length <= 1 ? [emptyKey()] : current.keys.filter((_, i) => i !== index),
    }));
  }

  function buildPayloadKeys() {
    return form.keys.map((key, index) => ({
      id: key.id,
      label: key.label.trim().toLowerCase() || `key-${index + 1}`,
      key: key.key && key.key !== MASK ? key.key.trim() : undefined,
      enabled: key.enabled,
      priority: index,
    })).filter((key) => key.id || key.key);
  }

  async function saveSettings() {
    if (!provider) return;
    if (!form.base_url.trim()) return showError(new Error("Base URL is required"));
    if (models.length === 0) return showError(new Error("At least one model is required"));
    const apiKeys = buildPayloadKeys();
    if (apiKeys.length === 0) return showError(new Error("At least one API key is required"));

    setSaving(true);
    try {
      await updateByokProvider(provider.id, {
        base_url: form.base_url.trim(),
        format: form.format,
        load_balancing_method: form.load_balancing_method,
        models,
        api_keys: apiKeys,
      });
      showSuccess("BYOK provider saved");
      await mutate();
    } catch (err) {
      showError(err);
    } finally {
      setSaving(false);
    }
  }

  async function toggleKey(key: KeyDraft, index: number) {
    const next = !key.enabled;
    updateKey(index, { enabled: next });
    if (!key.id) return;
    try {
      await toggleAccountEnabled(key.id, next);
      showSuccess(next ? `Enabled ${key.label}` : `Disabled ${key.label}`);
      // Form already updated; WS/account_updated may refine status.
    } catch (err) {
      updateKey(index, { enabled: key.enabled });
      showError(err);
    }
  }

  async function testKey(key: KeyDraft) {
    if (!key.id) return showError(new Error("Save this key before testing"));
    setTestingKey(key.id);
    try {
      const res = await testByokProvider(key.id);
      if (res.success) showSuccess(`✓ ${key.label} OK${res.latency_ms ? ` · ${res.latency_ms}ms` : ""}`);
      else showError(new Error(res.error || "Connection test failed"));
      // Status arrives via account_status WS; no full-page mutate.
    } catch (err) {
      showError(err);
    } finally {
      setTestingKey(null);
    }
  }

  async function testAll() {
    for (const key of form.keys) {
      if (key.id) await testKey(key);
    }
  }

  if (!byokData && !provider) {
    return <div className="flex h-64 items-center justify-center text-sm text-[var(--muted-foreground)]">Loading BYOK provider...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/accounts")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-[var(--foreground)]">BYOK · {prefix}</h1>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">
              {form.keys.length} keys · {activeKeyCount} enabled · {models.length} models · {lbLabel(form.load_balancing_method)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={testAll} disabled={testingKey !== null || form.keys.every((k) => !k.id)}>
            <FlaskConical className="w-4 h-4 mr-2" /> Test All
          </Button>
          <Button size="sm" onClick={saveSettings} disabled={saving}>
            <Save className="w-4 h-4 mr-2" /> {saving ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </div>

      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      <Card className="border-[var(--border)]">
        <CardHeader>
          <CardTitle className="text-base">Provider Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[var(--foreground)]">Provider Prefix</label>
              <Input value={prefix || ""} readOnly className="font-mono bg-[var(--muted)] opacity-70" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[var(--foreground)]">Base URL</label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.provider.com/v1" />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[var(--foreground)]">API Format</label>
              <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value as ApiFormat })} className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                <option value="auto">Auto-detect</option>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[var(--foreground)]">Load Balancing</label>
              <select value={form.load_balancing_method} onChange={(e) => setForm({ ...form, load_balancing_method: e.target.value as LbMethod })} className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">Round Robin rotates keys. Sequential prioritizes the first healthy key in table order.</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium text-[var(--foreground)]">Models</label>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleFetchModels} disabled={fetchingModels || !provider}>
                {fetchingModels ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1" />}
                {fetchingModels ? "Fetching..." : "Fetch models"}
              </Button>
            </div>
            <textarea value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} className="w-full h-24 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)]" placeholder="gpt-4o, claude-sonnet, llama-3" />
            <p className="text-xs text-[var(--muted-foreground)]">Comma-separated model IDs. Public model IDs become <span className="font-mono">{prefix || "prefix"}-model</span>.</p>
            {modelPicker && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-[var(--foreground)]">{modelPicker.options.length} new model(s) upstream</p>
                  <div className="flex gap-2">
                    <button type="button" className="text-xs text-[var(--info)] hover:underline" onClick={() => setModelPicker((c) => c && { ...c, selected: new Set(c.options) })}>Select all</button>
                    <button type="button" className="text-xs text-[var(--muted-foreground)] hover:underline" onClick={() => setModelPicker((c) => c && { ...c, selected: new Set() })}>None</button>
                  </div>
                </div>
                <div className="max-h-44 overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)]">
                  {modelPicker.options.map((model) => (
                    <label key={model} className="flex cursor-pointer items-center gap-2 border-b border-[var(--border)] px-2.5 py-1.5 text-xs font-mono text-[var(--foreground)] last:border-0 hover:bg-[var(--secondary)]/40">
                      <input type="checkbox" checked={modelPicker.selected.has(model)} onChange={() => toggleModelPick(model)} className="accent-[var(--primary)]" />
                      {model}
                    </label>
                  ))}
                </div>
                <div className="flex justify-end gap-1.5">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setModelPicker(null)}>Cancel</Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addPickedModels} disabled={modelPicker.selected.size === 0}>
                    Add {modelPicker.selected.size > 0 ? modelPicker.selected.size : ""} selected
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-[var(--border)]">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">API Keys</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setBulkOpen((open) => !open)}>
              <ListPlus className="w-4 h-4 mr-2" /> Bulk Add
            </Button>
            <Button variant="outline" size="sm" onClick={addKey}>
              <Plus className="w-4 h-4 mr-2" /> Add Key
            </Button>
          </div>
        </CardHeader>
        {bulkOpen && (
          <div className="mx-6 mb-4 rounded-md border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3 space-y-2">
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={'main:sk-...\nbackup:sk-...\nsk-...'}
              className="w-full h-28 rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-xs font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] text-[var(--muted-foreground)]">
                One key per line: <code className="bg-[var(--secondary)] px-1 rounded">label:key</code>, <code className="bg-[var(--secondary)] px-1 rounded">label key</code>, or just <code className="bg-[var(--secondary)] px-1 rounded">key</code>. Existing keys are skipped, never duplicated.
              </p>
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setBulkText(""); setBulkOpen(false); }}>Cancel</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleBulkAdd} disabled={bulkAdding || !bulkText.trim()}>
                  {bulkAdding ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                  {bulkAdding ? "Adding..." : "Add Keys"}
                </Button>
              </div>
            </div>
          </div>
        )}
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="p-4 text-left text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Key Label</th>
                  <th className="p-4 text-left text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Secret</th>
                  <th className="p-4 text-left text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Status</th>
                  <th className="p-4 text-left text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Enabled</th>
                  <th className="p-4 text-left text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Last Used</th>
                  <th className="p-4 text-left text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleKeys.map((key, index) => {
                  const visibilityId = secretVisibilityId(key, index);
                  const secretVisible = visibleSecrets.has(visibilityId);
                  return (
                  <tr key={`${key.id || "new"}-${index}`} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/40">
                    <td className="p-4">
                      <Input value={key.label} onChange={(e) => updateKey(index, { label: e.target.value })} className="h-8 min-w-[140px] font-mono text-xs" />
                      {form.load_balancing_method === "sequential" && <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">Priority #{index + 1}</div>}
                    </td>
                    <td className="p-4">
                      <div className="flex min-w-[260px] items-center gap-1">
                        <Input
                          type={secretVisible ? "text" : "password"}
                          value={key.key}
                          onChange={(e) => updateKey(index, { key: e.target.value })}
                          onFocus={() => { if (key.key === MASK) updateKey(index, { key: "" }); }}
                          placeholder={key.id ? "Keep masked or paste new key" : "sk-..."}
                          className="h-8 font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => toggleSecretVisibility(key, index)}
                          disabled={revealingKey === visibilityId}
                          title={secretVisible ? "Hide key" : "Show key"}
                        >
                          {revealingKey === visibilityId ? <RefreshCw className="h-4 w-4 animate-spin" /> : secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </div>
                    </td>
                    <td className="p-4">
                      <Badge variant={key.status === "error" ? "error" : key.status === "active" ? "success" : "secondary"}>{key.status || (key.id ? "active" : "new")}</Badge>
                      {key.errorMessage && <div className="mt-1 max-w-[220px] truncate text-xs text-[var(--error)]" title={key.errorMessage}>{key.errorMessage}</div>}
                    </td>
                    <td className="p-4">
                      <button type="button" onClick={() => toggleKey(key, index)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${key.enabled ? "bg-[var(--success)]" : "bg-[var(--secondary)]"}`}>
                        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${key.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)]">{formatDate((provider?.keys || []).find((k: ByokKeyInfo) => k.id === key.id)?.lastUsedAt)}</td>
                    <td className="p-4">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => testKey(key)} disabled={testingKey === key.id || !key.id} title="Test key">
                          {testingKey === key.id ? <RefreshCw className="w-4 h-4 animate-spin text-[var(--info)]" /> : <Zap className="w-4 h-4 text-[var(--info)]" />}
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => removeKey(index)} title="Delete key">
                          <Trash2 className="w-4 h-4 text-[var(--error)]" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {form.keys.length > KEYS_PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--secondary)]/[0.05] px-4 py-2">
                <p className="text-xs text-[var(--muted-foreground)]">
                  Showing {visibleKeys.length} of {form.keys.length} keys
                </p>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAllKeys((v) => !v)}>
                  {showAllKeys ? "Show less" : `Show all ${form.keys.length}`}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
