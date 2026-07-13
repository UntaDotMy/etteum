import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Plus,
  Trash2,
  Settings2,
  Sparkles,
  Loader2,
  Bot,
  User,
  ChevronDown,
  StopCircle,
  PanelLeft,
  MessageSquare,
  X,
  Paperclip,
  Image as ImageIcon,
  FileText,
  Video,
  Download,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { getApiKey, API_BASE, generateImage } from "@/lib/api";
import { cn, formatDateTimeID } from "@/lib/utils";

/** OpenAI-style multimodal content parts. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  /** data: URL (images) or text extract (files). */
  dataUrl?: string;
  textContent?: string;
  size: number;
}

interface MessageMedia {
  type: "image" | "video" | "file";
  url: string;
  name?: string;
}

interface Message {
  role: "user" | "assistant" | "system";
  /** Plain-text / markdown body for display + history text. */
  content: string;
  /** Multimodal parts sent to the API (vision). */
  parts?: ContentPart[];
  /** Generated or attached media rendered in the bubble. */
  media?: MessageMedia[];
  /** Model chain-of-thought / reasoning (not sent back as assistant history text). */
  thinking?: string;
  id: string;
  model?: string;
  timestamp?: number;
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const TEXT_MIME =
  /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|toml)|application\/(x-)?sh)/i;
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|xml|yml|yaml|log|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|sql|toml|ini|env|sh|bat|ps1)$/i;
const MAX_ATTACH_BYTES = 8 * 1024 * 1024; // 8 MB per file
const MAX_IMAGE_EDGE = 1536;

/** Detect image/video *generation* models (Canva Magic Media etc.). */
function mediaGenKind(modelId: string): "image" | "video" | null {
  const l = (modelId || "").toLowerCase();
  if (!l) return null;
  if (l.includes("video") || l === "canva-video") return "video";
  if (
    l.includes("image") ||
    l.startsWith("canva-image") ||
    l.includes("dall-e") ||
    l.includes("flux") ||
    l.includes("stable-image") ||
    l.includes("imagen")
  ) {
    return "image";
  }
  return null;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsDataURL(file);
  });
}

async function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsText(file);
  });
}

/** Downscale large images to keep localStorage + vision payloads reasonable. */
async function compressImageFile(file: File): Promise<{ dataUrl: string; size: number }> {
  const raw = await fileToDataUrl(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const max = MAX_IMAGE_EDGE;
      if (width > max || height > max) {
        const scale = Math.min(max / width, max / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve({ dataUrl: raw, size: file.size });
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      resolve({ dataUrl, size: Math.round((dataUrl.length * 3) / 4) });
    };
    img.onerror = () => resolve({ dataUrl: raw, size: file.size });
    img.src = raw;
  });
}

function extractMediaUrlsFromText(text: string): MessageMedia[] {
  const media: MessageMedia[] = [];
  const md = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text)) !== null) {
    const url = m[1]!;
    const isVid = /\.(mp4|webm|mov)(\?|$)/i.test(url) || /video/i.test(url);
    media.push({ type: isVid ? "video" : "image", url });
  }
  const bare = text.match(/https?:\/\/[^\s)"']+/g) || [];
  for (const url of bare) {
    if (media.some((x) => x.url === url)) continue;
    if (/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(url)) media.push({ type: "image", url });
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) media.push({ type: "video", url });
  }
  return media;
}

type StreamUpdate = {
  content: string;
  thinking: string;
};

/** Pull embedded `<think>` / `<thinking>` tags some models put in content. */
function extractEmbeddedThinking(text: string): { thinking: string; content: string } {
  let thinking = "";
  let content = text;
  const patterns = [/<think>([\s\S]*?)<\/think>/gi, /<thinking>([\s\S]*?)<\/thinking>/gi];
  for (const re of patterns) {
    content = content.replace(re, (_m, body: string) => {
      const t = String(body || "").trim();
      if (t) thinking = thinking ? `${thinking}\n\n${t}` : t;
      return "";
    });
  }
  return { thinking: thinking.trim(), content: content.replace(/^\s+/, "") };
}

function deltaTextPiece(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((p: { text?: string } | string) => (typeof p === "string" ? p : p?.text || ""))
      .join("");
  }
  return "";
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  createdAt: number;
  updatedAt: number;
  systemPrompt?: string;
}

type ProviderModel = {
  id: string;
  provider: string;
  label: string;
};

const STORAGE_KEY = "etteum-chat-conversations";
const SYSTEM_PROMPT_KEY = "etteum-chat-system-prompt";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function createNewConversation(model: string): Conversation {
  const now = Date.now();
  return {
    id: generateId(),
    title: "New chat",
    messages: [],
    model,
    createdAt: now,
    updatedAt: now,
  };
}

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveConversations(convs: Conversation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(convs));
  } catch {
    /* quota exceeded */
  }
}

function loadSystemPrompt(): string {
  return localStorage.getItem(SYSTEM_PROMPT_KEY) || DEFAULT_SYSTEM_PROMPT;
}

function saveSystemPrompt(p: string) {
  localStorage.setItem(SYSTEM_PROMPT_KEY, p);
}

async function fetchModels(): Promise<ProviderModel[]> {
  try {
    const res = await fetch(`${API_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data || []).map((m) => {
      const id = m.id;
      const prefix = id.includes("-") ? id.split("-")[0]! : "";
      return { id, provider: providerFromPrefix(prefix), label: id };
    });
  } catch {
    return [];
  }
}

function providerFromPrefix(prefix: string): string {
  const map: Record<string, string> = {
    ali: "Alibaba",
    kiro: "Kiro",
    codebuddy: "CodeBuddy",
    codex: "Codex",
    qoder: "Qoder",
    canva: "Canva",
    ym: "YouMind",
    byok: "BYOK",
    gl: "GitLab",
    gd: "GitLab",
  };
  return map[prefix] || prefix || "Other";
}

type ApiMessage = {
  role: string;
  content: string | ContentPart[];
};

async function streamChat(
  messages: ApiMessage[],
  model: string,
  onChunk: (update: StreamUpdate) => void,
  signal: AbortSignal,
): Promise<{ success: boolean; error?: string; content?: string; thinking?: string }> {
  try {
    const res = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let errMsg = `HTTP ${res.status}`;
      try {
        const err = text ? JSON.parse(text) : {};
        errMsg = err.error?.message || err.error || errMsg;
      } catch {
        if (text) errMsg = text.slice(0, 200);
      }
      return { success: false, error: errMsg };
    }

    if (!res.body) return { success: false, error: "No response body" };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let fullThinking = "";

    const emit = () => {
      const embedded = extractEmbeddedThinking(fullText);
      const thinking = [fullThinking, embedded.thinking].filter(Boolean).join("\n\n");
      onChunk({ content: embedded.content, thinking });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;

        const payload = dataLine.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};
          const message = choice?.message ?? {};

          const contentPiece =
            deltaTextPiece(delta.content) ||
            (typeof message.content === "string" ? message.content : "") ||
            deltaTextPiece(message.content);

          const thinkingPiece =
            deltaTextPiece(delta.reasoning_content) ||
            deltaTextPiece(delta.thinking) ||
            deltaTextPiece(delta.reasoning) ||
            deltaTextPiece(message.reasoning_content) ||
            deltaTextPiece(message.thinking);

          let changed = false;
          if (contentPiece) {
            fullText += contentPiece;
            changed = true;
          }
          if (thinkingPiece) {
            fullThinking += thinkingPiece;
            changed = true;
          }
          if (changed) emit();
        } catch {
          /* skip malformed */
        }
      }
    }

    const embedded = extractEmbeddedThinking(fullText);
    const thinking = [fullThinking, embedded.thinking].filter(Boolean).join("\n\n");
    return { success: true, content: embedded.content, thinking };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { success: false, error: "Cancelled" };
    }
    return { success: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

function formatMsgTime(ts?: number): string {
  if (!ts) return "";
  try {
    return formatDateTimeID(new Date(ts).toISOString());
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

export default function Chat() {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(() => loadSystemPrompt());
  const [searchQuery, setSearchQuery] = useState("");
  const [showHistory, setShowHistory] = useState(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = conversations.find((c) => c.id === activeId) || null;
  const genKind = mediaGenKind(active?.model || models[0]?.id || "");

  useEffect(() => {
    fetchModels().then((m) => {
      setModels(m);
      setModelsLoading(false);
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages, streamingText, streamingThinking]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 160) + "px";
    }
  }, [input]);

  useEffect(() => {
    if (models.length === 0 || activeId) return;
    if (conversations.length > 0) {
      setActiveId(conversations[0]!.id);
      return;
    }
    const conv = createNewConversation(models[0]!.id);
    setConversations([conv]);
    saveConversations([conv]);
    setActiveId(conv.id);
  }, [models, activeId, conversations]);

  const activeModel = active?.model || models[0]?.id || "";

  function updateConversation(id: string, updater: (c: Conversation) => Conversation) {
    setConversations((prev) => {
      const next = prev.map((c) => (c.id === id ? updater(c) : c));
      saveConversations(next);
      return next;
    });
  }

  function handleNewChat() {
    const model = activeModel || models[0]?.id || "ali-qwen-plus";
    const conv = createNewConversation(model);
    setConversations((prev) => {
      const next = [conv, ...prev];
      saveConversations(next);
      return next;
    });
    setActiveId(conv.id);
    setInput("");
    setAttachments([]);
    setAttachError(null);
    setStreamingText("");
    setStreamingThinking("");
  }

  function handleDeleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConversations(next);
      return next;
    });
    if (activeId === id) setActiveId(null);
  }

  function handleSelectConversation(id: string) {
    setActiveId(id);
    setStreamingText("");
    setStreamingThinking("");
    setInput("");
    setAttachments([]);
    setAttachError(null);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setShowHistory(false);
    }
  }

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setAttachError(null);
    const list = Array.from(files);
    const next: ChatAttachment[] = [];
    for (const file of list) {
      if (file.size > MAX_ATTACH_BYTES) {
        setAttachError(`${file.name} is larger than 8 MB — skipped`);
        continue;
      }
      const id = generateId();
      if (IMAGE_MIME.test(file.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) {
        try {
          const { dataUrl, size } = await compressImageFile(file);
          next.push({
            id,
            kind: "image",
            name: file.name,
            mime: file.type || "image/jpeg",
            dataUrl,
            size,
          });
        } catch {
          setAttachError(`Failed to read image ${file.name}`);
        }
        continue;
      }
      const isText =
        TEXT_MIME.test(file.type) || TEXT_EXT.test(file.name) || file.type === "" || file.type === "application/octet-stream";
      if (isText && file.size < 1_500_000) {
        try {
          const textContent = await fileToText(file);
          next.push({
            id,
            kind: "file",
            name: file.name,
            mime: file.type || "text/plain",
            textContent,
            size: file.size,
          });
        } catch {
          setAttachError(`Failed to read ${file.name}`);
        }
        continue;
      }
      setAttachError(
        `${file.name}: only images and text-like files are supported in chat (use Image Studio for Canva-only flows).`,
      );
    }
    if (next.length) setAttachments((prev) => [...prev, ...next].slice(0, 8));
  }, []);

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function handleModelChange(model: string) {
    if (!active) return;
    updateConversation(active.id, (c) => ({ ...c, model, updatedAt: Date.now() }));
    setShowModelSelect(false);
  }

  function handleSystemPromptSave() {
    saveSystemPrompt(systemPrompt);
    setShowSystemPrompt(false);
  }

  async function handleSend() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming || !active) return;

    const conv = conversations.find((c) => c.id === active.id);
    if (!conv) return;

    const model = conv.model || models[0]?.id || "";
    if (!model) {
      updateConversation(conv.id, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: "assistant",
            content: "Error: No model selected. Pick a model from the header.",
            id: generateId(),
            timestamp: Date.now(),
          },
        ],
      }));
      return;
    }

    // Build user message: text + file extracts + image previews
    const fileBlocks: string[] = [];
    const imageParts: ContentPart[] = [];
    const displayMedia: MessageMedia[] = [];
    for (const a of attachments) {
      if (a.kind === "image" && a.dataUrl) {
        imageParts.push({ type: "image_url", image_url: { url: a.dataUrl } });
        displayMedia.push({ type: "image", url: a.dataUrl, name: a.name });
      } else if (a.kind === "file" && a.textContent != null) {
        const clipped =
          a.textContent.length > 80_000
            ? a.textContent.slice(0, 80_000) + "\n…[truncated]"
            : a.textContent;
        fileBlocks.push(`--- File: ${a.name} ---\n${clipped}`);
        displayMedia.push({ type: "file", url: "", name: a.name });
      }
    }

    let userText = text;
    if (fileBlocks.length) {
      userText = [text, ...fileBlocks].filter(Boolean).join("\n\n");
    }
    if (!userText && imageParts.length) {
      userText = "Describe the attached image(s).";
    }

    const parts: ContentPart[] | undefined =
      imageParts.length > 0
        ? [{ type: "text", text: userText }, ...imageParts]
        : undefined;

    const userMsg: Message = {
      role: "user",
      content: userText,
      ...(parts ? { parts } : {}),
      ...(displayMedia.length ? { media: displayMedia } : {}),
      id: generateId(),
      timestamp: Date.now(),
    };

    const titleBase = text || attachments[0]?.name || "Attachment";
    updateConversation(conv.id, (c) => ({
      ...c,
      messages: [...c.messages, userMsg],
      updatedAt: Date.now(),
      title:
        c.messages.length === 0
          ? titleBase.slice(0, 40) + (titleBase.length > 40 ? "…" : "")
          : c.title,
    }));

    setInput("");
    setAttachments([]);
    setAttachError(null);
    setStreaming(true);
    setStreamingText("");
    setStreamingThinking("");

    // ── Image / video generation models (Canva Magic Media etc.) ───────────
    const gen = mediaGenKind(model);
    if (gen) {
      try {
        setStreamingText(gen === "video" ? "Generating video…" : "Generating image…");
        const res = await generateImage({
          prompt: userText,
          type: gen,
          // Pass selected model so routing uses Grok Imagine / Canva / etc. — not always Canva.
          model,
          aspectRatio: "1:1",
          n: 1,
        });
        const urls = res.urls || [];
        const media: MessageMedia[] = urls.map((url) => ({
          type: gen,
          url,
        }));
        const content =
          urls.length > 0
            ? (gen === "video" ? "Generated video:" : "Generated image(s):") +
              "\n" +
              urls.map((u) => `![](${u})`).join("\n")
            : "Generation finished but no media URL was returned.";
        updateConversation(conv.id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              role: "assistant",
              content,
              media,
              id: generateId(),
              model,
              timestamp: Date.now(),
            },
          ],
          updatedAt: Date.now(),
        }));
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        updateConversation(conv.id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              role: "assistant",
              content: `Error: ${errMsg}`,
              id: generateId(),
              timestamp: Date.now(),
            },
          ],
          updatedAt: Date.now(),
        }));
      }
      setStreaming(false);
      setStreamingText("");
      setStreamingThinking("");
      return;
    }

    // ── Normal chat / vision completions ───────────────────────────────────
    let latestText = "";
    let latestThinking = "";

    const apiMessages: ApiMessage[] = [];
    if (systemPrompt.trim()) {
      apiMessages.push({ role: "system", content: systemPrompt.trim() });
    }
    for (const m of conv.messages) {
      if (m.role === "system" || m.role === "user" || m.role === "assistant") {
        // Prefer stored multimodal parts for user history when present
        if (m.role === "user" && m.parts && m.parts.length > 0) {
          apiMessages.push({ role: m.role, content: m.parts });
        } else {
          apiMessages.push({ role: m.role, content: m.content });
        }
      }
    }
    apiMessages.push({
      role: "user",
      content: parts && parts.length > 0 ? parts : userText,
    });

    const abort = new AbortController();
    abortRef.current = abort;

    const result = await streamChat(
      apiMessages,
      model,
      (update) => {
        latestText = update.content;
        latestThinking = update.thinking;
        setStreamingText(update.content);
        setStreamingThinking(update.thinking);
      },
      abort.signal,
    );

    abortRef.current = null;

    if (result.success) {
      const finalContent = (result.content ?? latestText) || "(empty response)";
      const finalThinking = (result.thinking ?? latestThinking) || undefined;
      const media = extractMediaUrlsFromText(finalContent);
      updateConversation(conv.id, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: "assistant",
            content: finalContent,
            ...(finalThinking ? { thinking: finalThinking } : {}),
            ...(media.length ? { media } : {}),
            id: generateId(),
            model,
            timestamp: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }));
    } else if (result.error && result.error !== "Cancelled") {
      updateConversation(conv.id, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: "assistant",
            content: `Error: ${result.error}`,
            id: generateId(),
            timestamp: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }));
    } else if (result.error === "Cancelled" && (latestText || latestThinking)) {
      updateConversation(conv.id, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: "assistant",
            content: latestText || "(stopped)",
            ...(latestThinking ? { thinking: latestThinking } : {}),
            id: generateId(),
            model,
            timestamp: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }));
    }

    setStreaming(false);
    setStreamingText("");
    setStreamingThinking("");
  }

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const filteredModels = searchQuery.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(searchQuery.toLowerCase()))
    : models;

  const filteredModelsByProvider: Record<string, ProviderModel[]> = {};
  for (const m of filteredModels) {
    if (!filteredModelsByProvider[m.provider]) filteredModelsByProvider[m.provider] = [];
    filteredModelsByProvider[m.provider]!.push(m);
  }

  const historyPanel = (
    <div
      className={cn(
        "flex w-72 shrink-0 flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]",
        "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[min(100%,18rem)] max-md:shadow-[var(--shadow-card)]",
      )}
    >
      <div className="flex items-center justify-between border-b border-[var(--sidebar-border)] px-3 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--foreground)]">Chat</h2>
          <p className="text-[10px] text-[var(--muted-foreground)]">Local history · pool models</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => setShowHistory(false)}
          aria-label="Close history"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="p-2">
        <Button variant="outline" size="sm" className="w-full justify-start" onClick={handleNewChat}>
          <Plus className="mr-2 h-3.5 w-3.5" />
          New chat
        </Button>
      </div>

      <div className="px-3 pb-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          History
        </p>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            role="button"
            tabIndex={0}
            onClick={() => handleSelectConversation(conv.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleSelectConversation(conv.id);
              }
            }}
            className={cn(
              "group flex w-full cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
              conv.id === activeId
                ? "border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] shadow-[var(--shadow-card)]"
                : "border-transparent hover:border-[var(--border)] hover:bg-[var(--secondary)]/60",
            )}
          >
            <div
              className={cn(
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
                conv.id === activeId
                  ? "border-[var(--primary)]/40 bg-[color-mix(in_srgb,var(--primary)_14%,var(--card))]"
                  : "border-[var(--border)] bg-[var(--card)]",
              )}
            >
              <MessageSquare
                className={cn(
                  "h-3.5 w-3.5",
                  conv.id === activeId ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]",
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate text-xs font-medium",
                  conv.id === activeId ? "text-[var(--primary)]" : "text-[var(--foreground)]",
                )}
              >
                {conv.title}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">
                {conv.model}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => handleDeleteConversation(conv.id, e)}
              aria-label="Delete conversation"
            >
              <Trash2 className="h-3 w-3 text-[var(--error)]" />
            </Button>
          </div>
        ))}
        {conversations.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-8 text-center">
            <p className="text-xs text-[var(--muted-foreground)]">No conversations yet</p>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-[28rem] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
      {/* Desktop history */}
      {showHistory && <div className="hidden md:flex">{historyPanel}</div>}

      {/* Mobile history drawer */}
      {showHistory && (
        <div className="md:hidden">
          {historyPanel}
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setShowHistory(false)}
            aria-hidden
          />
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--background)]">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowHistory((v) => !v)}
            title="Toggle history"
          >
            <PanelLeft className="mr-1.5 h-3.5 w-3.5" />
            History
          </Button>
          <Button variant="outline" size="sm" onClick={handleNewChat}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New
          </Button>

          <div className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />

          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Button
              variant="outline"
              size="sm"
              className="max-w-full"
              onClick={() => setShowModelSelect(!showModelSelect)}
              disabled={modelsLoading}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
              <span className="truncate font-mono text-xs">{activeModel || "Select model"}</span>
              <ChevronDown className="ml-1.5 h-3 w-3 shrink-0 opacity-60" />
            </Button>

            {showModelSelect && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowModelSelect(false)} />
                <div className="absolute left-0 top-full z-20 mt-1 w-[min(100vw-2rem,20rem)] max-h-96 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
                  <div className="border-b border-[var(--border)] p-2">
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search models…"
                      className="h-8 text-xs"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-72 overflow-y-auto p-1">
                    {modelsLoading ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--primary)]" />
                      </div>
                    ) : Object.keys(filteredModelsByProvider).length === 0 ? (
                      <p className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
                        No models. Check accounts and pool.
                      </p>
                    ) : (
                      Object.entries(filteredModelsByProvider).map(([provider, mods]) => (
                        <div key={provider} className="mb-1">
                          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                            {provider}
                          </p>
                          {mods.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => handleModelChange(m.id)}
                              className={cn(
                                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                                m.id === activeModel
                                  ? "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)]"
                                  : "text-[var(--foreground)] hover:bg-[var(--secondary)]",
                              )}
                            >
                              <span className="truncate font-mono">{m.id}</span>
                              {m.id === activeModel && (
                                <Badge variant="outline" className="ml-2 shrink-0 text-[9px]">
                                  active
                                </Badge>
                              )}
                            </button>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          <Button
            variant={showSystemPrompt ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowSystemPrompt(!showSystemPrompt)}
            title="System prompt"
          >
            <Settings2 className="mr-1.5 h-3.5 w-3.5" />
            System
          </Button>
        </div>

        {showSystemPrompt && (
          <div className="border-b border-[var(--border)] bg-[var(--secondary)]/40 px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--foreground)]">System prompt</label>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
                    saveSystemPrompt(DEFAULT_SYSTEM_PROMPT);
                  }}
                >
                  Reset
                </Button>
                <Button size="sm" onClick={handleSystemPromptSave}>
                  Save
                </Button>
              </div>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              placeholder="Instructions for the model…"
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] p-2.5 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {active && active.messages.length === 0 && !streaming && (
            <div className="flex h-full flex-col items-center justify-center px-4 py-16 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))]">
                <Bot className="h-7 w-7 text-[var(--primary)]" />
              </div>
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Start a conversation</h2>
              <p className="mt-2 max-w-sm text-sm text-[var(--muted-foreground)]">
                Pick a pool model, then send a message. Completions go through Etteum and use account
                credits like any other client.
              </p>
              {activeModel && (
                <Badge variant="outline" className="mt-4 font-mono text-[10px]">
                  {activeModel}
                </Badge>
              )}
            </div>
          )}

          {active && (active.messages.length > 0 || streaming) && (
            <div className="mx-auto max-w-3xl space-y-4 px-3 py-6 sm:px-4">
              {active.messages.map((msg) => {
                const isUser = msg.role === "user";
                const isError =
                  !isUser &&
                  (msg.content.startsWith("Error:") || msg.content.startsWith("**Error**"));
                const displayContent = msg.content.replace(/^\*\*Error\*\*:\s*/i, "Error: ");
                return (
                  <div
                    key={msg.id}
                    className={cn("flex gap-2.5", isUser ? "flex-row-reverse" : "flex-row")}
                  >
                    <div
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                        isUser
                          ? "border-[var(--border)] bg-[var(--secondary)]"
                          : "border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))]",
                      )}
                    >
                      {isUser ? (
                        <User className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                      ) : (
                        <Bot className="h-3.5 w-3.5 text-[var(--primary)]" />
                      )}
                    </div>
                    <div className={cn("min-w-0 max-w-[min(100%,42rem)]", isUser && "text-right")}>
                      <div
                        className={cn(
                          "rounded-lg border px-3 py-2.5 text-left shadow-[var(--shadow-card)]",
                          isUser
                            ? "border-[var(--primary)]/35 bg-[color-mix(in_srgb,var(--primary)_14%,var(--card))] text-sm leading-relaxed text-[var(--foreground)] whitespace-pre-wrap"
                            : isError
                              ? "border-[var(--error)]/40 bg-[color-mix(in_srgb,var(--error)_10%,var(--card))] text-sm leading-relaxed text-[var(--error)] whitespace-pre-wrap"
                              : "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]",
                        )}
                      >
                        {!isUser && !isError && msg.thinking ? (
                          <ThinkingBlock content={msg.thinking} defaultOpen={false} />
                        ) : null}
                        {msg.media && msg.media.length > 0 && (
                          <div className={cn("mb-2 flex flex-col gap-2", isUser && "items-end")}>
                            {msg.media.map((med, i) => {
                              if (med.type === "image" && med.url) {
                                return (
                                  <a
                                    key={i}
                                    href={med.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block max-w-full overflow-hidden rounded-md border border-[var(--border)]"
                                  >
                                    <img
                                      src={med.url}
                                      alt={med.name || "attachment"}
                                      className="max-h-72 max-w-full object-contain"
                                      loading="lazy"
                                    />
                                  </a>
                                );
                              }
                              if (med.type === "video" && med.url) {
                                return (
                                  <video
                                    key={i}
                                    src={med.url}
                                    controls
                                    className="max-h-80 max-w-full rounded-md border border-[var(--border)]"
                                  />
                                );
                              }
                              if (med.type === "file") {
                                return (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--secondary)]/50 px-2 py-1 text-[11px] text-[var(--muted-foreground)]"
                                  >
                                    <FileText className="h-3 w-3" />
                                    {med.name || "file"}
                                  </span>
                                );
                              }
                              return null;
                            })}
                          </div>
                        )}
                        {isUser || isError ? (
                          displayContent
                        ) : (
                          <MarkdownContent content={displayContent} />
                        )}
                        {!isUser && msg.media && msg.media.some((m) => m.url && (m.type === "image" || m.type === "video")) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {msg.media
                              .filter((m) => m.url && (m.type === "image" || m.type === "video"))
                              .map((m, i) => (
                                <a
                                  key={`dl-${i}`}
                                  href={m.url}
                                  download
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-[10px] text-[var(--primary)] hover:underline"
                                >
                                  <Download className="h-3 w-3" />
                                  Open {m.type}
                                </a>
                              ))}
                          </div>
                        )}
                      </div>
                      <div
                        className={cn(
                          "mt-1 flex flex-wrap items-center gap-2 px-0.5 text-[10px] text-[var(--muted-foreground)]",
                          isUser && "justify-end",
                        )}
                      >
                        {msg.model && !isUser && (
                          <Badge variant="outline" className="h-5 font-mono text-[9px]">
                            {msg.model}
                          </Badge>
                        )}
                        {msg.thinking && !isUser && (
                          <Badge variant="outline" className="h-5 text-[9px]">
                            thinking
                          </Badge>
                        )}
                        {msg.timestamp ? <span>{formatMsgTime(msg.timestamp)}</span> : null}
                      </div>
                    </div>
                  </div>
                );
              })}

              {streaming && (
                <div className="flex gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))]">
                    <Bot className="h-3.5 w-3.5 text-[var(--primary)]" />
                  </div>
                  <div className="min-w-0 max-w-[min(100%,42rem)] rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 shadow-[var(--shadow-card)]">
                    {streamingThinking ? (
                      <ThinkingBlock
                        content={streamingThinking}
                        streaming={!streamingText}
                        defaultOpen
                      />
                    ) : null}
                    {streamingText ? (
                      <div className="relative">
                        <MarkdownContent content={streamingText} />
                        <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--primary)]/60 align-middle" />
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />
                        {streamingThinking ? "Writing reply…" : "Generating…"}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-[var(--border)] bg-[var(--card)] px-3 py-3 sm:px-4">
          <div className="mx-auto max-w-3xl">
            {genKind && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--primary)]/25 bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--foreground)]">
                {genKind === "video" ? (
                  <Video className="h-3.5 w-3.5 text-[var(--primary)]" />
                ) : (
                  <Wand2 className="h-3.5 w-3.5 text-[var(--primary)]" />
                )}
                <span>
                  This model generates <strong>{genKind}</strong>. Your message is used as the prompt;
                  results appear in the thread.
                </span>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group relative flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 px-2 py-1.5"
                  >
                    {a.kind === "image" && a.dataUrl ? (
                      <img src={a.dataUrl} alt="" className="h-10 w-10 rounded object-cover" />
                    ) : (
                      <FileText className="h-4 w-4 text-[var(--muted-foreground)]" />
                    )}
                    <span className="max-w-[8rem] truncate text-[11px] text-[var(--foreground)]">
                      {a.name}
                    </span>
                    <button
                      type="button"
                      className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--error)]"
                      onClick={() => removeAttachment(a.id)}
                      aria-label="Remove attachment"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachError && (
              <p className="mb-2 text-[11px] text-[var(--error)]">{attachError}</p>
            )}
            <div
              className={cn(
                "flex items-end gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-2",
                "focus-within:border-[var(--primary)]/40 focus-within:shadow-[var(--glow)]",
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.rs,.go,.html,.css,.xml,.yml,.yaml"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                disabled={streaming || !active || !!genKind}
                title={genKind ? "Attachments not used for generation models" : "Attach images or text files"}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                disabled={streaming || !active || !!genKind}
                title="Attach image"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.accept = "image/*";
                    fileInputRef.current.click();
                    // restore broad accept after open
                    setTimeout(() => {
                      if (fileInputRef.current) {
                        fileInputRef.current.accept =
                          "image/*,.txt,.md,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.rs,.go,.html,.css,.xml,.yml,.yaml";
                      }
                    }, 500);
                  }
                }}
              >
                <ImageIcon className="h-4 w-4" />
              </Button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  streaming
                    ? "Waiting for response…"
                    : genKind
                      ? `Describe the ${genKind} to generate…`
                      : "Message… (paste or attach images/files)"
                }
                disabled={streaming || !active}
                rows={1}
                className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none disabled:opacity-60"
              />
              {streaming ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0 border-[var(--error)]/40 text-[var(--error)]"
                  onClick={handleStop}
                  title="Stop"
                >
                  <StopCircle className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="shrink-0"
                  onClick={() => void handleSend()}
                  disabled={(!input.trim() && attachments.length === 0) || !active || !activeModel}
                  title={genKind ? `Generate ${genKind}` : "Send"}
                >
                  {genKind ? <Wand2 className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                </Button>
              )}
            </div>
            <p className="mt-2 text-center text-[10px] text-[var(--muted-foreground)]">
              Proxied via Etteum · Enter to send · Shift+Enter newline · Paste images · Vision models see attachments
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
