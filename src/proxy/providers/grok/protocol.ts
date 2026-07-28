/**
 * XAI app-chat protocol — payload builder and SSE stream adapter.
 *
 * TypeScript port of grok2api's `app/dataplane/reverse/protocol/xai_chat.py`.
 *
 * This module builds the grok.com web app-chat request payload and adapts the
 * upstream SSE stream into a series of normalized frame events (text deltas,
 * reasoning deltas, tool-usage cards, citations, errors).
 *
 * The grok.com web surface speaks a proprietary SSE protocol that interleaves:
 *   - text tokens           → { result: { response: { token: "..." } } }
 *   - reasoning/thinking    → { result: { response: { reasoning: { ... } } } }
 *   - tool usage cards      → { result: { response: { toolUsageCard: ... } } }
 *   - web-search results    → { result: { response: { webSearchResults: ... } } }
 *   - final metadata        → { result: { response: { isFinal, isSoftStop, ... } } }
 *     isFinal ends the stream; isSoftStop is a mid-generation pause and must
 *     NOT close the client stream (otherwise answers stop mid-sentence).
 *   - errors                → { error: { message, code } }
 *
 * The StreamAdapter normalizes all of the above into a simple FrameEvent stream
 * that the GrokProvider consumes to emit OpenAI-compatible chat-completion chunks.
 */

// ---------------------------------------------------------------------------
// Upstream endpoint constants
// (ported from grok2api endpoint_table.py)
// ---------------------------------------------------------------------------

export const GROK_ENDPOINTS = {
  APP_CHAT:        "https://grok.com/rest/app-chat/conversations/new",
  RATE_LIMITS:     "https://grok.com/rest/rate-limits",
  CONSOLE_CHAT:    "https://api.x.ai/v1/chat/completions",
  CONSOLE_RESPONSES: "https://api.x.ai/v1/responses",
} as const;

// ---------------------------------------------------------------------------
// ModeId — maps etteum model slugs to grok.com internal mode strings.
// (ported from grok2api model/enums.py ModeId)
// ---------------------------------------------------------------------------

export type GrokModeId =
  | "AUTO"
  | "EXPERT"
  | "HEAVY"
  | "FAST"
  | "GROK_4_3"
  | "CONSOLE";

/**
 * Model slug → grok.com modeId mapping.
 * The modeId controls which Grok backend variant serves the request.
 */
/**
 * Catalog: grok-4.5 family + composer-2.5. All use CONSOLE / cli-chat-proxy
 * surfaces — not the older grok.com web modeId map.
 */
export const MODEL_TO_MODE: Record<string, GrokModeId> = {
  "grok-4.5": "CONSOLE",
  "grok-4.5-reasoning": "CONSOLE",
  "composer-2.5": "CONSOLE",
  "grok-composer-2.5-fast": "CONSOLE",
  "composer-2.5-fast": "CONSOLE",
  "groq-composer-2.5-fast": "CONSOLE",
};

// ---------------------------------------------------------------------------
// Chat payload builder
// ---------------------------------------------------------------------------

export interface GrokChatPayloadOptions {
  message: string;
  modeId: GrokModeId;
  /** System / instruction prompt merged into the Grok "systemPromptName" field. */
  systemPrompt?: string;
  /** Whether the client wants reasoning/thinking output. */
  reasoning?: boolean;
  /** Conversation history — Grok web API is stateless per-request; we inline prior turns. */
  history?: Array<{ role: string; content: string }>;
  /**
   * Free-tier Imagine on grok.com web (SSO cookies). Public reverse-engineers
   * (gpt4free Grok, grok2api) set enableImageGeneration + enableImageStreaming
   * true; response carries modelResponse.generatedImageUrls / streamingImageGenerationResponse.
   * Default false so normal chat does not burn free image quota.
   */
  enableImageGeneration?: boolean;
  /** How many images to request when enableImageGeneration is true (web default 2). */
  imageGenerationCount?: number;
}

/**
 * Build the grok.com `/rest/app-chat/conversations/new` request body.
 *
 * This payload structure was reverse-engineered from the grok.com web client.
 * Field names and nesting match what the live web app sends as of 2026-07.
 */
export function buildChatPayload(opts: GrokChatPayloadOptions): Record<string, any> {
  const { message, modeId, systemPrompt, history } = opts;
  const wantImages = opts.enableImageGeneration === true;
  const imageCount = Math.min(
    4,
    Math.max(1, Math.floor(opts.imageGenerationCount ?? (wantImages ? 2 : 2))),
  );

  // If history is provided, prepend it as context inside the message.
  let fullMessage = message;
  if (history && history.length > 0) {
    const historyText = history
      .map((h) => {
        const label = h.role === "assistant" ? "Assistant" : h.role === "system" ? "System" : "User";
        return `[${label}]: ${h.content}`;
      })
      .join("\n\n");
    fullMessage = `${historyText}\n\n[User]: ${message}`;
  }

  // If a system prompt is provided, prepend it.
  if (systemPrompt) {
    fullMessage = `[System]: ${systemPrompt}\n\n${fullMessage}`;
  }

  return {
    // temporary: true matches gpt4free / grok2api free web clients (no history persist).
    temporary:                     true,
    disableSearch:                 false,
    enableImageGeneration:         wantImages,
    enableImageStreaming:          wantImages,
    imageGenerationCount:          imageCount,
    isPreset:                      false,
    isReasoning:                   opts.reasoning ?? false,
    isScreenshotGeneration:        false,
    // Free web returns asset paths; we download with SSO cookie → data URL.
    returnImageBytes:              false,
    returnRawGrokInXaiRequest:     false,
    sendFinalMetadata:             true,
    promptMetadata:                {
      promptSource:                "NATURAL",
      action:                      "INPUT",
    },
    customInstructions:            systemPrompt ?? "",
    conversationId:                "",
    returnSearchResults:           !wantImages,
    contextGroupCount:             0,
    message:                       fullMessage,
    modeId:                        modeId,
    // Lowercase modeId is what live free clients send (auto/fast/expert/…).
    // Keep both: modeId field above is our enum; web also accepts modelMode-style.
    fileAttachments:               [],
    imageAttachments:              [],
    responseMetadata:              {},
    isAsyncChat:                   false,
    isReasoningEnded:              false,
    toolOverrides:                 {},
    searchParameters:              {
      mode:                        "AUTO",
      sources:                     [],
      safeSearch:                  true,
      returnCitations:             true,
      maxSearchResults:            10,
    },
    timezone:                      "Asia/Kuala_Lumpur",
  };
}

// ---------------------------------------------------------------------------
// SSE line classification
// ---------------------------------------------------------------------------

export interface FrameEvent {
  type:
    | "text"          // a text-content delta
    | "reasoning"     // a reasoning/thinking delta
    | "tool_use"      // a tool-usage card (parsed)
    | "citation"      // a citation reference [[id]](url)
    | "web_search"    // web-search result metadata
    | "image"         // free web Imagine asset path or URL
    | "done"          // stream finished (isFinal only — never isSoftStop)
    | "error";        // upstream error
  text?: string;
  toolName?: string;
  toolArgs?: string;
  citationIndex?: number;
  citationUrl?: string;
  citationTitle?: string;
  /** Relative path (e.g. users/…/generated/….jpg) or absolute assets.grok.com URL. */
  imageUrl?: string;
  errorMessage?: string;
  errorStatus?: number;
}

/** Absolute assets.grok.com URL for a free-web generated path. */
export function resolveGrokAssetUrl(pathOrUrl: string): string {
  const s = (pathOrUrl || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const path = s.startsWith("/") ? s : `/${s}`;
  return `https://assets.grok.com${path}`;
}

// ---------------------------------------------------------------------------
// Reasoning aggregation
// (ported from xai_chat_reasoning.py ReasoningAggregator)
// ---------------------------------------------------------------------------

const GENERIC_HEADERS = new Set([
  "",
  "thinking about your request",
]);

const PROGRESSIVE_HINTS = [
  "now i'm",
  "now i am",
  "let me",
  "let's",
  "i need to",
  "i should",
  "i'll",
  "i will",
  "i'm going to",
  "i am going to",
  "checking",
  "searching",
  "looking",
  "analyzing",
  "let's think",
  "thinking",
];

interface ReasoningRollout {
  id: string;
  tag: string | null;
  stepId: string | null;
  text: string;
  done: boolean;
}

/**
 * Aggregates reasoning tokens across multiple Grok "rollouts" (thinking chains).
 *
 * Grok emits reasoning as a series of rollouts, each with an optional tag
 * (agent identity) and step_id. The aggregator deduplicates progressive hints
 * and emits clean reasoning deltas.
 */
export class ReasoningAggregator {
  private rollouts: Map<string, ReasoningRollout> = new Map();
  private emitted: Set<string> = new Set();

  /**
   * Process a reasoning token and return any new text to emit.
   * Returns null if the token is a duplicate / progressive hint.
   */
  process(rollout: string, tag: string | null, stepId: string | null, token: string): string | null {
    const key = rollout || "_default";
    let r = this.rollouts.get(key);
    if (!r) {
      r = { id: key, tag, stepId, text: "", done: false };
      this.rollouts.set(key, r);
    }

    // If a new rollout with the same key appears, reset.
    if (tag && r.tag !== tag) {
      r.tag = tag;
    }
    if (stepId && r.stepId !== stepId) {
      r.stepId = stepId;
    }

    const trimmed = token.trim().toLowerCase();

    // Skip generic headers.
    if (GENERIC_HEADERS.has(trimmed)) return null;

    // Skip progressive hints we've already seen.
    if (PROGRESSIVE_HINTS.some((h) => trimmed.startsWith(h))) {
      const hintKey = `${key}:${trimmed}`;
      if (this.emitted.has(hintKey)) return null;
      this.emitted.add(hintKey);
    }

    r.text += token;
    return token;
  }

  /** Mark a rollout as complete. */
  markDone(rollout: string): void {
    const key = rollout || "_default";
    const r = this.rollouts.get(key);
    if (r) r.done = true;
  }

  /** Get the full accumulated reasoning text for a rollout. */
  getText(rollout?: string): string {
    if (rollout) {
      return this.rollouts.get(rollout || "_default")?.text ?? "";
    }
    return Array.from(this.rollouts.values()).map((r) => r.text).join("\n");
  }
}

// ---------------------------------------------------------------------------
// Stream adapter
// ---------------------------------------------------------------------------

// Tool-name → (emoji, arg-keys) mapping for formatting tool-usage cards.
const TOOL_FORMAT: Record<string, [string, string[]]> = {
  x_search:               ["🔍", ["query"]],
  x_semantic_search:      ["🔍", ["query"]],
  browse_page:            ["🌐", ["url"]],
  search_images:          ["🖼️", ["image_description", "imageDescription"]],
  image_search:           ["🖼️", ["image_description", "imageDescription"]],
  chatroom_send:          ["📋", ["message"]],
  code_interpreter:       ["💻", ["code"]],
  x_post:                 ["📝", ["text", "content"]],
};

const CITATION_RE = /\[\[(\d+)\]\]\(([^)]*)\)/g;
const RENDER_RE = /\[\[(\d+)\]\]\([^)]*?\)\{([^}]*?)(?::([^}]*?))?\}/g;

export class StreamAdapter {
  private reasoning = new ReasoningAggregator();
  private cardCache: Map<string, any> = new Map();
  private webSearchResults: any[] = [];
  private lastCitationIndex = -1;
  private showSearchSources = false;

  constructor(opts?: { showSearchSources?: boolean }) {
    this.showSearchSources = opts?.showSearchSources ?? false;
  }

  /**
   * Feed a single SSE `data:` line and return zero or more FrameEvents.
   *
   * Each grok.com SSE line is a JSON object. The adapter inspects the
   * structure and classifies it into FrameEvents.
   */
  feed(line: string): FrameEvent[] {
    const events: FrameEvent[] = [];
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return events;

    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return events;
    }

    // Check for in-band error.
    const error = this.extractError(obj);
    if (error) {
      events.push({
        type: "error",
        errorMessage: error.message,
        errorStatus: error.status,
      });
      return events;
    }

    const result = obj?.result;
    if (!result) return events;

    const response = result?.response;
    if (!response) {
      // Only isFinal ends the stream. isSoftStop is a mid-generation pause
      // (tools / search / reasoning segments) — closing on it truncates the
      // answer with finish_reason "stop" and no error. why: silent early stop.
      if (result?.isFinal === true) {
        events.push({ type: "done" });
      }
      return events;
    }

    // --- Text token ---
    if (response.token != null && typeof response.token === "string") {
      let token = response.token;
      // Render citations inside the text token.
      token = this.renderCitationsInText(token, events);
      if (token) {
        events.push({ type: "text", text: token });
      }
    }

    // --- Reasoning ---
    if (response.reasoning) {
      this.handleReasoning(response.reasoning, events);
    }

    // --- Tool usage card ---
    if (response.toolUsageCard) {
      this.handleToolCard(response.toolUsageCard, events);
    }

    // --- Web search results ---
    if (response.webSearchResults) {
      this.handleWebSearch(response.webSearchResults);
    }

    // --- Free web Imagine (enableImageGeneration) ---
    // Progress frames: streamingImageGenerationResponse.imageUrl (partial preview).
    // Final: modelResponse.generatedImageUrls[] (paths under assets.grok.com).
    const streamImg = response.streamingImageGenerationResponse;
    if (streamImg && typeof streamImg === "object") {
      const preview = (streamImg as any).imageUrl ?? (streamImg as any).url;
      if (typeof preview === "string" && preview.trim()) {
        events.push({ type: "image", imageUrl: preview.trim() });
      }
    }
    const modelResponse = response.modelResponse;
    if (modelResponse && typeof modelResponse === "object") {
      const urls = (modelResponse as any).generatedImageUrls;
      if (Array.isArray(urls)) {
        for (const u of urls) {
          if (typeof u === "string" && u.trim()) {
            events.push({ type: "image", imageUrl: u.trim() });
          }
        }
      }
      // Some builds nest a single generated image on modelResponse directly.
      const single =
        (modelResponse as any).generatedImageUrl ??
        (modelResponse as any).imageUrl;
      if (typeof single === "string" && single.trim()) {
        events.push({ type: "image", imageUrl: single.trim() });
      }
    }

    // --- Cards (cache for later citation rendering) ---
    if (response.cards) {
      for (const card of response.cards) {
        if (card?.id != null) {
          this.cardCache.set(String(card.id), card);
        }
      }
    }

    // --- Final only (isSoftStop is a pause, not completion — see feed() note) ---
    if (response.isFinal === true) {
      events.push({ type: "done" });
    }

    return events;
  }

  // --- Error extraction ---

  private extractError(obj: any): { message: string; status: number } | null {
    const error = obj?.error;
    if (typeof error !== "object" || error === null) return null;

    const rawMessage = error.message ?? error.error ?? "Upstream stream error";
    const message = String(rawMessage);
    const code = error.code;
    const text = `${message} ${code ?? ""}`.toLowerCase();
    // Free-usage / spending-limit exhaustion often arrives as rate-limit-shaped
    // frames; surface as 402 so callers mark the account exhausted, not cooled.
    const exhausted =
      text.includes("free-usage-exhausted") ||
      text.includes("spending-limit") ||
      text.includes("spending_limit") ||
      text.includes("you've used all") ||
      text.includes("payment required");
    const status = exhausted
      ? 402
      : code === 8 || text.includes("too many requests") || text.includes("rate limit")
        ? 429
        : 502;

    return { message, status };
  }

  // --- Reasoning handling ---

  private handleReasoning(reasoning: any, events: FrameEvent[]): void {
    const rollout = reasoning.rolloutId ?? reasoning.rollout ?? "";
    const tag = reasoning.tag ?? reasoning.agentTag ?? null;
    const stepId = reasoning.stepId ?? reasoning.step_id ?? null;
    const token = reasoning.token ?? reasoning.text ?? "";

    if (typeof token !== "string" || !token) return;

    const emitted = this.reasoning.process(String(rollout), tag, stepId, token);
    if (emitted) {
      events.push({ type: "reasoning", text: emitted });
    }

    if (reasoning.isDone === true || reasoning.done === true) {
      this.reasoning.markDone(String(rollout));
    }
  }

  // --- Tool card handling ---

  private handleToolCard(card: any, events: FrameEvent[]): void {
    const toolName = card?.name ?? card?.toolName ?? card?.tool ?? "";
    if (!toolName) return;

    const name = String(toolName).toLowerCase();
    const fmt = TOOL_FORMAT[name];
    const emoji = fmt ? fmt[0] : "🔧";
    const argKeys = fmt ? fmt[1] : [];

    // Extract arguments.
    const args: Record<string, any> = card?.args ?? card?.arguments ?? card?.parameters ?? {};
    let toolArgs = "";
    if (argKeys.length > 0) {
      const parts: string[] = [];
      for (const key of argKeys) {
        const val = args[key];
        if (val != null) {
          parts.push(`${emoji} ${name}: ${String(val)}`);
        }
      }
      toolArgs = parts.join("\n");
    } else {
      toolArgs = `${emoji} ${name}`;
    }

    events.push({
      type: "tool_use",
      toolName: String(toolName),
      toolArgs,
    });
  }

  // --- Web search results ---

  private handleWebSearch(results: any): void {
    if (!Array.isArray(results)) return;
    for (const r of results) {
      if (r?.url) {
        this.webSearchResults.push(r);
      }
    }
  }

  // --- Citation rendering ---

  private renderCitationsInText(text: string, events: FrameEvent[]): string {
    // Handle {render_type} patterns — render inline content.
    let result = text.replace(RENDER_RE, (_match, cardId, _content, renderType) => {
      const card = this.cardCache.get(String(cardId));
      if (!card) return "";
      return this.renderCard(String(cardId), card, renderType);
    });

    // Handle simple [[id]](url) citation references.
    result = result.replace(CITATION_RE, (_match, indexStr, url) => {
      const index = parseInt(indexStr, 10);
      if (index === this.lastCitationIndex) return "";
      this.lastCitationIndex = index;

      const card = this.cardCache.get(String(index));
      const title = card?.title ?? "";
      events.push({
        type: "citation",
        citationIndex: index,
        citationUrl: url,
        citationTitle: typeof title === "string" ? title : "",
      });
      return ` [[${index}]](${url})`;
    });

    return result;
  }

  private renderCard(cardId: string, card: any, renderType: string): string {
    if (renderType === "render_searched_image") {
      const img = card?.image ?? {};
      const url = img?.url ?? img?.imageUrl ?? "";
      return url ? `![image](${url})` : "";
    }
    return "";
  }

  // --- Sources footer ---

  /** Format a ## Sources markdown footer from accumulated web-search results. */
  getSourcesFooter(): string {
    if (!this.showSearchSources || this.webSearchResults.length === 0) return "";
    const lines = ["\n\n## Sources", "[grok2api-sources]: #"];
    for (const item of this.webSearchResults) {
      const title = item.title ?? item.url ?? "";
      const url = item.url ?? "";
      lines.push(`- [${title}](${url})`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// SSE stream parser — splits a raw byte stream into individual `data:` lines.
// ---------------------------------------------------------------------------

/**
 * Parse SSE events from a text chunk.
 * Returns an array of `data:` payloads (the JSON strings).
 */
export function parseSseEvents(text: string): string[] {
  const events: string[] = [];
  const lines = text.split("\n");
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      currentData.push(line.slice(5).trimStart());
    } else if (line.trim() === "" && currentData.length > 0) {
      // Empty line = event boundary.
      events.push(currentData.join("\n"));
      currentData = [];
    }
  }

  // Handle trailing data without a final blank line.
  if (currentData.length > 0) {
    events.push(currentData.join("\n"));
  }

  return events;
}

// ---------------------------------------------------------------------------
// Console API (console.x.ai) response → FrameEvent adapter
// ---------------------------------------------------------------------------

/**
 * Convert a console.x.ai chat-completion streaming chunk (OpenAI-compatible)
 * into FrameEvents. The console API is already OpenAI-format, so this is a
 * thin shim that normalizes to the same FrameEvent interface.
 */
export function consoleChunkToEvents(chunk: any): FrameEvent[] {
  const events: FrameEvent[] = [];
  const choice = chunk?.choices?.[0];
  if (!choice) {
    if (chunk?.usage) {
      events.push({ type: "done" });
    }
    return events;
  }

  const delta = choice.delta ?? choice.message ?? {};

  if (delta.content) {
    events.push({ type: "text", text: delta.content });
  }

  if (delta.reasoning_content) {
    events.push({ type: "reasoning", text: delta.reasoning_content });
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      events.push({
        type: "tool_use",
        toolName: tc.function?.name ?? "",
        toolArgs: tc.function?.arguments ?? "",
      });
    }
  }

  if (choice.finish_reason) {
    events.push({ type: "done" });
  }

  return events;
}

__all__: void 0; // module marker