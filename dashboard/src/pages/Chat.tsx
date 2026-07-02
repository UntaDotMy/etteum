import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Plus, Trash2, Settings2, Sparkles, Loader2, Bot, User, ChevronDown, ChevronUp, StopCircle, Menu, X } from "lucide-react";
import { getApiKey, API_BASE } from "../lib/api";

// ── Types ──────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  id: string;
  model?: string;
  timestamp?: number;
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

// ── Constants ───────────────────────────────────────────────────────

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

// ── Storage Helpers ─────────────────────────────────────────────────

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveConversations(convs: Conversation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(convs));
  } catch { /* quota exceeded, ignore */ }
}

function loadSystemPrompt(): string {
  return localStorage.getItem(SYSTEM_PROMPT_KEY) || DEFAULT_SYSTEM_PROMPT;
}

function saveSystemPrompt(p: string) {
  localStorage.setItem(SYSTEM_PROMPT_KEY, p);
}

// ── Provider / Model resolver ───────────────────────────────────────

async function fetchModels(): Promise<ProviderModel[]> {
  try {
    const res = await fetch(`${API_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    const models: ProviderModel[] = (data.data || []).map((m: any) => {
      const id = m.id as string;
      // Extract provider from prefix (e.g., "ali-qwen-plus" → "alibaba")
      const prefix = id.includes("-") ? id.split("-")[0]! : "";
      const provider = providerFromPrefix(prefix);
      return { id, provider, label: id };
    });
    return models;
  } catch { return []; }
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
  return map[prefix] || prefix;
}

// ── Streaming Chat ──────────────────────────────────────────────────

async function streamChat(
  messages: { role: string; content: string }[],
  model: string,
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = text ? JSON.parse(text) : {};
      return { success: false, error: err.error?.message || err.error || `HTTP ${res.status}` };
    }

    if (!res.body) {
      return { success: false, error: "No response body" };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

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
          const content = chunk.choices?.[0]?.delta?.content || "";
          if (content) {
            fullText += content;
            onChunk(fullText);
          }
        } catch { /* skip malformed */ }
      }
    }

    return { success: true };
  } catch (err: any) {
    if (err.name === "AbortError") return { success: false, error: "Cancelled" };
    return { success: false, error: err.message || "Network error" };
  }
}

// ── Component ───────────────────────────────────────────────────────

export default function Chat() {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(() => loadSystemPrompt());
  const [searchQuery, setSearchQuery] = useState("");
  const [showHistory, setShowHistory] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = conversations.find((c) => c.id === activeId) || null;

  // Load models on mount
  useEffect(() => {
    fetchModels().then((m) => {
      setModels(m);
      setModelsLoading(false);
    });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages, streamingText]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  // When models load, auto-select if no active conversation
  useEffect(() => {
    if (models.length > 0 && !activeId) {
      const conv = createNewConversation(models[0]!.id);
      setConversations([conv]);
      setActiveId(conv.id);
    }
  }, [models, activeId]);

  const activeModel = active?.model || models[0]?.id || "";

  function getConversation(id: string): Conversation | undefined {
    return conversations.find((c) => c.id === id);
  }

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
    setStreamingText("");
  }

  function handleDeleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConversations(next);
      return next;
    });
    if (activeId === id) {
      setActiveId(null);
    }
  }

  function handleSelectConversation(id: string) {
    setActiveId(id);
    setShowHistory(false);
    setStreamingText("");
    setInput("");
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
    if (!text || streaming || !active) return;

    // Get the latest copy of active conversation
    const conv = getConversation(active.id);
    if (!conv) return;

    // Create user message
    const userMsg: Message = {
      role: "user",
      content: text,
      id: generateId(),
      timestamp: Date.now(),
    };

    // Add user message
    updateConversation(conv.id, (c) => ({
      ...c,
      messages: [...c.messages, userMsg],
      updatedAt: Date.now(),
      // Auto-title: use first few words of first user message
      title: c.messages.length === 0 ? text.slice(0, 40) + (text.length > 40 ? "…" : "") : c.title,
    }));

    setInput("");
    setStreaming(true);
    setStreamingText("");

    // Use a mutable variable to track the latest stream text
    let latestText = "";

    // Build messages array for API
    const updatedConv = getConversation(conv.id);
    if (!updatedConv) { setStreaming(false); return; }

    const apiMessages: { role: string; content: string }[] = [];
    if (systemPrompt.trim()) {
      apiMessages.push({ role: "system", content: systemPrompt.trim() });
    }
    for (const m of updatedConv.messages) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const abort = new AbortController();
    abortRef.current = abort;

    const result = await streamChat(
      apiMessages,
      updatedConv.model,
      (text) => { setStreamingText(text); latestText = text; },
      abort.signal,
    );

    abortRef.current = null;

    if (result.success) {
      // Save the response — use latestText directly (React state may be stale)
      const content = latestText || "(empty response)";
      const assistantMsg: Message = {
        role: "assistant",
        content,
        id: generateId(),
        model: updatedConv.model,
        timestamp: Date.now(),
      };

      updateConversation(conv.id, (c) => ({
        ...c,
        messages: [...c.messages, assistantMsg],
        updatedAt: Date.now(),
      }));
      setStreamingText("");
    } else if (result.error && result.error !== "Cancelled") {
      // Show error as assistant message
      const errorMsg: Message = {
        role: "assistant",
        content: `**Error**: ${result.error}`,
        id: generateId(),
        timestamp: Date.now(),
      };
      updateConversation(conv.id, (c) => ({
        ...c,
        messages: [...c.messages, errorMsg],
        updatedAt: Date.now(),
      }));
      setStreamingText("");
    }

    setStreaming(false);
    setStreamingText("");
  }

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Group models by provider for the selector
  const modelsByProvider: Record<string, ProviderModel[]> = {};
  for (const m of models) {
    if (!modelsByProvider[m.provider]) modelsByProvider[m.provider] = [];
    modelsByProvider[m.provider].push(m);
  }

  const filteredModels = searchQuery.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(searchQuery.toLowerCase()))
    : models;

  const filteredModelsByProvider: Record<string, ProviderModel[]> = {};
  for (const m of filteredModels) {
    if (!filteredModelsByProvider[m.provider]) filteredModelsByProvider[m.provider] = [];
    filteredModelsByProvider[m.provider].push(m);
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-0 relative">
      {/* History sidebar */}
      {showHistory && (
        <>
          <div className="w-72 border-r border-[var(--border)] bg-[var(--card)] flex flex-col shrink-0 max-md:fixed max-md:inset-0 max-md:z-50 max-md:w-full">
            {/* History header */}
            <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
              <h2 className="text-sm font-semibold text-[var(--foreground)]">Chat History</h2>
              <button
                onClick={() => setShowHistory(false)}
                className="p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] md:hidden"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* New chat button */}
            <div className="p-2">
              <button
                onClick={handleNewChat}
                className="w-full flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] hover:bg-[var(--secondary)] px-3 py-2 text-sm text-[var(--foreground)] transition-colors"
              >
                <Plus className="w-4 h-4" />
                New chat
              </button>
            </div>

            {/* Conversation list */}
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => handleSelectConversation(conv.id)}
                  className={`w-full flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors group ${
                    conv.id === activeId
                      ? "bg-[var(--primary)]/10 text-[var(--primary)]"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                  }`}
                >
                  <Bot className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 truncate">{conv.title}</span>
                  <button
                    onClick={(e) => handleDeleteConversation(conv.id, e)}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </button>
              ))}
              {conversations.length === 0 && (
                <p className="text-xs text-[var(--muted-foreground)] text-center py-8">
                  No conversations yet
                </p>
              )}
            </div>
          </div>
          {/* Overlay on mobile */}
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={() => setShowHistory(false)}
          />
        </>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--card)] shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHistory(true)}
              className="p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] md:hidden"
            >
              <Menu className="w-4 h-4" />
            </button>
            <button
              onClick={handleNewChat}
              className="p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
              title="New chat"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {/* Model selector */}
          <div className="relative">
            <button
              onClick={() => setShowModelSelect(!showModelSelect)}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium bg-[var(--secondary)] hover:bg-[var(--secondary)]/80 text-[var(--foreground)] transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-[var(--primary)]" />
              {activeModel}
              <ChevronDown className="w-3 h-3 text-[var(--muted-foreground)]" />
            </button>

            {showModelSelect && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowModelSelect(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 w-80 max-h-96 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl">
                  {/* Search */}
                  <div className="p-2 border-b border-[var(--border)]">
                    <input
                      type="text"
                      placeholder="Search models..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                      autoFocus
                    />
                  </div>
                  {modelsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-[var(--muted-foreground)]" />
                    </div>
                  ) : searchQuery.trim() ? (
                    <div className="p-1">
                      {filteredModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => handleModelChange(m.id)}
                          className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                            m.id === activeModel
                              ? "bg-[var(--primary)]/10 text-[var(--primary)]"
                              : "text-[var(--foreground)] hover:bg-[var(--secondary)]"
                          }`}
                        >
                          <span className="font-medium">{m.id}</span>
                          <span className="ml-2 text-[var(--muted-foreground)]">({m.provider})</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    Object.entries(filteredModelsByProvider).map(([provider, mods]) => (
                      <div key={provider} className="p-1">
                        <h3 className="px-3 py-1 text-[10px] font-semibold text-[var(--muted-foreground)] uppercase tracking-wider">
                          {provider}
                        </h3>
                        {mods.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => handleModelChange(m.id)}
                            className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                              m.id === activeModel
                                ? "bg-[var(--primary)]/10 text-[var(--primary)]"
                                : "text-[var(--foreground)] hover:bg-[var(--secondary)]"
                            }`}
                          >
                            {m.id}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* System prompt toggle */}
          <button
            onClick={() => setShowSystemPrompt(!showSystemPrompt)}
            className="p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
            title="System prompt"
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </div>

        {/* System prompt editor */}
        {showSystemPrompt && (
          <div className="border-b border-[var(--border)] bg-[var(--secondary)]/30 p-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-[var(--foreground)]">System Prompt</label>
              <div className="flex gap-2">
                <button
                  onClick={() => { setSystemPrompt(""); saveSystemPrompt(""); setShowSystemPrompt(false); }}
                  className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Reset
                </button>
                <button
                  onClick={handleSystemPromptSave}
                  className="text-xs font-medium text-[var(--primary)] hover:text-[var(--primary)]/80"
                >
                  Save
                </button>
              </div>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
              rows={3}
              placeholder="Enter system prompt..."
            />
          </div>
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto">
          {active && active.messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center h-full px-4 text-center">
              <Bot className="w-12 h-12 text-[var(--muted-foreground)] mb-4 opacity-50" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">
                {active.title === "New chat" ? "Start a conversation" : active.title}
              </h2>
              <p className="text-sm text-[var(--muted-foreground)] max-w-md">
                Select a model above and start typing. I can help with code, writing, analysis, and more.
              </p>
            </div>
          )}

          {active && active.messages.length > 0 && (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
              {active.messages.map((msg) => (
                <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
                  {msg.role === "assistant" && (
                    <div className="w-8 h-8 rounded-full bg-[var(--primary)]/10 flex items-center justify-center shrink-0">
                      <Bot className="w-4 h-4 text-[var(--primary)]" />
                    </div>
                  )}
                  <div className={`max-w-[80%] ${msg.role === "user" ? "order-first" : ""}`}>
                    <div
                      className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                        msg.role === "user"
                          ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                          : msg.content.startsWith("**Error**")
                          ? "bg-[var(--destructive)]/10 text-[var(--destructive)] border border-[var(--destructive)]/20"
                          : "bg-[var(--secondary)] text-[var(--foreground)]"
                      }`}
                    >
                      {msg.content}
                    </div>
                    {msg.model && msg.role === "assistant" && (
                      <div className="mt-1 text-[10px] text-[var(--muted-foreground)] px-1">
                        {msg.model}
                      </div>
                    )}
                  </div>
                  {msg.role === "user" && (
                    <div className="w-8 h-8 rounded-full bg-[var(--secondary)] flex items-center justify-center shrink-0">
                      <User className="w-4 h-4 text-[var(--muted-foreground)]" />
                    </div>
                  )}
                </div>
              ))}

              {/* Streaming message */}
              {streaming && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-[var(--primary)]/10 flex items-center justify-center shrink-0">
                    <Bot className="w-4 h-4 text-[var(--primary)]" />
                  </div>
                  <div className="max-w-[80%]">
                    <div className="rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-[var(--secondary)] text-[var(--foreground)]">
                      {streamingText ? (
                        <>
                          {streamingText}
                          <span className="inline-block w-2 h-4 bg-[var(--primary)]/50 ml-0.5 animate-pulse" />
                        </>
                      ) : (
                        <div className="flex items-center gap-2 py-1">
                          <span className="inline-flex gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)]/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)]/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)]/60 animate-bounce" style={{ animationDelay: "300ms" }} />
                          </span>
                          <span className="text-xs text-[var(--muted-foreground)]">
                            {activeModel.includes("qwq") || activeModel.includes("qvq") || activeModel.includes("deepseek") || activeModel.includes("kimi")
                              ? "Thinking..."
                              : "Generating..."}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="border-t border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 focus-within:border-[var(--primary)]/50 focus-within:ring-1 focus-within:ring-[var(--ring)] transition-colors">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={streaming ? "Waiting for response..." : "Type a message..."}
                disabled={streaming}
                className="flex-1 bg-transparent text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none resize-none max-h-[200px]"
                rows={1}
              />
              <div className="flex items-center gap-1 shrink-0">
                {streaming ? (
                  <button
                    onClick={handleStop}
                    className="p-2 rounded-lg bg-[var(--destructive)]/10 text-[var(--destructive)] hover:bg-[var(--destructive)]/20 transition-colors"
                    title="Stop"
                  >
                    <StopCircle className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || !active}
                    className="p-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Send"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1.5 text-[10px] text-center text-[var(--muted-foreground)]">
              Chat completions are proxied through Etteum's API. Model availability depends on account pool.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
