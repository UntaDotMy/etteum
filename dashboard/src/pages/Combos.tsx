import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, GripVertical, Save, RotateCcw, Layers, Loader2, AlertCircle } from "lucide-react";
import { useApiCache } from "@/hooks/useApiCache";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { fetchApi } from "@/lib/api";

interface Combo {
  id: number;
  name: string;
  models: string[];
  kind: string;
  enabled: boolean;
}

const KINDS = [
  { value: "fallback", label: "Fallback", desc: "Try first model, fall through on error/rate-limit" },
  { value: "sticky", label: "Sticky", desc: "Round-robin, sticky session per combo" },
  { value: "fusion", label: "Fusion", desc: "Parallel inference, judge picks winner" },
];

export default function Combos() {
  const { data: combos, error, mutate } = useApiCache<Combo[]>(
    "combos",
    async () => {
      const j = await fetchApi<{ combos?: Combo[] }>("/api/combos");
      return Array.isArray(j.combos) ? j.combos : [];
    },
  );
  const { message, setMessage } = useTimedMessage<string>(null, 3000);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("fallback");

  async function createCombo() {
    if (!newName.trim()) return;
    try {
      await fetchApi("/api/combos", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), models: [], kind: newKind }),
      });
      setMessage("Combo created");
      setNewName("");
      mutate();
    } catch (e: any) {
      setMessage(e?.message || "Failed to create combo");
    }
  }

  async function toggleCombo(id: number, enabled: boolean) {
    try {
      await fetchApi(`/api/combos/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !enabled }),
      });
      mutate();
    } catch (e: any) {
      setMessage(e?.message || "Failed to toggle combo");
    }
  }

  async function deleteCombo(id: number) {
    try {
      await fetchApi(`/api/combos/${id}`, { method: "DELETE" });
      mutate();
    } catch (e: any) {
      setMessage(e?.message || "Failed to delete combo");
    }
  }

  async function updateModels(id: number, models: string[]) {
    try {
      await fetchApi(`/api/combos/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ models }),
      });
      mutate();
    } catch (e: any) {
      setMessage(e?.message || "Failed to update models");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Layers className="w-6 h-6" /> Model Combos
        </h1>
        <p className="text-muted-foreground mt-1">
          Multi-model fallback / sticky / fusion chains. Define an ordered list of models; the router walks them on error or rate-limit.
        </p>
      </div>

      {message && <div className="text-sm text-green-500">{message}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New Combo</CardTitle>
          <CardDescription>Create a new model chain</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. zero-cost" />
          </div>
          <div className="w-40">
            <label className="text-xs text-muted-foreground">Strategy</label>
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          </div>
          <Button onClick={createCombo}><Plus className="w-4 h-4 mr-1" /> Create</Button>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {error && (
          <Card>
            <CardContent className="py-8 text-center text-red-500 flex items-center justify-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error.message}
            </CardContent>
          </Card>
        )}
        {!error && combos === null && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading combos…
            </CardContent>
          </Card>
        )}
        {Array.isArray(combos) && combos.map((combo) => (
          <ComboEditor
            key={combo.id}
            combo={combo}
            onToggle={(en) => toggleCombo(combo.id, en)}
            onDelete={() => deleteCombo(combo.id)}
            onUpdateModels={(m) => updateModels(combo.id, m)}
          />
        ))}
        {Array.isArray(combos) && combos.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No combos yet. Create one above.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function ComboEditor({ combo, onToggle, onDelete, onUpdateModels }: {
  combo: Combo;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onUpdateModels: (models: string[]) => void;
}) {
  const [models, setModels] = useState<string[]>(combo.models || []);
  const [newModel, setNewModel] = useState("");

  const kind = KINDS.find((k) => k.value === combo.kind) || KINDS[0];

  function addModel() {
    if (!newModel.trim()) return;
    const next = [...models, newModel.trim()];
    setModels(next);
    setNewModel("");
    onUpdateModels(next);
  }
  function removeModel(i: number) {
    const next = models.filter((_, idx) => idx !== i);
    setModels(next);
    onUpdateModels(next);
  }
  function moveModel(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= models.length) return;
    const next = [...models];
    [next[i], next[j]] = [next[j], next[i]];
    setModels(next);
    onUpdateModels(next);
  }

  return (
    <Card className={combo.enabled ? "" : "opacity-60"}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              {combo.name}
              <span className="text-xs font-normal px-2 py-0.5 rounded bg-muted">{kind.label}</span>
            </CardTitle>
            <CardDescription className="text-xs">{kind.desc}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onToggle(combo.enabled)}>
              {combo.enabled ? "Disable" : "Enable"}
            </Button>
            <Button size="sm" variant="destructive" onClick={onDelete}><Trash2 className="w-4 h-4" /></Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {models.map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <GripVertical className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground w-5">{i + 1}.</span>
            <code className="flex-1 text-sm bg-muted px-2 py-1 rounded">{m}</code>
            <Button size="sm" variant="ghost" onClick={() => moveModel(i, -1)} disabled={i === 0}>↑</Button>
            <Button size="sm" variant="ghost" onClick={() => moveModel(i, 1)} disabled={i === models.length - 1}>↓</Button>
            <Button size="sm" variant="ghost" onClick={() => removeModel(i)}><Trash2 className="w-4 h-4" /></Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addModel()}
            placeholder="model id (e.g. claude-sonnet-4)"
            className="text-sm"
          />
          <Button size="sm" onClick={addModel}><Plus className="w-4 h-4" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}
