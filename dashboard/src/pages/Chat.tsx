import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Plus,
  Trash2,
  Settings2,
  Sparkles,
  Loader2,
  ChevronDown,
  StopCircle,
  PanelLeft,
  MessageSquare,
  X,
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
import { getApiKey, API_BASE, generateImage, fetchModelsCatalog, fetchApiKey } from "@/lib/api";
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
    l === "grok-image" ||
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
  const patterns = [
    /<think>([\s\S]*?)<\/think>/gi,
    /<thinking>([\s\S]*?)<\/thinking>/gi,
    // Some Cosy/thinking models leak a "Thinking Process:" prose block into content.
    /(?:^|\n)\s*Thinking Process:\s*([\s\S]*?)(?=\n\s*(?:Hi |Hello |Hey |Sure |OK |Okay |I |Here |The |$))/i,
  ];
  for (const re of patterns) {
    content = content.replace(re, (_m, body: string) => {
      const t = String(body || "").trim();
      if (t) thinking = thinking ? `${thinking}\n\n${t}` : t;
      return "";
    });
  }
  // If the whole message is a Thinking Process dump with no separate answer.
  if (!content.trim() && /^Thinking Process:/i.test(text.trim())) {
    thinking = text.replace(/^Thinking Process:\s*/i, "").trim();
    content = "";
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
  /** Catalog flag: model supports a reasoning/thinking mode. */
  thinking?: boolean;
  /** Reasoning-effort levels the model accepts, ascending (from the catalog). */
  effortLevels?: string[];
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

/**
 * Ensure the browser has the pool/install API key for /v1 chat.
 * Clean installs often have no localStorage key — dashboard session alone
 * cannot authenticate /v1/* (Bearer required).
 */
async function ensurePoolApiKey(): Promise<string> {
  const existing = getApiKey();
  if (existing) return existing;
  try {
    const res = (await fetchApiKey()) as { key?: string };
    if (res?.key) {
      localStorage.setItem("api_key", res.key);
      return res.key;
    }
  } catch {
    /* not logged in or API error */
  }
  return "";
}

function mapModelRows(rows: Array<{ id?: string; owned_by?: string; thinking?: boolean; effort_levels?: string[] } | string>): ProviderModel[] {
  return rows
    .map((m) => {
      const id = typeof m === "string" ? m : String(m.id || "");
      if (!id) return null;
      // Prefer the catalog's owned_by (e.g. "commandcode") when present;
      // otherwise derive from the id prefix (legacy path).
      const ownedBy = typeof m === "object" && typeof m.owned_by === "string" ? m.owned_by : "";
      let thinking = typeof m === "object" && typeof m.thinking === "boolean" ? m.thinking : undefined;
      // Grok 4.x always reasons (xAI: cannot disable). Catalog/live lists sometimes
      // omit `thinking: true` — still enable the effort selector + reasoning_effort.
      if (thinking !== true && (ownedBy === "grok" || /^grok-4/i.test(id) || /composer-2\.5/i.test(id))) {
        thinking = true;
      }
      const effortLevels =
        typeof m === "object" && Array.isArray(m.effort_levels) && m.effort_levels.length > 0
          ? m.effort_levels.filter((x): x is string => typeof x === "string")
          : thinking
            ? ["low", "medium", "high"]
            : undefined;
      const prefix = ownedBy
        ? ownedBy
        : id.includes("-")
          ? id.split("-")[0]!
          : "";
      const model: ProviderModel = { id, provider: providerFromPrefix(prefix), label: id, thinking, effortLevels };
      return model;
    })
    .filter((m): m is ProviderModel => m != null);
}

/**
 * Admin chat model list: use /api/models/all (dashboard session, full catalog).
 * Never use a managed/friend key's filtered /v1/models list here.
 */
async function fetchModels(): Promise<ProviderModel[]> {
  // 1) Preferred: dashboard-auth catalog (works on clean install after login).
  try {
    const catalog = await fetchModelsCatalog();
    const list = mapModelRows((catalog.data || []) as Array<{ id?: string }>);
    if (list.length > 0) return list;
  } catch {
    /* fall through */
  }
  // 2) Fallback: OpenAI-compatible surface with pool API key.
  try {
    const key = await ensurePoolApiKey();
    const res = await fetch(`${API_BASE}/v1/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      credentials: "include",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return mapModelRows(data.data || []);
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
    commandcode: "Command Code",
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
  reasoningEffort?: string,
): Promise<{ success: boolean; error?: string; content?: string; thinking?: string }> {
  try {
    const key = (await ensurePoolApiKey()) || getApiKey();
    if (!key) {
      return {
        success: false,
        error: "No pool API key in browser. Open API Key page once, or re-login.",
      };
    }
    const res = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      // reasoning_effort is the signal providers (e.g. Alibaba) use to enable
      // thinking; omitting it lets the provider default to thinking off.
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
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
      // Prefer blank-line SSE framing; fall back to line-by-line if needed.
      let events: string[];
      if (buffer.includes("\n\n")) {
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        events = parts;
      } else {
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        events = lines;
      }

      for (const part of events) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data:") );
        if (!dataLine) continue;

        const payload = dataLine.replace(/^data:\s?/, "").trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};
          const message = choice?.message ?? {};

          const contentPiece =
            deltaTextPiece(delta.content) ||
            deltaTextPiece(delta.text) ||
            (typeof message.content === "string" ? message.content : "") ||
            deltaTextPiece(message.content);

          const thinkingPiece =
            deltaTextPiece(delta.reasoning_content) ||
            deltaTextPiece(delta.thinking) ||
            deltaTextPiece(delta.reasoning) ||
            deltaTextPiece(message.reasoning_content) ||
            deltaTextPiece(message.thinking);

          let changed = false;
          // If provider wrongly puts the same text in content and reasoning,
          // only count it once as thinking (avoid duplicate body + Thinking panel).
          if (contentPiece && thinkingPiece && contentPiece === thinkingPiece) {
            fullThinking += thinkingPiece;
            changed = true;
          } else {
            if (contentPiece) {
              fullText += contentPiece;
              changed = true;
            }
            if (thinkingPiece) {
              fullThinking += thinkingPiece;
              changed = true;
            }
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
  // Reasoning effort for thinking-capable models. "off" = don't request thinking.
  const [effort, setEffort] = useState<string>("medium");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  /** When true, stream/output keeps the message list pinned to the bottom. */
  const stickMessagesToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = conversations.find((c) => c.id === activeId) || null;
  const genKind = mediaGenKind(active?.model || models[0]?.id || "");

  useEffect(() => {
    void (async () => {
      // Warm pool key for /v1 chat so clean installs don't fail silently.
      await ensurePoolApiKey();
      const m = await fetchModels();
      setModels(m);
      setModelsLoading(false);
    })();
  }, []);

  /** Pin message list to bottom without scrolling the whole page (instant while streaming). */
  const scrollMessagesToBottom = useCallback((force = false) => {
    const el = messagesScrollRef.current;
    if (!el) return;
    if (!force && !stickMessagesToBottomRef.current) return;
    // Direct scrollTop is reliable during rapid token updates; smooth fights the stream.
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollMessagesToBottom();
  }, [active?.messages, streamingText, streamingThinking, streaming, scrollMessagesToBottom]);

  // New conversation / switch: always show latest.
  useEffect(() => {
    stickMessagesToBottomRef.current = true;
    scrollMessagesToBottom(true);
  }, [activeId, scrollMessagesToBottom]);

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
  const activeModelInfo = models.find((m) => m.id === activeModel);
  // Catalog says this model supports a reasoning/thinking mode.
  const thinkingCapable = activeModelInfo?.thinking === true;
  // Levels this model actually accepts (e.g. Kimi K3: low/high/max). Fall back to
  // a generic ladder when the catalog doesn't declare tiers.
  const effortLevels = activeModelInfo?.effortLevels?.length
    ? activeModelInfo.effortLevels
    : ["low", "medium", "high"];
  // Keep the selected effort valid for the current model's ladder.
  const validEffort = effortLevels.includes(effort) ? effort : effortLevels[effortLevels.length - 1]!;

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
    stickMessagesToBottomRef.current = true;
    // Next frame so the user bubble is in the DOM before we pin to bottom.
    requestAnimationFrame(() => scrollMessagesToBottom(true));

    // ── Image / video generation models (Canva Magic Media etc.) ───────────
    const gen = mediaGenKind(model);
    if (gen) {
      try {
        setStreamingText(gen === "video" ? "Generating video…" : "Generating image…");
        const res = await generateImage({
          prompt: userText,
          type: gen,
          // Pass selected model so media routing uses Canva (or other gen models).
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
      // Only send an effort when the model supports thinking; clamp to the
      // model's ladder so an out-of-range value is never sent.
      thinkingCapable && effort !== "off" ? validEffort : undefined,
    );

    abortRef.current = null;

    if (result.success) {
      const finalContent = (result.content ?? latestText) || "";
      const finalThinking = (result.thinking ?? latestThinking) || undefined;
      // Some Grok/reasoning streams fill reasoning only — still show something useful.
      // Prefer keeping reasoning in the Thinking panel when both exist; if the
      // stream had only reasoning, surface it as content too so the bubble is not empty.
      const hasContent = Boolean(finalContent.trim());
      const hasThinking = Boolean(finalThinking?.trim());
      const displayContent = hasContent
        ? finalContent
        : hasThinking
          ? finalThinking!
          : "(empty response)";
      const media = extractMediaUrlsFromText(displayContent);
      updateConversation(conv.id, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            role: "assistant",
            content: displayContent,
            // Always persist thinking when we got a separate reasoning stream —
            // including the reasoning-only case (still show ThinkingBlock).
            ...(hasThinking ? { thinking: finalThinking } : {}),
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

  const isEmptyThread = !active || (active.messages.length === 0 && !streaming);

  const modelPicker = (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setShowModelSelect((v) => !v)}
        disabled={modelsLoading || !active}
        className="inline-flex h-8 max-w-[11rem] items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--background)] px-2.5 text-[11px] text-[var(--foreground)] transition-colors hover:border-[var(--primary)]/40 disabled:opacity-50"
        title={activeModel || "Select model"}
      >
        <Sparkles className="h-3 w-3 shrink-0 text-[var(--primary)]" />
        <span className="truncate font-mono">{activeModel || "model"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {showModelSelect && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowModelSelect(false)} />
          <div className="absolute bottom-full right-0 z-50 mb-2 w-[min(100vw-2rem,18rem)] max-h-80 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
            <div className="border-b border-[var(--border)] p-2">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models…"
                className="h-8 text-xs"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {modelsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--primary)]" />
                </div>
              ) : Object.keys(filteredModelsByProvider).length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
                  No models. Confirm you are logged in, then refresh.
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
  );

  const composerInner = (
    <>
      {genKind && (
        <div className="mb-2 flex items-center gap-2 rounded-full border border-[var(--primary)]/25 bg-[color-mix(in_srgb,var(--primary)_8%,var(--card))] px-3 py-1.5 text-[11px] text-[var(--foreground)]">
          {genKind === "video" ? (
            <Video className="h-3.5 w-3.5 text-[var(--primary)]" />
          ) : (
            <Wand2 className="h-3.5 w-3.5 text-[var(--primary)]" />
          )}
          <span>
            This model generates <strong>{genKind}</strong> — message is the prompt.
          </span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="group relative flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--secondary)]/40 px-2 py-1.5"
            >
              {a.kind === "image" && a.dataUrl ? (
                <img src={a.dataUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
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
      {attachError && <p className="mb-2 text-[11px] text-[var(--error)]">{attachError}</p>}
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-[1.75rem] border border-[var(--border)] bg-[var(--card)]/95 p-1.5 shadow-[var(--shadow-card)] backdrop-blur-xl",
          "focus-within:border-[var(--primary)]/40 focus-within:shadow-[var(--glow)]",
          "supports-[backdrop-filter]:bg-[var(--card)]/88",
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
        <button
          type="button"
          disabled={streaming || !active || !!genKind}
          title={genKind ? "Attachments not used for generation models" : "Attach files"}
          onClick={() => fileInputRef.current?.click()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
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
                : isEmptyThread
                  ? "What do you want to know?"
                  : "Ask anything"
          }
          disabled={streaming || !active}
          rows={1}
          className="max-h-36 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm leading-5 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none disabled:opacity-60"
        />
        {modelPicker}
        {thinkingCapable && (
          <div
            className="flex shrink-0 items-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--background)] text-[10px]"
            title={`Reasoning effort — ${activeModelInfo?.effortLevels?.length ? "levels this model supports" : "generic"}`}
          >
            <button
              type="button"
              onClick={() => setEffort("off")}
              disabled={streaming}
              className={cn(
                "px-2 py-1 transition-colors disabled:opacity-50",
                effort === "off"
                  ? "bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-[var(--primary)]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              )}
            >
              No think
            </button>
            {effortLevels.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setEffort(level)}
                disabled={streaming}
                className={cn(
                  "px-2 py-1 capitalize transition-colors disabled:opacity-50",
                  validEffort === level && effort !== "off"
                    ? "bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-[var(--primary)]"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                {level}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={streaming || !active || !!genKind}
          title="Attach image"
          onClick={() => {
            if (fileInputRef.current) {
              fileInputRef.current.accept = "image/*";
              fileInputRef.current.click();
              setTimeout(() => {
                if (fileInputRef.current) {
                  fileInputRef.current.accept =
                    "image/*,.txt,.md,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.rs,.go,.html,.css,.xml,.yml,.yaml";
                }
              }, 500);
            }
          }}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40 sm:flex"
        >
          <ImageIcon className="h-4 w-4" />
        </button>
        {streaming ? (
          <button
            type="button"
            onClick={handleStop}
            title="Stop"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--error)]/40 bg-[var(--error)]/10 text-[var(--error)]"
          >
            <StopCircle className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={(!input.trim() && attachments.length === 0) || !active || !activeModel}
            title={genKind ? `Generate ${genKind}` : "Send"}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {genKind ? <Wand2 className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </button>
        )}
      </div>
    </>
  );

  const historyPanel = (
    <div
      className={cn(
        "flex w-[15.5rem] shrink-0 flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]",
        "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[min(100%,16rem)] max-md:shadow-[var(--shadow-card)]",
      )}
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--primary)]/30 bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))]">
            <Sparkles className="h-3.5 w-3.5 text-[var(--primary)]" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-[var(--foreground)]">Chat</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 md:hidden"
          onClick={() => setShowHistory(false)}
          aria-label="Close history"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1 px-2 pb-2">
        <button
          type="button"
          onClick={handleNewChat}
          className="flex w-full items-center gap-2 rounded-xl border border-transparent bg-[var(--secondary)]/70 px-3 py-2 text-left text-sm text-[var(--foreground)] transition-colors hover:border-[var(--border)] hover:bg-[var(--secondary)]"
        >
          <MessageSquare className="h-4 w-4 text-[var(--primary)]" />
          New Chat
        </button>
        <button
          type="button"
          onClick={() => setShowSystemPrompt((v) => !v)}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors",
            showSystemPrompt
              ? "bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/60 hover:text-[var(--foreground)]",
          )}
        >
          <Settings2 className="h-4 w-4" />
          System prompt
        </button>
      </div>

      <div className="px-3 pb-1.5 pt-1">
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
              "group flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors",
              conv.id === activeId
                ? "bg-[var(--secondary)] text-[var(--foreground)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/50 hover:text-[var(--foreground)]",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-[var(--foreground)]">{conv.title}</p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted-foreground)]">
                {conv.model}
              </p>
            </div>
            <button
              type="button"
              className="rounded-md p-1 opacity-0 transition-opacity hover:bg-[var(--background)] group-hover:opacity-100"
              onClick={(e) => handleDeleteConversation(conv.id, e)}
              aria-label="Delete conversation"
            >
              <Trash2 className="h-3 w-3 text-[var(--error)]" />
            </button>
          </div>
        ))}
        {conversations.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-8 text-center">
            <p className="text-xs text-[var(--muted-foreground)]">No conversations yet</p>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative -mx-4 -mb-4 flex h-[calc(100vh-5rem)] min-h-[28rem] overflow-hidden bg-[var(--background)] md:-mx-6 md:-mb-6 md:h-[calc(100vh-3rem)]">
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
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Compact top bar */}
        <div className="flex items-center gap-2 px-3 py-2.5 md:px-4">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            title="Toggle history"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleNewChat}
            className="flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 text-xs text-[var(--foreground)] transition-colors hover:border-[var(--primary)]/40"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
          {!isEmptyThread && active && (
            <p className="ml-1 min-w-0 flex-1 truncate text-xs text-[var(--muted-foreground)]">
              {active.title}
            </p>
          )}
        </div>

        {showSystemPrompt && (
          <div className="mx-3 mb-2 rounded-2xl border border-[var(--border)] bg-[var(--card)] px-3 py-3 md:mx-4">
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
              className="w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--background)] p-2.5 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
          </div>
        )}

        {/* Messages / empty state */}
        <div
          ref={messagesScrollRef}
          className={cn("flex-1 overflow-y-auto", isEmptyThread && "flex flex-col")}
          onScroll={() => {
            const el = messagesScrollRef.current;
            if (!el) return;
            const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
            stickMessagesToBottomRef.current = dist < 80;
          }}
        >
          {isEmptyThread && (
            <div className="flex flex-1 flex-col items-center justify-center px-4 pb-28 pt-8 text-center">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--primary)]/35 bg-[color-mix(in_srgb,var(--primary)_14%,var(--card))] shadow-[var(--glow)]">
                  <Sparkles className="h-5 w-5 text-[var(--primary)]" />
                </div>
                <h1 className="text-3xl font-semibold tracking-tight text-[var(--foreground)] sm:text-4xl">
                  Etteum
                </h1>
              </div>
              <p className="mb-8 max-w-md text-sm text-[var(--muted-foreground)]">
                Chat through your proxy pool. Pick a model, ask anything — streaming, vision, and
                image models all work here.
              </p>
              <div className="w-full max-w-2xl">{composerInner}</div>
            </div>
          )}

          {!isEmptyThread && active && (
            <div className="mx-auto w-full max-w-3xl space-y-5 px-3 pb-36 pt-4 sm:px-6">
              {active.messages.map((msg) => {
                const isUser = msg.role === "user";
                const isError =
                  !isUser &&
                  (msg.content.startsWith("Error:") || msg.content.startsWith("**Error**"));
                const displayContent = msg.content.replace(/^\*\*Error\*\*:\s*/i, "Error: ");
                return (
                  <div
                    key={msg.id}
                    className={cn(
                      "flex w-full",
                      isUser ? "justify-end" : "justify-start",
                    )}
                  >
                    <div
                      className={cn(
                        "min-w-0",
                        isUser ? "max-w-[min(100%,28rem)]" : "w-full max-w-[min(100%,42rem)]",
                      )}
                    >
                      {!isUser && !isError && msg.thinking ? (
                        <div className="mb-2">
                          <ThinkingBlock content={msg.thinking} defaultOpen={false} />
                        </div>
                      ) : null}

                      {isUser ? (
                        <div className="rounded-2xl rounded-br-md bg-[var(--secondary)] px-3.5 py-2 text-left text-sm leading-relaxed text-[var(--foreground)] whitespace-pre-wrap">
                          {msg.media && msg.media.length > 0 && (
                            <div className="mb-2 flex flex-col items-end gap-2">
                              {msg.media.map((med, i) => {
                                if (med.type === "image" && med.url) {
                                  return (
                                    <a
                                      key={i}
                                      href={med.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block max-w-full overflow-hidden rounded-xl"
                                    >
                                      <img
                                        src={med.url}
                                        alt={med.name || "attachment"}
                                        className="max-h-56 max-w-full object-contain"
                                        loading="lazy"
                                      />
                                    </a>
                                  );
                                }
                                if (med.type === "file") {
                                  return (
                                    <span
                                      key={i}
                                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--background)]/50 px-2 py-1 text-[11px] text-[var(--muted-foreground)]"
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
                          {displayContent}
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "text-left text-sm leading-relaxed",
                            isError
                              ? "rounded-2xl border border-[var(--error)]/40 bg-[color-mix(in_srgb,var(--error)_10%,var(--card))] px-3.5 py-2.5 text-[var(--error)] whitespace-pre-wrap"
                              : "text-[var(--foreground)]",
                          )}
                        >
                          {msg.media && msg.media.length > 0 && (
                            <div className="mb-3 flex flex-col gap-2">
                              {msg.media.map((med, i) => {
                                if (med.type === "image" && med.url) {
                                  return (
                                    <a
                                      key={i}
                                      href={med.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block max-w-full overflow-hidden rounded-xl border border-[var(--border)]"
                                    >
                                      <img
                                        src={med.url}
                                        alt={med.name || "attachment"}
                                        className="max-h-80 max-w-full object-contain"
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
                                      className="max-h-80 max-w-full rounded-xl border border-[var(--border)]"
                                    />
                                  );
                                }
                                if (med.type === "file") {
                                  return (
                                    <span
                                      key={i}
                                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--secondary)]/50 px-2 py-1 text-[11px] text-[var(--muted-foreground)]"
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
                          {isError ? displayContent : <MarkdownContent content={displayContent} />}
                          {!isError &&
                            msg.media &&
                            msg.media.some(
                              (m) => m.url && (m.type === "image" || m.type === "video"),
                            ) && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {msg.media
                                  .filter(
                                    (m) => m.url && (m.type === "image" || m.type === "video"),
                                  )
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
                      )}

                      <div
                        className={cn(
                          "mt-1.5 flex flex-wrap items-center gap-2 px-0.5 text-[10px] text-[var(--muted-foreground)]",
                          isUser && "justify-end",
                        )}
                      >
                        {msg.model && !isUser && (
                          <span className="font-mono text-[9px] opacity-70">{msg.model}</span>
                        )}
                        {msg.timestamp ? <span>{formatMsgTime(msg.timestamp)}</span> : null}
                      </div>
                    </div>
                  </div>
                );
              })}

              {streaming && (
                <div className="flex w-full justify-start">
                  <div className="w-full max-w-[min(100%,42rem)] text-sm leading-relaxed text-[var(--foreground)]">
                    {streamingThinking ? (
                      <div className="mb-2">
                        <ThinkingBlock
                          content={streamingThinking}
                          streaming={streaming}
                          defaultOpen
                        />
                      </div>
                    ) : null}
                    {streamingText ? (
                      <div className="relative">
                        <MarkdownContent content={streamingText} />
                        <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--primary)]/60 align-middle" />
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />
                        {streamingThinking ? "Writing reply…" : "Thinking…"}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Floating composer — only when thread has messages (empty state embeds it) */}
        {!isEmptyThread && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3 pb-4 sm:px-6 sm:pb-5">
            <div className="pointer-events-auto mx-auto w-full max-w-3xl">{composerInner}</div>
          </div>
        )}
      </div>
    </div>
  );
}
