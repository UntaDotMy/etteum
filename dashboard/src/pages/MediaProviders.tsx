import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mic, Volume2, Image, Type, Plus, Trash2 } from "lucide-react";
import { useApiCache } from "@/hooks/useApiCache";

interface MediaAccount {
  id: number;
  email: string;
  provider: string;
  status: string;
  enabled: boolean;
  tokens: string;
}

const MODALITIES = [
  { id: "tts", label: "Text-to-Speech", icon: Volume2 },
  { id: "stt", label: "Speech-to-Text", icon: Mic },
  { id: "embeddings", label: "Embeddings", icon: Type },
  { id: "images", label: "Image Generation", icon: Image },
];

export default function MediaProviders() {
  const { data: accounts, mutate } = useApiCache<MediaAccount[]>(
    "media-accounts",
    async () => {
      const res = await fetch("/api/accounts?provider=media");
      const j = await res.json();
      return Array.isArray(j) ? j : j.accounts || [];
    },
  );

  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [apiKey, setApiKey] = useState("");
  const [modalities, setModalities] = useState<string[]>(["tts", "stt", "embeddings", "images"]);

  function toggleModality(id: string) {
    setModalities((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  }

  async function addMediaAccount() {
    if (!baseUrl || !apiKey) return;
    await fetch("/api/accounts/byok", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "media",
        email: `${new URL(baseUrl).hostname}-media`,
        password: apiKey,
        tokens: JSON.stringify({ base_url: baseUrl, format: "openai", modalities, default_models: {} }),
      }),
    });
    setApiKey("");
    mutate();
  }

  async function removeAccount(id: number) {
    await fetch(`/api/accounts/${id}`, { method: "DELETE" });
    mutate();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Volume2 className="w-6 h-6" /> Media Providers
        </h1>
        <p className="text-muted-foreground mt-1">
          Configure OpenAI-compatible media backends for TTS, STT, embeddings, and image generation. Each account serves the modalities you select.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {MODALITIES.map((m) => {
          const Icon = m.icon;
          const count = (accounts || []).filter((a) => {
            try { return JSON.parse(a.tokens || "{}").modalities?.includes(m.id); } catch { return false; }
          }).length;
          return (
            <Card key={m.id}>
              <CardContent className="flex items-center gap-3 py-4">
                <Icon className="w-8 h-8 text-primary" />
                <div>
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="text-xs text-muted-foreground">{count} backend{count === 1 ? "" : "s"}</div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Media Backend</CardTitle>
          <CardDescription>Any OpenAI-compatible media endpoint</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Base URL</label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">API Key</label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {MODALITIES.map((m) => (
              <button
                key={m.id}
                onClick={() => toggleModality(m.id)}
                className={`text-xs px-3 py-1.5 rounded-full border transition ${
                  modalities.includes(m.id)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-input hover:bg-muted"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <Button onClick={addMediaAccount} disabled={!baseUrl || !apiKey}>
            <Plus className="w-4 h-4 mr-1" /> Add Backend
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {(accounts || []).map((a) => {
          let info: any = {};
          try { info = JSON.parse(a.tokens || "{}"); } catch {}
          return (
            <Card key={a.id}>
              <CardContent className="flex items-center justify-between py-3">
                <div>
                  <div className="font-medium text-sm">{a.email}</div>
                  <div className="text-xs text-muted-foreground">{info.base_url}</div>
                  <div className="flex gap-1 mt-1">
                    {(info.modalities || []).map((m: string) => (
                      <span key={m} className="text-xs px-2 py-0.5 rounded bg-muted">{m}</span>
                    ))}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeAccount(a.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
