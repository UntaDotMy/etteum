import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  Loader2,
  Image as ImageIcon,
  Video,
  Download,
  RefreshCw,
  Trash2,
  Bot,
  User as UserIcon,
  Check,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  ArrowUp,
  Wand2,
} from "lucide-react";
import {
  assistPrompt,
  fetchAssistModels,
  fetchActiveModels,
  generateImage,
  fetchChats,
  fetchChat,
  createChat,
  updateChat,
  fetchResults,
  deleteResult,
  clearResults,
  type AssistModelInfo,
  type ChatMessage,
  type StoredResult,
} from "@/lib/api";
import {
  markPending,
  clearPending,
  getPending,
  subscribePending,
  promptKey,
  type PendingRequest,
} from "@/lib/pending";

type GenType = "image" | "video";
type ComposerMode = "image" | "video" | "agent";

type GenModelInfo = { id: string; provider: string };

interface GenResult {
  id: number;
  prompt: string;
  type: GenType;
  aspectRatio: string;
  n: number;
  urls: string[];
  creditsUsed: number;
  createdAt: number;
  model?: string;
}

interface FeaturedTemplate {
  id: string;
  label: string;
  prompt: string;
  /** Fallback gradient if the image fails to load. */
  face: string;
  /** Card thumbnail (stock preview for the style). */
  image: string;
}

function isGenModel(id: string, kind: GenType): boolean {
  const l = (id || "").toLowerCase();
  if (!l) return false;
  if (kind === "video") return l.includes("video");
  if (l.includes("video")) return false;
  return (
    l.includes("image") ||
    l === "grok-image" ||
    l.includes("dall-e") ||
    l.includes("flux") ||
    l.includes("imagen")
  );
}

function resultFromStored(r: StoredResult): GenResult {
  return {
    id: r.id,
    prompt: r.prompt,
    type: r.type,
    aspectRatio: r.aspectRatio,
    n: r.n,
    urls: Array.isArray(r.urls) ? r.urls : [],
    creditsUsed: r.creditsUsed,
    createdAt: new Date(r.createdAt).getTime(),
    model:
      typeof (r as { model?: string }).model === "string"
        ? (r as { model?: string }).model
        : undefined,
  };
}

const GEN_MODEL_STORAGE_KEY = "etteum-image-studio-gen-model";

function safeModelFileStem(model: string | undefined, type: GenType): string {
  const raw = (model || type || "image").toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return raw || "image";
}

const ASPECT_RATIOS: Array<{ value: string; label: string }> = [
  { value: "1:1", label: "Square" },
  { value: "16:9", label: "Landscape" },
  { value: "9:16", label: "Portrait" },
  { value: "4:3", label: "Classic" },
  { value: "3:4", label: "Photo" },
  { value: "5:4", label: "Studio" },
  { value: "4:5", label: "Social" },
  { value: "2:1", label: "Cinematic" },
  { value: "2:3", label: "Tall" },
  { value: "3:2", label: "Wide" },
];

/** Static featured templates — prompt presets with real preview thumbnails. */
const FEATURED_TEMPLATES: FeaturedTemplate[] = [
  {
    id: "glossy-product",
    label: "Glossy Product Shot",
    prompt:
      "Studio product photography of a premium serum bottle on glossy reflective surface, soft gradient backdrop, crisp highlights, commercial advertising style",
    face: "linear-gradient(145deg, #0b3d2e 0%, #1a8f5f 45%, #7dffc3 100%)",
    image:
      "https://images.unsplash.com/photo-1620916297397-a4a5402a3c6c?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "chibi",
    label: "Chibi",
    prompt:
      "Cute chibi character with oversized head, big expressive eyes, soft pastel palette, clean cel shading, kawaii sticker style",
    face: "linear-gradient(160deg, #2a1840 0%, #7c3aed 40%, #f9a8d4 100%)",
    image:
      "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "object-remover",
    label: "Object Remover",
    prompt:
      "Clean tourist photo of a famous landmark with empty foreground, natural lighting, photorealistic, no people in frame",
    face: "linear-gradient(160deg, #0f172a 0%, #334155 50%, #94a3b8 100%)",
    image:
      "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "pro-headshot",
    label: "Professional Headshot",
    prompt:
      "Professional corporate headshot portrait, soft studio lighting, shallow depth of field, neutral background, confident natural smile",
    face: "linear-gradient(160deg, #1c1917 0%, #78716c 50%, #e7e5e4 100%)",
    image:
      "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "haze-portrait",
    label: "Haze Portrait",
    prompt:
      "Cinematic portrait with soft haze and diffused light, moody atmosphere, film grain, shallow depth of field, editorial fashion look",
    face: "linear-gradient(150deg, #1e1b4b 0%, #6366f1 45%, #c4b5fd 100%)",
    image:
      "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "product-showcase",
    label: "Product Showcase",
    prompt:
      "Luxury jewelry product showcase on reflective pedestal, dramatic side light, macro detail, high-end commercial photography",
    face: "linear-gradient(145deg, #111827 0%, #374151 40%, #e5e7eb 100%)",
    image:
      "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "logo-editor",
    label: "Logo Editor",
    prompt:
      "Minimal modern logo mark on clean dark background, geometric icon, balanced negative space, brand identity presentation",
    face: "linear-gradient(160deg, #0a0a0a 0%, #262626 50%, #a3a3a3 100%)",
    image:
      "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "street-70s",
    label: "70s Street Style",
    prompt:
      "1970s street fashion photography, warm film tones, candid urban scene, vintage clothing, natural light, analog grain",
    face: "linear-gradient(150deg, #422006 0%, #b45309 45%, #fde68a 100%)",
    image:
      "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "anime-garden",
    label: "Anime Garden",
    prompt:
      "Anime girl in a blooming flower garden, soft sunlight, detailed hair, vibrant spring colors, high quality anime illustration",
    face: "linear-gradient(150deg, #14532d 0%, #22c55e 40%, #bbf7d0 100%)",
    image:
      "https://images.unsplash.com/photo-1490750967868-88aa4486c946?auto=format&fit=crop&w=400&h=520&q=80",
  },
  {
    id: "neon-city",
    label: "Neon City",
    prompt:
      "Futuristic cyberpunk city skyline at night, neon reflections on wet streets, dense skyscrapers, cinematic wide shot",
    face: "linear-gradient(150deg, #042f2e 0%, #0891b2 40%, #a78bfa 100%)",
    image:
      "https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=400&h=520&q=80",
  },
];

function labelProvider(provider: string) {
  if (provider === "kiro-pro") return "Kiro Pro";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  if (provider === "grok") return "Grok";
  if (provider === "canva") return "Canva";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Flatten results into individual media tiles for the masonry. */
function flattenTiles(results: GenResult[]) {
  const tiles: Array<{
    key: string;
    result: GenResult;
    url: string;
    index: number;
  }> = [];
  for (const r of results) {
    if (r.urls.length === 0) {
      tiles.push({ key: `${r.id}-empty`, result: r, url: "", index: 0 });
      continue;
    }
    r.urls.forEach((url, index) => {
      tiles.push({ key: `${r.id}-${index}`, result: r, url, index });
    });
  }
  // Newest first — Imagine-style discover feed.
  return tiles.reverse();
}

export default function ImageStudio() {
  const [assistModels, setAssistModels] = useState<AssistModelInfo[]>([]);
  const [assistModel, setAssistModel] = useState<string>("auto");
  const [genModels, setGenModels] = useState<GenModelInfo[]>([]);
  const [genModel, setGenModel] = useState<string>("");
  const [genType, setGenType] = useState<GenType>("image");
  const [composerMode, setComposerMode] = useState<ComposerMode>("image");
  const [aspectRatio, setAspectRatio] = useState<string>("2:3");
  /** Image variant count (1–4). Always 1 for video. */
  const [n, setN] = useState<number>(1);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [finalPrompt, setFinalPrompt] = useState<string | null>(null);
  const [currentOptions, setCurrentOptions] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<GenResult[]>([]);
  const [chatId, setChatId] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [pending, setPending] = useState<PendingRequest[]>(() => getPending());

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipSaveRef = useRef(true);

  function markBroken(url: string) {
    setBrokenUrls((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }

  async function removeResult(id: number) {
    setResults((prev) => prev.filter((r) => r.id !== id));
    try {
      await deleteResult(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearHistory() {
    if (results.length === 0) return;
    if (!confirm("Clear all results from history?")) return;
    setResults([]);
    setBrokenUrls(new Set());
    try {
      await clearResults(chatId ?? undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function regenerate(r: GenResult) {
    const model = (r.model || genModel || "").trim();
    if (!model) {
      setError("Pick a generation model first (Canva, Grok, …).");
      return;
    }
    setGenerating(true);
    setError(null);
    const pkey = promptKey(r.type, chatId ?? "anon", r.prompt);
    markPending({ key: pkey, kind: r.type, startedAt: Date.now(), label: r.prompt.slice(0, 60) });
    try {
      const res = await generateImage({
        prompt: r.prompt,
        type: r.type,
        model,
        aspectRatio: r.aspectRatio,
        n: r.n,
        chatId,
      });
      const fresh: GenResult = {
        id: res.id ?? Date.now(),
        prompt: res.prompt,
        type: res.type as GenType,
        aspectRatio: res.aspectRatio,
        n: res.n,
        urls: res.urls,
        creditsUsed: res.creditsUsed,
        createdAt: res.createdAt ? new Date(res.createdAt).getTime() : Date.now(),
        model,
      };
      setResults((prev) => [...prev, fresh]);
      try {
        await deleteResult(r.id);
      } catch {
        /* ignore */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      clearPending(pkey);
      setGenerating(false);
    }
  }

  useEffect(() => {
    fetchAssistModels()
      .then((res) => {
        setAssistModels(res.data || []);
        const auto = res.data?.find((m) => m.id === "auto");
        if (auto) setAssistModel(auto.id);
        else if (res.data?.[0]) setAssistModel(res.data[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

    fetchActiveModels()
      .then((res) => {
        const rows = (res.data || [])
          .map((m) => ({
            id: String(m.id || m.model || ""),
            provider: String(
              m.provider ||
                (String(m.id || "").toLowerCase().startsWith("canva")
                  ? "canva"
                  : String(m.id || "").toLowerCase().startsWith("grok")
                    ? "grok"
                    : m.owned_by || "unknown"),
            ),
          }))
          .filter((m) => m.id && (isGenModel(m.id, "image") || isGenModel(m.id, "video")));
        const byId = new Map<string, GenModelInfo>();
        for (const row of rows) {
          if (!byId.has(row.id)) byId.set(row.id, row);
        }
        const unique = Array.from(byId.values());
        setGenModels(unique);
        let saved = "";
        try {
          saved = localStorage.getItem(GEN_MODEL_STORAGE_KEY) || "";
        } catch {
          /* ignore */
        }
        const imageRows = unique.filter((m) => isGenModel(m.id, "image"));
        const pick =
          (saved && unique.some((m) => m.id === saved) ? saved : "") ||
          imageRows[0]?.id ||
          unique[0]?.id ||
          "";
        if (pick) setGenModel(pick);
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load generation models (need Canva and/or Grok accounts active)",
        );
      });
  }, []);

  useEffect(() => {
    const sync = () => {
      const list = getPending();
      setPending(list);
      if (list.some((p) => p.kind === "image" || p.kind === "video")) setGenerating(true);
    };
    sync();
    return subscribePending(sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const chatsRes = await fetchChats();
        const latest = chatsRes.data?.[0];
        let activeChatId: number | null = null;
        if (latest) {
          const full = await fetchChat(latest.id);
          if (cancelled) return;
          activeChatId = full.id;
          setChatId(full.id);
          setMessages(Array.isArray(full.messages) ? full.messages : []);
          setFinalPrompt(full.finalPrompt);
          setCurrentOptions(Array.isArray(full.options) ? full.options : []);
          if (full.assistModel) setAssistModel(full.assistModel);
          if ((full.messages?.length || 0) > 0 || full.finalPrompt) {
            setAgentOpen(true);
            setComposerMode("agent");
          }
        }
        const resultsRes = await fetchResults(
          activeChatId !== null ? { chatId: activeChatId, limit: 50 } : { limit: 50 },
        );
        if (cancelled) return;
        setResults((resultsRes.data || []).map(resultFromStored));
        for (const p of getPending()) {
          if (p.kind === "image" || p.kind === "video") clearPending(p.key);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoadingHistory(false);
          setGenerating(false);
          skipSaveRef.current = false;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (skipSaveRef.current || loadingHistory) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        if (chatId === null) {
          if (messages.length === 0) return;
          const created = await createChat({
            messages,
            finalPrompt,
            options: currentOptions,
            assistModel,
          });
          setChatId(created.id);
        } else {
          await updateChat(chatId, {
            messages,
            finalPrompt,
            options: currentOptions,
            assistModel,
          });
        }
      } catch (err) {
        console.error("[ImageStudio] failed to persist chat:", err);
      }
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [messages, finalPrompt, currentOptions, assistModel, chatId, loadingHistory]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, thinking, agentOpen]);

  const groupedModels = useMemo(() => {
    const map = new Map<string, AssistModelInfo[]>();
    for (const m of assistModels) {
      const list = map.get(m.provider) || [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries());
  }, [assistModels]);

  const genModelsForType = useMemo(
    () => genModels.filter((m) => isGenModel(m.id, genType)),
    [genModels, genType],
  );

  const groupedGenModels = useMemo(() => {
    const map = new Map<string, GenModelInfo[]>();
    for (const m of genModelsForType) {
      const list = map.get(m.provider) || [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries());
  }, [genModelsForType]);

  useEffect(() => {
    if (genModelsForType.length === 0) {
      if (genModel) setGenModel("");
      return;
    }
    if (!genModelsForType.some((m) => m.id === genModel)) {
      setGenModel(genModelsForType[0]!.id);
    }
  }, [genType, genModelsForType, genModel]);

  useEffect(() => {
    if (!genModel) return;
    try {
      localStorage.setItem(GEN_MODEL_STORAGE_KEY, genModel);
    } catch {
      /* ignore */
    }
  }, [genModel]);

  // Video always generates a single clip.
  useEffect(() => {
    if (genType === "video" && n !== 1) setN(1);
  }, [genType, n]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    const newHistory: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(newHistory);
    setInput("");
    setCurrentOptions([]);
    setError(null);
    setThinking(true);
    setAgentOpen(true);
    setComposerMode("agent");
    try {
      const res = await assistPrompt({ message: trimmed, history: messages, model: assistModel });
      setMessages([...newHistory, { role: "assistant", content: res.reply || "(empty)" }]);
      setCurrentOptions(res.options || []);
      if (res.finalPrompt) setFinalPrompt(res.finalPrompt);
    } catch (err) {
      setMessages(newHistory);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
    }
  }

  async function pickOption(option: string) {
    await sendMessage(option);
  }

  async function runGenerate(promptOverride?: string) {
    let prompt = (promptOverride ?? finalPrompt ?? input).trim();
    if (!prompt) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "user") {
          prompt = m.content;
          break;
        }
      }
    }
    if (!prompt) {
      setError("Type a prompt to imagine, or use Agent to refine one.");
      return;
    }
    if (!genModel.trim()) {
      setError(
        "No generation model selected. Add an active Canva and/or Grok account, then pick a model.",
      );
      return;
    }
    setGenerating(true);
    setError(null);
    setInput("");
    const pkey = promptKey(genType, chatId ?? "anon", prompt);
    markPending({ key: pkey, kind: genType, startedAt: Date.now(), label: prompt.slice(0, 60) });
    try {
      const res = await generateImage({
        prompt,
        type: genType,
        model: genModel,
        aspectRatio,
        n,
        chatId,
      });
      const result: GenResult = {
        id: res.id ?? Date.now(),
        prompt: res.prompt,
        type: res.type as GenType,
        aspectRatio: res.aspectRatio,
        n: res.n,
        urls: res.urls,
        creditsUsed: res.creditsUsed,
        createdAt: res.createdAt ? new Date(res.createdAt).getTime() : Date.now(),
        model: genModel,
      };
      setResults((prev) => [...prev, result]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      clearPending(pkey);
      setGenerating(false);
    }
  }

  async function onComposerSubmit() {
    const text = input.trim();
    if (composerMode === "agent") {
      if (!text && finalPrompt) {
        await runGenerate(finalPrompt);
        return;
      }
      await sendMessage(text || finalPrompt || "");
      return;
    }
    // Image / Video — generate directly from the typed prompt.
    if (composerMode === "image") setGenType("image");
    if (composerMode === "video") setGenType("video");
    await runGenerate(text || finalPrompt || undefined);
  }

  function setMode(mode: ComposerMode) {
    setComposerMode(mode);
    if (mode === "image") {
      setGenType("image");
      setAgentOpen(false);
    } else if (mode === "video") {
      setGenType("video");
      setN(1);
      setAgentOpen(false);
    } else {
      setAgentOpen(true);
    }
  }

  function applyTemplate(t: FeaturedTemplate) {
    setInput(t.prompt);
    setFinalPrompt(t.prompt);
    setComposerMode("image");
    setGenType("image");
    setAgentOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function downloadUrl(url: string, filename: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function scrollTemplates(dir: -1 | 1) {
    const el = templatesRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(280, el.clientWidth * 0.7), behavior: "smooth" });
  }

  const tiles = useMemo(() => flattenTiles(results), [results]);
  const totalCredits = results.reduce((sum, r) => sum + r.creditsUsed, 0);
  const totalImages = results.reduce((sum, r) => sum + r.urls.length, 0);
  const busy = generating || thinking || pending.some((p) => p.kind === "image" || p.kind === "video");

  return (
    <div className="relative -mx-4 -mb-4 flex min-h-[calc(100vh-5rem)] flex-col md:-mx-6 md:-mb-6 md:min-h-[calc(100vh-3rem)]">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-1 md:px-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--foreground)]">
            Image Studio
          </h1>
          <p className="text-xs text-[var(--muted-foreground)]">
            Imagine · templates · generate · refine
          </p>
        </div>
        {results.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs sm:flex">
              <ImageIcon className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              <span className="font-medium text-[var(--foreground)]">{totalImages}</span>
              <span className="text-[var(--muted-foreground)]">results</span>
            </div>
            <div className="hidden items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs sm:flex">
              <Sparkles className="h-3.5 w-3.5 text-[var(--warning)]" />
              <span className="font-medium text-[var(--foreground)]">{totalCredits}</span>
              <span className="text-[var(--muted-foreground)]">credits</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearHistory}
              className="gap-1.5 text-[var(--muted-foreground)] hover:text-[var(--error)]"
              title="Clear gallery"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clear</span>
            </Button>
          </div>
        )}
      </div>

      {/* ── Scrollable body (templates + discover) ─────────────── */}
      <div className="flex-1 overflow-y-auto px-4 pb-40 md:px-6">
        {/* Featured Templates */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-[var(--foreground)]">Featured Templates</h2>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => scrollTemplates(-1)}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                aria-label="Scroll templates left"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => scrollTemplates(1)}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                aria-label="Scroll templates right"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div
            ref={templatesRef}
            className="flex gap-3 overflow-x-auto pb-2 scrollbar-none"
            style={{ scrollbarWidth: "none" } as CSSProperties}
          >
            {FEATURED_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => applyTemplate(t)}
                className="group relative w-[140px] flex-shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-all hover:border-[var(--primary)]/50 hover:shadow-[var(--glow)] sm:w-[156px]"
              >
                <div
                  className="relative aspect-[3/4] w-full overflow-hidden"
                  style={{ background: t.face }}
                >
                  <img
                    src={t.image}
                    alt={t.label}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.06]"
                    onError={(e) => {
                      // Fall back to gradient face if the preview image fails.
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />
                  <div className="absolute bottom-0 left-0 right-0 p-2.5">
                    <p className="text-[11px] font-medium leading-snug text-white drop-shadow">
                      {t.label}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Discover / gallery */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-[var(--foreground)]">Discover</h2>
            {loadingHistory && (
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading history…
              </span>
            )}
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)]">
              {error}
              <button
                type="button"
                className="ml-2 underline opacity-80 hover:opacity-100"
                onClick={() => setError(null)}
              >
                dismiss
              </button>
            </div>
          )}

          {tiles.length === 0 && !generating && !loadingHistory ? (
            <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5">
              {/* Placeholder discover tiles so empty state still feels like Imagine */}
              {[
                "linear-gradient(160deg,#0f172a,#1e3a5f)",
                "linear-gradient(160deg,#1a0a2e,#5b21b6)",
                "linear-gradient(160deg,#0a1f14,#065f46)",
                "linear-gradient(160deg,#1c1008,#9a3412)",
                "linear-gradient(160deg,#111827,#374151)",
                "linear-gradient(160deg,#0c1222,#1d4ed8)",
                "linear-gradient(160deg,#1f0a14,#9f1239)",
                "linear-gradient(160deg,#0a1628,#0e7490)",
              ].map((bg, i) => (
                <div
                  key={i}
                  className="mb-3 break-inside-avoid overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]"
                  style={{
                    background: bg,
                    height: i % 3 === 0 ? 220 : i % 3 === 1 ? 160 : 280,
                    opacity: 0.55,
                  }}
                />
              ))}
              <div className="pointer-events-none absolute inset-x-0 top-[42%] z-10 flex justify-center px-6">
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)]/90 px-5 py-4 text-center shadow-[var(--shadow-card)] backdrop-blur">
                  <Sparkles className="mx-auto mb-2 h-5 w-5 text-[var(--primary)]" />
                  <p className="text-sm font-medium text-[var(--foreground)]">Your gallery is empty</p>
                  <p className="mt-1 max-w-xs text-xs text-[var(--muted-foreground)]">
                    Pick a template or type a prompt below — generations land here.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5">
              {tiles.map((tile) => {
                const r = tile.result;
                const broken = tile.url ? brokenUrls.has(tile.url) : true;
                const [aw, ah] = r.aspectRatio.split(":").map(Number);
                const aspectStyle =
                  r.type !== "video" && aw && ah
                    ? ({ aspectRatio: `${aw} / ${ah}` } as CSSProperties)
                    : undefined;

                return (
                  <div
                    key={tile.key}
                    className="group relative mb-3 break-inside-avoid overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]"
                  >
                    <div style={aspectStyle} className="relative w-full bg-[var(--secondary)]">
                      {broken || !tile.url ? (
                        <div
                          className="flex min-h-[140px] flex-col items-center justify-center gap-1.5 p-4 text-center"
                          style={
                            !tile.url
                              ? {
                                  background:
                                    "linear-gradient(145deg, color-mix(in srgb, var(--primary) 12%, var(--card)), var(--secondary))",
                                  minHeight: 180,
                                }
                              : undefined
                          }
                        >
                          <ImageIcon className="h-5 w-5 text-[var(--muted-foreground)]" />
                          <p className="line-clamp-3 px-2 text-[10px] text-[var(--muted-foreground)]">
                            {tile.url ? "Link expired" : r.prompt}
                          </p>
                        </div>
                      ) : r.type === "video" ? (
                        <video
                          src={tile.url}
                          controls
                          onError={() => markBroken(tile.url)}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <img
                          src={tile.url}
                          alt={r.prompt.slice(0, 80)}
                          loading="lazy"
                          onError={() => markBroken(tile.url)}
                          onClick={() => setLightbox(tile.url)}
                          className="h-full w-full cursor-zoom-in object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        />
                      )}

                      {/* Hover chrome */}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                      <div className="absolute inset-x-0 bottom-0 translate-y-1 p-2.5 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100">
                        <p className="line-clamp-2 text-[10px] leading-snug text-white/90">
                          {r.prompt}
                        </p>
                        <div className="mt-1.5 flex items-center gap-1">
                          <Badge
                            variant={r.type === "video" ? "warning" : "secondary"}
                            className="px-1.5 py-0 text-[9px]"
                          >
                            {r.type}
                          </Badge>
                          <span className="font-mono text-[9px] text-white/70">{r.aspectRatio}</span>
                          <span className="text-[9px] text-white/50">· {timeAgo(r.createdAt)}</span>
                        </div>
                      </div>
                      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {tile.url && !broken && (
                          <button
                            type="button"
                            onClick={() =>
                              downloadUrl(
                                tile.url,
                                `${safeModelFileStem(r.model || genModel, r.type)}_${r.aspectRatio}_${r.id}_${tile.index + 1}.${
                                  r.type === "video"
                                    ? "mp4"
                                    : tile.url.startsWith("data:image/jpeg")
                                      ? "jpg"
                                      : "png"
                                }`,
                              )
                            }
                            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white backdrop-blur-sm hover:bg-black"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => regenerate(r)}
                          disabled={generating}
                          className="flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white backdrop-blur-sm hover:bg-black disabled:opacity-50"
                          title="Regenerate"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeResult(r.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white backdrop-blur-sm hover:bg-[var(--error)]"
                          title="Delete"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {generating && (
                <div className="mb-3 break-inside-avoid overflow-hidden rounded-xl border border-dashed border-[var(--primary)]/40 bg-gradient-to-br from-[var(--primary)]/10 via-[var(--card)] to-transparent p-8">
                  <div className="text-center">
                    <Loader2 className="mx-auto mb-2 h-8 w-8 animate-spin text-[var(--primary)]" />
                    <p className="text-sm font-medium text-[var(--foreground)]">
                      Imagining {genType}…
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                      {genModel || "model"} · {aspectRatio}
                      {genType === "image" ? ` · ×${n}` : ""}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* ── Agent side panel (when Agent mode / assist chat) ───── */}
      {agentOpen && (
        <div className="fixed bottom-28 right-3 z-30 flex w-[min(100vw-1.5rem,380px)] max-h-[min(58vh,520px)] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)] md:right-6">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary)]/10">
                <Wand2 className="h-3.5 w-3.5 text-[var(--primary)]" />
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--foreground)]">Agent</p>
                <p className="text-[10px] text-[var(--muted-foreground)]">
                  Prompt assistant · refine then generate
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <div className="relative">
                <select
                  value={assistModel}
                  onChange={(e) => setAssistModel(e.target.value)}
                  className="h-7 min-w-[5.5rem] max-w-[min(100%,12rem)] appearance-none rounded-md border border-[var(--border)] bg-[var(--background)] pl-2 pr-6 text-[10px] leading-none text-[var(--foreground)]"
                  title={assistModel || "Assist model"}
                  style={{
                    width: `${Math.min(
                      192,
                      Math.max(88, ((assistModel || "auto").length + 3) * 6.5),
                    )}px`,
                  }}
                >
                  {groupedModels.map(([provider, list]) => (
                    <optgroup key={provider} label={labelProvider(provider)}>
                      {list.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--muted-foreground)]" />
              </div>
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMessages([]);
                    setFinalPrompt(null);
                    setCurrentOptions([]);
                  }}
                  className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                  title="Reset agent chat"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setAgentOpen(false)}
                className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                title="Close agent"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div ref={chatScrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
            {messages.length === 0 && !thinking && (
              <div className="px-1 py-6 text-center">
                <Bot className="mx-auto mb-2 h-6 w-6 text-[var(--primary)]" />
                <p className="text-xs font-medium text-[var(--foreground)]">Describe what you want</p>
                <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                  Agent will ask a few style questions, then hand you a final prompt.
                </p>
              </div>
            )}

            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
              >
                <div
                  className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${
                    msg.role === "user"
                      ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)]"
                  }`}
                >
                  {msg.role === "user" ? (
                    <UserIcon className="h-3 w-3" />
                  ) : (
                    <Bot className="h-3 w-3" />
                  )}
                </div>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed ${
                    msg.role === "user"
                      ? "rounded-tr-sm bg-[var(--primary)] text-[var(--primary-foreground)]"
                      : "rounded-tl-sm bg-[var(--secondary)] text-[var(--foreground)]"
                  }`}
                >
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              </div>
            ))}

            {!thinking && currentOptions.length > 0 && (
              <div className="ml-8 flex flex-wrap gap-1.5">
                {currentOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => pickOption(opt)}
                    disabled={thinking}
                    className="rounded-full border border-[var(--primary)]/30 bg-[var(--primary)]/5 px-2.5 py-1 text-[11px] text-[var(--foreground)] transition-all hover:border-[var(--primary)]/60 hover:bg-[var(--primary)]/10 disabled:opacity-50"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {thinking && (
              <div className="flex gap-2">
                <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--secondary)]">
                  <Bot className="h-3 w-3 text-[var(--muted-foreground)]" />
                </div>
                <div className="rounded-2xl rounded-tl-sm bg-[var(--secondary)] px-3 py-2">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--muted-foreground)] [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--muted-foreground)] [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--muted-foreground)]" />
                  </div>
                </div>
              </div>
            )}

            {finalPrompt && (
              <div className="rounded-xl border border-[var(--primary)]/30 bg-gradient-to-br from-[var(--primary)]/10 via-[var(--primary)]/5 to-transparent p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--primary)]">
                    <Check className="h-3 w-3" /> Final prompt
                  </span>
                  <button
                    type="button"
                    onClick={() => setFinalPrompt(null)}
                    className="rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <p className="mb-2 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--foreground)]">
                  {finalPrompt}
                </p>
                <Button
                  size="sm"
                  className="w-full gap-1.5 bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
                  onClick={() => runGenerate(finalPrompt)}
                  disabled={generating}
                >
                  {generating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" /> Generate {genType}
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Floating composer (Grok Imagine style) ───────────────
          Fixed to the content pane, not the full viewport: on md+ we inset
          left by --main-offset (set by Layout from sidebar collapsed state)
          so the bar stays centered in the main column. */}
      <div
        className="pointer-events-none fixed bottom-0 right-0 left-0 z-40 flex justify-center px-3 pb-4 transition-[left] duration-200 md:left-[var(--main-offset,240px)] md:px-6 md:pb-6"
      >
        <div className="pointer-events-auto w-full max-w-3xl">
          <div className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--card)]/95 p-2 shadow-[var(--shadow-card)] backdrop-blur-xl supports-[backdrop-filter]:bg-[var(--card)]/85">
            {/* Input row */}
            <div className="flex items-center gap-2 px-1 pt-1">
              <button
                type="button"
                onClick={() => setMode(composerMode === "agent" ? "image" : "agent")}
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                  composerMode === "agent"
                    ? "border-[var(--primary)]/50 bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "border-[var(--border)] bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
                title={composerMode === "agent" ? "Agent on" : "Open agent"}
              >
                <Plus className="h-4 w-4" />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onComposerSubmit();
                  }
                }}
                placeholder={
                  composerMode === "agent"
                    ? "Describe your idea — agent will refine it…"
                    : "Type to imagine"
                }
                rows={1}
                className="max-h-28 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm leading-5 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void onComposerSubmit()}
                disabled={busy || (!input.trim() && !finalPrompt)}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                title="Imagine"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </button>
            </div>

            {/* Controls row — single baseline, vertically centered chips */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1 pb-0.5">
              {/* Mode: Image | Video | Agent */}
              <div className="inline-flex h-8 items-center rounded-full border border-[var(--border)] bg-[var(--background)] p-0.5">
                {(
                  [
                    { id: "image" as const, icon: ImageIcon, label: "Image" },
                    { id: "video" as const, icon: Video, label: "Video" },
                    { id: "agent" as const, icon: Bot, label: "Agent" },
                  ] as const
                ).map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMode(id)}
                    className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-full px-2.5 text-[11px] leading-none transition-colors ${
                      composerMode === id
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>

              {/* Variant count: 1 / 2 / 3 / 4 (image only) */}
              {composerMode !== "video" && (
                <div
                  className="inline-flex h-8 items-center rounded-full border border-[var(--border)] bg-[var(--background)] p-0.5"
                  title="How many images to generate"
                >
                  <span className="hidden pl-2 pr-1 text-[10px] text-[var(--muted-foreground)] sm:inline">
                    ×
                  </span>
                  {([1, 2, 3, 4] as const).map((count) => (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setN(count)}
                      className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[11px] font-medium leading-none tabular-nums transition-colors ${
                        n === count
                          ? "bg-[var(--secondary)] text-[var(--foreground)]"
                          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      }`}
                      title={`Generate ${count} image${count > 1 ? "s" : ""}`}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              )}

              {/* Model picker — size to content; don't clamp so short names like grok-image don't clip */}
              <div className="relative inline-flex h-8 max-w-full items-center">
                <select
                  value={genModel}
                  onChange={(e) => setGenModel(e.target.value)}
                  disabled={genModelsForType.length === 0}
                  className="h-8 min-w-[7.5rem] max-w-[min(100%,14rem)] appearance-none rounded-full border border-[var(--border)] bg-[var(--background)] py-0 pl-3 pr-8 text-[11px] leading-none text-[var(--foreground)] disabled:opacity-50"
                  title={genModel || "Generation model"}
                  style={{
                    // Grow with the selected label so long model ids aren't cut mid-word.
                    width: `${Math.min(
                      224,
                      Math.max(120, ((genModel || "No models").length + 3) * 7.2),
                    )}px`,
                  }}
                >
                  {genModelsForType.length === 0 ? (
                    <option value="">No models</option>
                  ) : (
                    groupedGenModels.map(([provider, list]) => (
                      <optgroup key={provider} label={labelProvider(provider)}>
                        {list.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--muted-foreground)]" />
              </div>

              {/* Aspect ratio */}
              {composerMode !== "video" && (
                <div className="relative inline-flex h-8 items-center">
                  <select
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
                    className="h-8 min-w-[4.25rem] appearance-none rounded-full border border-[var(--border)] bg-[var(--background)] py-0 pl-3 pr-7 font-mono text-[11px] leading-none text-[var(--foreground)]"
                    title="Aspect ratio"
                  >
                    {ASPECT_RATIOS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.value}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--muted-foreground)]" />
                </div>
              )}

              {finalPrompt && composerMode === "agent" && (
                <span className="ml-auto hidden h-8 items-center gap-1 text-[10px] leading-none text-[var(--primary)] sm:inline-flex">
                  <Check className="h-3 w-3" /> prompt ready
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/95 p-8 backdrop-blur-sm"
        >
          <button
            type="button"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={lightbox}
            alt="full"
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
