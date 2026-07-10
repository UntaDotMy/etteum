import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Cpu, Copy, Check, Search, Plus, Trash2, Pencil, Power, X, Save, DollarSign } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import {
  fetchModels,
  fetchCustomModels,
  saveCustomModel,
  deleteCustomModel,
  fetchDisabledModels,
  setModelDisabled,
  fetchModelPricing,
  setModelPricing,
  type CustomModelsMap,
  type DisabledModelsMap,
  type PricingMap,
  type CustomModelSpec,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
  display_name?: string;
}

const providerColors: Record<string, string> = {
  kiro: "bg-[var(--chart-2)]/15 text-[var(--chart-2)] border-[var(--chart-2)]/30",
  "kiro-pro": "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/30",
  codebuddy: "bg-[var(--chart-3)]/15 text-[var(--chart-3)] border-[var(--chart-3)]/30",
  "codebuddy-china": "bg-red-500/15 text-red-400 border-red-400/30",
  canva: "bg-[var(--chart-6)]/15 text-[var(--chart-6)] border-[var(--chart-6)]/30",
  codex: "bg-[var(--chart-1)]/15 text-[var(--chart-1)] border-[var(--chart-1)]/30",
  qoder: "bg-[var(--chart-4)]/15 text-[var(--chart-4)] border-[var(--chart-4)]/30",
  cursor: "bg-[var(--chart-5)]/15 text-[var(--chart-5)] border-[var(--chart-5)]/30",
  byok: "bg-[var(--info)]/15 text-[var(--info)] border-[var(--info)]/30",
  "gitlab-duo": "bg-orange-500/15 text-orange-400 border-orange-400/30",
  youmind: "bg-teal-500/15 text-teal-400 border-teal-400/30",
  alibaba: "bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/30",
  antigravity: "bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-400/30",
  // F13 OpenAI-compatible catalog providers
  openai: "bg-emerald-500/15 text-emerald-400 border-emerald-400/30",
  deepseek: "bg-blue-500/15 text-blue-400 border-blue-400/30",
  groq: "bg-amber-500/15 text-amber-400 border-amber-400/30",
  openrouter: "bg-purple-500/15 text-purple-400 border-purple-400/30",
  grok: "bg-slate-500/15 text-slate-300 border-slate-400/30",
  mistral: "bg-rose-500/15 text-rose-400 border-rose-400/30",
  together: "bg-indigo-500/15 text-indigo-400 border-indigo-400/30",
  fireworks: "bg-pink-500/15 text-pink-400 border-pink-400/30",
  cohere: "bg-cyan-500/15 text-cyan-400 border-cyan-400/30",
};

function formatNumber(n: number | undefined): string {
  if (!n) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export default function Models() {
  const [models, setModels] = useState<ModelData[]>([]);
  const [customMap, setCustomMap] = useState<CustomModelsMap>({});
  const [disabledMap, setDisabledMap] = useState<DisabledModelsMap>({});
  const [pricingMap, setPricingMap] = useState<PricingMap>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1500);
  const { message: statusMsg, setMessage: setStatusMsg } = useTimedMessage<string>(null, 3000);

  const reload = useCallback(async () => {
    const [modelsRes, customRes, disabledRes, pricingRes] = await Promise.all([
      fetchModels().catch(() => ({ data: [] })),
      fetchCustomModels().catch(() => ({ custom: {} })),
      fetchDisabledModels().catch(() => ({ disabled: {} })),
      fetchModelPricing().catch(() => ({ pricing: {} })),
    ]);
    setModels((modelsRes as { data: ModelData[] }).data || []);
    setCustomMap((customRes as { custom: CustomModelsMap }).custom || {});
    setDisabledMap((disabledRes as { disabled: DisabledModelsMap }).disabled || {});
    setPricingMap((pricingRes as { pricing: PricingMap }).pricing || {});
  }, []);

  useEffect(() => {
    reload()
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [reload]);

  // Providers known to the system = hardcoded owners + any custom provider ids.
  const knownProviders = Array.from(
    new Set([
      ...models.map((m) => m.owned_by),
      ...Object.values(customMap).map((c) => c.provider),
    ]),
  ).sort();

  const isCustom = (id: string) => !!customMap[id];
  const isDisabled = (provider: string, id: string) => !!disabledMap[`${provider}:${id}`];

  const providers = ["all", ...knownProviders];

  // Hide disabled models unless searching for them (keeps the active catalog clean).
  const filtered = models
    .filter((m) => filter === "all" || m.owned_by === filter)
    .filter((m) =>
      search === "" ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      m.owned_by.toLowerCase().includes(search.toLowerCase())
    )
    .filter((m) => !isDisabled(m.owned_by, m.id));

  async function copyModelId(modelId: string) {
    await navigator.clipboard.writeText(modelId);
    setCopiedModel(modelId);
  }

  async function handleToggleDisabled(provider: string, id: string) {
    const disabled = isDisabled(provider, id);
    try {
      await setModelDisabled(provider, id, !disabled);
      setStatusMsg(disabled ? "Model enabled" : "Model disabled");
      await reload();
    } catch (e: any) {
      setStatusMsg(e?.message || "Failed");
    }
  }

  async function handleDeleteCustom(id: string) {
    if (!confirm(`Delete custom model "${id}"? This removes it from the catalog and routing.`)) return;
    try {
      await deleteCustomModel(id);
      setStatusMsg("Custom model deleted");
      await reload();
    } catch (e: any) {
      setStatusMsg(e?.message || "Failed");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--primary)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Models</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            {filtered.length} models shown · {Object.keys(customMap).length} custom · {Object.keys(disabledMap).length} disabled
          </p>
        </div>
        <Button onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? <X className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
          {showAdd ? "Cancel" : "Add model"}
        </Button>
      </div>

      {statusMsg && (
        <div className="text-sm text-[var(--info)] bg-[var(--info)]/10 border border-[var(--info)]/20 rounded-md px-3 py-2">
          {statusMsg}
        </div>
      )}

      {showAdd && (
        <AddModelForm
          providers={knownProviders}
          onDone={async () => {
            setShowAdd(false);
            await reload();
          }}
          setStatus={setStatusMsg}
        />
      )}

      {editing && (
        <EditModelForm
          model={models.find((m) => m.id === editing)!}
          custom={customMap[editing]}
          pricing={pricingMap[editing]}
          onDone={async () => {
            setEditing(null);
            await reload();
          }}
          setStatus={setStatusMsg}
        />
      )}

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <input
              type="text"
              placeholder="Search models, owners..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === p
                ? "bg-[var(--info)]/20 text-[var(--info)] border border-[var(--info)]/30"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            {p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--secondary)]/50">
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">Model</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">Owner</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">Context</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">Output</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">Features</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">$/1M (in/out)</th>
                  <th className="text-right py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((model) => {
                  const pricing = pricingMap[model.id];
                  return (
                    <tr key={model.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--secondary)]/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[var(--foreground)]">{model.id}</span>
                          {isCustom(model.id) && <Badge variant="secondary" className="text-[10px]">custom</Badge>}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${providerColors[model.owned_by] || "bg-[var(--muted)]/20 text-[var(--muted-foreground)]"}`}>
                          {model.owned_by}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm text-[var(--foreground)]">{formatNumber(model.context_window)}</td>
                      <td className="py-3 px-4 text-sm text-[var(--foreground)]">{formatNumber(model.max_output)}</td>
                      <td className="py-3 px-4">
                        {model.thinking && <Badge variant="default" className="text-xs mr-1">Thinking</Badge>}
                        {model.vision && <Badge variant="outline" className="text-xs">Vision</Badge>}
                      </td>
                      <td className="py-3 px-4 text-xs text-[var(--muted-foreground)]">
                        {pricing ? `$${pricing.inputPer1M} / $${pricing.outputPer1M}` : "—"}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => setEditing(model.id)} title="Edit spec / pricing" className="p-1.5 rounded-md hover:bg-[var(--secondary)] transition-colors">
                            <Pencil className="w-4 h-4 text-[var(--muted-foreground)]" />
                          </button>
                          <button type="button" onClick={() => handleToggleDisabled(model.owned_by, model.id)} title="Disable / enable" className="p-1.5 rounded-md hover:bg-[var(--secondary)] transition-colors">
                            <Power className="w-4 h-4 text-[var(--muted-foreground)]" />
                          </button>
                          {isCustom(model.id) && (
                            <button type="button" onClick={() => handleDeleteCustom(model.id)} title="Delete custom model" className="p-1.5 rounded-md hover:bg-red-500/10 transition-colors">
                              <Trash2 className="w-4 h-4 text-red-400" />
                            </button>
                          )}
                          <button type="button" onClick={() => copyModelId(model.id)} title={`Copy model ID: ${model.id}`} className="p-1.5 rounded-md hover:bg-[var(--secondary)] transition-colors group">
                            {copiedModel === model.id ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4 text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <Cpu className="w-12 h-12 text-[var(--muted-foreground)] mb-4" />
              <p className="text-[var(--muted-foreground)]">No models found</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">Try adjusting your search or filter, or add a model.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Add model form ---
function AddModelForm({
  providers,
  onDone,
  setStatus,
}: {
  providers: string[];
  onDone: () => void;
  setStatus: (s: string) => void;
}) {
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState(providers[0] || "");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [vision, setVision] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!model.trim() || !provider) {
      setStatus("Model id and provider are required");
      return;
    }
    setSaving(true);
    try {
      const spec: CustomModelSpec = {};
      if (contextWindow.trim()) spec.context_window = Number(contextWindow);
      if (maxOutput.trim()) spec.max_output = Number(maxOutput);
      spec.thinking = thinking;
      spec.vision = vision;
      await saveCustomModel({
        model: model.trim(),
        provider,
        displayName: displayName.trim() || undefined,
        spec,
      });
      setStatus("Model added");
      onDone();
    } catch (e: any) {
      setStatus(e?.message || "Failed to add model");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Plus className="w-4 h-4" /> Add Model</CardTitle>
        <CardDescription>Register a model for a provider. Specs are optional — defaults come from model-specs.ts. Persists to the database.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-[var(--muted-foreground)]">Model id *</label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-opus-4-8" />
          </div>
          <div>
            <label className="text-xs text-[var(--muted-foreground)]">Provider *</label>
            <select className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-[var(--muted-foreground)]">Display name</label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="(optional)" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--muted-foreground)]">Context window</label>
              <Input type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="200000" />
            </div>
            <div>
              <label className="text-xs text-[var(--muted-foreground)]">Max output</label>
              <Input type="number" value={maxOutput} onChange={(e) => setMaxOutput(e.target.value)} placeholder="8192" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
            <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} /> Thinking
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
            <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} /> Vision
          </label>
        </div>
        <div className="flex gap-2">
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : <><Save className="w-4 h-4 mr-1" /> Save</>}</Button>
          <Button variant="outline" onClick={onDone}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Edit model form (spec override + pricing) ---
function EditModelForm({
  model,
  custom,
  pricing,
  onDone,
  setStatus,
}: {
  model: ModelData;
  custom?: { provider: string; displayName?: string; spec?: CustomModelSpec };
  pricing?: { inputPer1M: number; outputPer1M: number; cachedInputPer1M: number; reasoningPer1M?: number; cacheCreationPer1M?: number };
  onDone: () => void;
  setStatus: (s: string) => void;
}) {
  const spec = custom?.spec;
  const [contextWindow, setContextWindow] = useState(spec?.context_window?.toString() ?? model.context_window?.toString() ?? "");
  const [maxOutput, setMaxOutput] = useState(spec?.max_output?.toString() ?? model.max_output?.toString() ?? "");
  const [thinking, setThinking] = useState(spec?.thinking ?? model.thinking ?? false);
  const [vision, setVision] = useState(spec?.vision ?? model.vision ?? false);
  const [inputPer1M, setInputPer1M] = useState(pricing?.inputPer1M?.toString() ?? "");
  const [outputPer1M, setOutputPer1M] = useState(pricing?.outputPer1M?.toString() ?? "");
  const [cachedPer1M, setCachedPer1M] = useState(pricing?.cachedInputPer1M?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const newSpec: CustomModelSpec = {};
      if (contextWindow.trim()) newSpec.context_window = Number(contextWindow);
      if (maxOutput.trim()) newSpec.max_output = Number(maxOutput);
      newSpec.thinking = thinking;
      newSpec.vision = vision;
      // Persist spec override via the custom-model store (idempotent: creates or updates).
      await saveCustomModel({
        model: model.id,
        provider: custom?.provider || model.owned_by,
        displayName: custom?.displayName,
        spec: newSpec,
      });
      // Persist pricing if any rate was entered.
      if (inputPer1M.trim() || outputPer1M.trim() || cachedPer1M.trim()) {
        await setModelPricing(model.id, {
          inputPer1M: Number(inputPer1M || 0),
          outputPer1M: Number(outputPer1M || 0),
          cachedInputPer1M: Number(cachedPer1M || 0),
          reasoningPer1M: pricing?.reasoningPer1M,
          cacheCreationPer1M: pricing?.cacheCreationPer1M,
        } as any);
      }
      setStatus("Model updated");
      onDone();
    } catch (e: any) {
      setStatus(e?.message || "Failed to update model");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Pencil className="w-4 h-4" /> Edit: {model.id}</CardTitle>
        <CardDescription>Override spec + pricing. Overrides persist to the database and take precedence over model-specs.ts defaults.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-[var(--muted-foreground)] mb-2 uppercase tracking-wider">Spec override</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-[var(--muted-foreground)]">Context window</label>
              <Input type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-[var(--muted-foreground)]">Max output</label>
              <Input type="number" value={maxOutput} onChange={(e) => setMaxOutput(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm self-end pb-2">
              <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} /> Thinking
            </label>
            <label className="flex items-center gap-2 text-sm self-end pb-2">
              <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} /> Vision
            </label>
          </div>
        </div>
        <div>
          <p className="text-xs text-[var(--muted-foreground)] mb-2 uppercase tracking-wider flex items-center gap-1"><DollarSign className="w-3 h-3" /> Pricing ($/1M tokens)</p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-[var(--muted-foreground)]">Input</label>
              <Input type="number" step="0.01" value={inputPer1M} onChange={(e) => setInputPer1M(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs text-[var(--muted-foreground)]">Output</label>
              <Input type="number" step="0.01" value={outputPer1M} onChange={(e) => setOutputPer1M(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs text-[var(--muted-foreground)]">Cached input</label>
              <Input type="number" step="0.01" value={cachedPer1M} onChange={(e) => setCachedPer1M(e.target.value)} placeholder="0.00" />
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : <><Save className="w-4 h-4 mr-1" /> Save</>}</Button>
          <Button variant="outline" onClick={onDone}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
