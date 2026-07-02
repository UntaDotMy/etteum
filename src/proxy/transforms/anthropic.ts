import type { ChatCompletionRequest, ChatMessage } from "../providers/base";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  thinking?: { type: string; budget_tokens?: number; display?: string; effort?: string; summary?: string };
  effort?: string;
}

/**
 * Extract text from any content shape (string, array of blocks, etc.).
 * Handles Anthropic tool_result nested content as well.
 */
function contentToText(content: string | AnthropicContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Centralized message normalization.
//
// Agentic clients (Claude Code, Cline, Cursor, OpenCode, Codex CLI, etc.)
// send messages in either Anthropic or OpenAI format — and sometimes mix
// them in the same request.  Every provider in this proxy expects clean
// canonical OpenAI-format messages, so we normalize once here.
//
// The canonical OpenAI shape after normalization:
//
//   system    — content is a plain string
//   user      — content is a string OR array of {type:"text"} / {type:"image_url"}
//   assistant — content is a string (may be "") + optional tool_calls[]
//   tool      — content is a string, has tool_call_id
//
// Anthropic concepts that are converted:
//   • tool_result blocks → separate role:"tool" messages
//   • tool_use blocks    → assistant.tool_calls[]
//   • image blocks       → image_url data URLs
//   • thinking blocks    → dropped (no OpenAI equivalent)
//
// NOTHING is silently dropped — every block that carries semantic meaning
// (text, tool calls, tool results, images) is preserved in the canonical
// shape.  Only empty wrappers and unsupported metadata (thinking, signatures)
// are removed.
// ────────────────────────────────────────────────────────────────────────────

function normalizeImageBlock(block: any): any | null {
  // Already OpenAI image_url — passthrough.
  if (block.type === "image_url" && block.image_url?.url) {
    return { type: "image_url", image_url: block.image_url };
  }
  // Anthropic base64 image: { type:"image", source:{type:"base64",media_type,data} }
  if (block.type === "image" && block.source?.type === "base64" && block.source.data) {
    return {
      type: "image_url",
      image_url: { url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}` },
    };
  }
  // Anthropic URL image: { type:"image", source:{type:"url",url} }
  if (block.type === "image" && block.source?.type === "url" && block.source.url) {
    return { type: "image_url", image_url: { url: block.source.url } };
  }
  return null;
}

function parseToolInput(input: any): string {
  if (typeof input === "string") return input;
  try { return JSON.stringify(input ?? {}); } catch { return "{}"; }
}

function parseToolArguments(args: any): any {
  if (typeof args === "string") {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return args ?? {};
}

/**
 * Map an OpenAI `finish_reason` to the Anthropic `stop_reason`.
 *
 * OpenAI → Anthropic:
 *   tool_calls     → tool_use
 *   length         → max_tokens
 *   content_filter → end_turn          (Anthropic has no content_filter stop_reason;
 *                                       the filtered content is already gone)
 *   refusal        → end_turn          (Anthropic has no refusal stop_reason; the
 *                                       refusal text is preserved in the text block)
 *   stop / *       → end_turn
 *
 * `hasToolCalls` wins over finish_reason because some upstreams set
 * finish_reason="stop" even when tool_calls are present.
 */
function mapFinishReasonToStopReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
  text: string,
): "tool_use" | "max_tokens" | "end_turn" {
  if (hasToolCalls) return "tool_use";
  switch (finishReason) {
    case "length":
      return "max_tokens";
    // content_filter and refusal have no Anthropic stop_reason equivalent;
    // surface as end_turn (filtered/refusal text is already in `content`).
    case "content_filter":
    case "refusal":
    case "stop":
    default:
      return "end_turn";
  }
}

/**
 * Guarantee a non-empty `tool_use` id. Per the OpenAI streaming spec the
 * `id` arrives only on the first chunk for a given tool-call index; some
 * non-OpenAI upstreams omit it entirely. Anthropic clients require a
 * non-empty `tool_use.id` to match the follow-up `tool_result.tool_use_id`,
 * so synthesize a `toolu_`-style id when missing.
 */
function ensureToolUseId(id: any): string {
  if (typeof id === "string" && id.length > 0) return id;
  return `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        if (typeof b === "string") return b;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * True if an Anthropic tool_result content array carries an image block.
 * OpenAI role:"tool" messages only accept string content, so a multimodal
 * result must be flattened — but we detect images so the caller can keep the
 * image as a separate user message rather than dropping it (Fix #5).
 */
function toolResultHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b: any) => b?.type === "image" || b?.type === "image_url");
}

/**
 * Convert an Anthropic tool_result block into one or more canonical OpenAI
 * messages. A text-only result → a single role:"tool" message. A multimodal
 * result (text + image) → a role:"tool" message with the text AND a follow-up
 * role:"user" message carrying the image, so the image is never lost (Fix #5).
 *
 * `is_error` has no OpenAI field; we surface it by prefixing the content with
 * a conventional marker the model can read (Fix #6).
 */
function toolResultToOpenAIMessages(
  toolUseId: string,
  content: unknown,
  isError: boolean,
): ChatMessage[] {
  const text = toolResultContentToText(content);
  const marked = isError ? `[tool_error] ${text}` : text;
  const out: ChatMessage[] = [{ role: "tool", tool_call_id: toolUseId, content: marked }];

  // Preserve images from multimodal tool results instead of dropping them.
  if (toolResultHasImage(content) && Array.isArray(content)) {
    const imageParts: any[] = [];
    for (const b of content as any[]) {
      const img = normalizeImageBlock(b);
      if (img) imageParts.push(img);
    }
    if (imageParts.length > 0) {
      out.push({ role: "user", content: imageParts });
    }
  }
  return out;
}

/**
 * Normalize a single message (possibly in mixed Anthropic/OpenAI format) into
 * one or more canonical OpenAI messages.
 *
 * Returns an array because a single Anthropic user message containing
 * tool_result blocks expands into multiple role:"tool" messages.
 */
function normalizeMessageToOpenAI(msg: ChatMessage): ChatMessage[] {
  const role = msg.role;

  // ── role:"tool" (already OpenAI) — passthrough, just ensure string content ──
  if (role === "tool") {
    const content = typeof msg.content === "string"
      ? msg.content
      : toolResultContentToText(msg.content);
    return [{ role: "tool", tool_call_id: msg.tool_call_id || "", content }];
  }

  // ── role:"system" — ensure string content ──
  if (role === "system") {
    const content = typeof msg.content === "string"
      ? msg.content
      : toolResultContentToText(msg.content);
    return [{ role: "system", content }];
  }

  // ── String or null content — passthrough, preserve tool_calls if present ──
  // OpenAI allows assistant messages with content:null when tool_calls are
  // present, and tool messages always have string content + tool_call_id.
  if (typeof msg.content === "string" || msg.content === null || msg.content === undefined) {
    const out: ChatMessage = { role, content: typeof msg.content === "string" ? msg.content : "" };
    if (msg.tool_calls && msg.tool_calls.length > 0) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    return [out];
  }

  // ── Array content — decompose into parts ──
  if (!Array.isArray(msg.content)) {
    // Unknown content type — coerce to string so nothing is lost.
    return [{ role, content: String(msg.content ?? "") }];
  }

  const textParts: string[] = [];
  const imageParts: any[] = [];
  const toolCalls: any[] = [];
  const toolResults: { id: string; content: unknown; is_error?: boolean }[] = [];

  // If the message already has OpenAI-format tool_calls (e.g. from the
  // /v1/chat/completions path), preserve them.  Anthropic tool_use blocks
  // found in the content array below will be merged in.
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc?.id && tc?.function?.name) toolCalls.push(tc);
    }
  }

  for (const block of msg.content as any[]) {
    if (!block || typeof block !== "object") {
      if (typeof block === "string") textParts.push(block);
      continue;
    }

    // Text block (both Anthropic and OpenAI use { type:"text", text })
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    // Image blocks
    const img = normalizeImageBlock(block);
    if (img) { imageParts.push(img); continue; }

    // Anthropic tool_use → OpenAI assistant.tool_calls
    if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: parseToolInput(block.input) },
      });
      continue;
    }

    // Anthropic tool_result → separate role:"tool" messages (emitted below)
    // Keep raw content so toolResultToOpenAIMessages can preserve images.
    if (block.type === "tool_result" && block.tool_use_id) {
      toolResults.push({
        id: block.tool_use_id,
        content: block.content,
        is_error: Boolean(block.is_error),
      });
      continue;
    }

    // Thinking / redacted_thinking — no OpenAI equivalent; drop silently.
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;

    // Unknown block — coerce to text rather than dropping, so information
    // is never silently lost.
    if (typeof block.text === "string") textParts.push(block.text);
    else { try { textParts.push(JSON.stringify(block)); } catch { /* skip */ } }
  }

  const out: ChatMessage[] = [];

  // Emit tool_results FIRST as role:"tool" messages, preserving order.
  // Multimodal results also emit a follow-up user message with the image.
  for (const tr of toolResults) {
    out.push(...toolResultToOpenAIMessages(tr.id, tr.content, tr.is_error === true));
  }

  const text = textParts.join("\n");

  // Assistant message with tool_calls.
  if (role === "assistant" && toolCalls.length > 0) {
    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    } as any);
    return out;
  }

  // Multimodal user content stays as an array.
  if (imageParts.length > 0 && role === "user") {
    const mmContent: any[] = [];
    if (text) mmContent.push({ type: "text", text });
    mmContent.push(...imageParts);
    out.push({ role: "user", content: mmContent });
    return out;
  }

  // Plain text message.  Skip emitting an empty user message if the only
  // content was tool_results (they were already emitted as role:"tool").
  // But always emit assistant messages (even empty) so tool_calls aren't
  // orphaned, and always emit user messages that have text.
  if (text || role === "assistant" || (role === "user" && toolResults.length === 0 && imageParts.length === 0)) {
    out.push({ role, content: text });
  }

  return out;
}

/**
 * Normalize an entire message array into canonical OpenAI format.
 * Handles Anthropic-style content blocks (tool_use, tool_result, image,
 * thinking) intermixed with OpenAI-style blocks in the same request.
 *
 * This is the single source of truth for message normalization — called
 * from both /v1/chat/completions and /v1/messages endpoints.
 *
 * Guarantees:
 *  • No tool_result or tool_use blocks remain inside message content arrays
 *  • tool_results are extracted into role:"tool" messages
 *  • tool_use blocks are extracted into assistant.tool_calls
 *  • Anthropic images are converted to image_url data URLs
 *  • Nothing carrying semantic content (text, tools, images) is dropped
 */
export function normalizeMessagesToOpenAI(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    const normalized = normalizeMessageToOpenAI(msg);
    for (const m of normalized) out.push(m);
  }
  return out;
}

/**
 * Normalize tools to canonical OpenAI format.
 * Converts Anthropic-style tools ({name, description, input_schema}) into
 * OpenAI format ({type:"function", function:{name, description, parameters}}).
 * Already-OpenAI tools pass through untouched.
 */
export function normalizeToolsToOpenAI(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .map((tool) => {
      if (tool?.type === "function" && tool.function?.name) return tool;
      const name = tool?.name;
      if (!name) return null;
      const parameters = tool.input_schema ?? tool.parameters ?? { type: "object", properties: {} };
      return { type: "function", function: { name, description: tool.description || "", parameters } };
    })
    .filter(Boolean);
}

/**
 * Normalize a complete ChatCompletionRequest into canonical OpenAI format.
 *
 * This is the single entry point for the /v1/chat/completions endpoint.
 * It normalizes messages (converting any Anthropic-style content blocks)
 * and tools (converting Anthropic tool definitions) in one pass.
 *
 * Returns a NEW request object — the original is not mutated.
 */
export function normalizeRequestToOpenAI(request: ChatCompletionRequest): ChatCompletionRequest {
  return {
    ...request,
    messages: normalizeMessagesToOpenAI(request.messages),
    tools: normalizeToolsToOpenAI(request.tools),
  };
}

function anthropicContentToOpenAI(content: string | AnthropicContentBlock[] | undefined): string | any[] {
  if (!Array.isArray(content)) return content || "";
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text || "" };
    // Pass through tool_result / tool_use / image blocks; the caller
    // (anthropicToOpenAI) is responsible for splitting them into proper
    // OpenAI role:"tool" messages / assistant.tool_calls.
    return block;
  });
}

/**
 * Convert a single message's content-block array (or string) into one or more
 * canonical OpenAI-format messages.
 *
 * Anthropic packs `tool_result` and `tool_use` blocks inside a single
 * user/assistant message's `content` array. OpenAI represents them as:
 *   - `tool_result` → separate `role:"tool"` messages with `tool_call_id`
 *   - `tool_use`    → `assistant.tool_calls[]`
 *
 * Without this conversion, upstream OpenAI-compatible relays reject the
 * request with:
 *   "Invalid value: tool_result. Supported values are: 'text','image_url',…"
 *
 * Returns an array of messages (which may contain MORE entries than the input
 * — one `role:"tool"` per `tool_result` block, plus the base message).
 */
function anthropicMessageToOpenAIMessages(message: AnthropicMessage): ChatCompletionRequest["messages"] {
  const content = message.content;

  // String content — passthrough.
  if (!Array.isArray(content)) {
    return [{ role: message.role, content: content || "" }];
  }

  const textParts: string[] = [];
  const imageParts: any[] = [];
  const toolCalls: any[] = [];
  // Raw content kept so toolResultToOpenAIMessages can preserve images.
  const toolResults: { id: string; content: unknown; is_error?: boolean }[] = [];

  for (const block of content as any[]) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    // OpenAI image_url block — passthrough.
    if (block.type === "image_url" && block.image_url?.url) {
      imageParts.push({ type: "image_url", image_url: block.image_url });
      continue;
    }

    // Anthropic image block: { type:"image", source:{type:"base64",media_type,data} }
    if (block.type === "image" && block.source?.type === "base64") {
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
      continue;
    }
    if (block.type === "image" && block.source?.type === "url" && block.source.url) {
      imageParts.push({ type: "image_url", image_url: { url: block.source.url } });
      continue;
    }

    // Anthropic tool_use → OpenAI assistant.tool_calls
    if (block.type === "tool_use") {
      const args = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: args },
      });
      continue;
    }

    // Anthropic tool_result → separate role:"tool" messages (emitted below).
    // Keep the raw content (not pre-flattened) so images are preserved.
    if (block.type === "tool_result") {
      toolResults.push({
        id: block.tool_use_id,
        content: block.content,
        is_error: Boolean(block.is_error),
      });
      continue;
    }

    // Anthropic thinking blocks — drop; OpenAI has no equivalent and would
    // reject the unknown content type.
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;

    // Unknown block — coerce to text so we never propagate a raw Anthropic
    // shape downstream that the upstream relay would reject.
    if (typeof (block as any).text === "string") textParts.push((block as any).text);
  }

  const out: ChatCompletionRequest["messages"] = [];

  // Emit tool_results FIRST (one role:"tool" message per result, + optional
  // follow-up user image message for multimodal results), preserving order.
  for (const tr of toolResults) {
    out.push(...toolResultToOpenAIMessages(tr.id, tr.content, tr.is_error === true));
  }

  const text = textParts.join("\n");

  // Assistant message with tool_calls.
  if (message.role === "assistant" && toolCalls.length > 0) {
    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });
    return out;
  }

  // Multimodal user content stays as an array.
  if (imageParts.length > 0 && message.role === "user") {
    const mmContent: any[] = [];
    if (text) mmContent.push({ type: "text", text });
    mmContent.push(...imageParts);
    out.push({ role: "user", content: mmContent });
    return out;
  }

  // Emit the remaining text/image content as a message, UNLESS this was a
  // user message whose only meaningful content was tool_results (already
  // emitted above as role:"tool" messages) — emitting an empty user message
  // would confuse some upstream relays.
  const onlyHadToolResults = toolResults.length > 0 && !text && imageParts.length === 0 && toolCalls.length === 0;
  if (!onlyHadToolResults) {
    // Skip empty assistant messages that only carried tool_use blocks
    // (already emitted above as tool_calls).
    if (text || message.role !== "assistant" || toolCalls.length === 0) {
      out.push({ role: message.role, content: text });
    }
  }

  return out;
}

/**
 * Convert Anthropic tool definitions `{ name, description, input_schema }` into
 * the OpenAI shape `{ type: "function", function: { name, description, parameters } }`
 * that every internal provider (kiro, kiro-pro, qoder, ...) expects.
 *
 * Without this, providers receive `input_schema` where they look for
 * `function.parameters`, silently send no usable tool spec upstream, and the
 * model replies with an empty turn — which surfaces in agents as "no reply".
 */
/**
 * Anthropic built-in tool types have no OpenAI function-calling equivalent and
 * cannot be honored by an OpenAI-shaped upstream. If a request asks for one we
 * fail fast with a clear error rather than silently degrading to a broken
 * function tool (which would make the model reply with an empty turn).
 *
 * Known built-in prefixes (2025/2026): web_search_*, code_execution_*,
 * computer_*, text_editor_*, bash_*, context_editor_*, and the `mcp` tool.
 */
const ANTHROPIC_BUILTIN_TOOL_PREFIXES = [
  "web_search_",
  "code_execution_",
  "computer_",
  "text_editor_",
  "bash_",
  "context_editor_",
];

export function isAnthropicBuiltinTool(tool: any): boolean {
  if (!tool || typeof tool !== "object") return false;
  const type = tool.type;
  if (typeof type !== "string" || type.length === 0) return false;
  if (type === "function") return false; // OpenAI-shaped, not a builtin
  // Anthropic built-ins carry a versioned type like "web_search_20250305".
  // A custom user tool in Anthropic format has NO `type` field (only name +
  // input_schema), so any present `type` that isn't "function" is a builtin.
  if (type === "mcp") return true;
  return ANTHROPIC_BUILTIN_TOOL_PREFIXES.some((p) => type.startsWith(p));
}

export class AnthropicBuiltinToolError extends Error {
  constructor(toolType: string) {
    super(
      `Anthropic built-in tool "${toolType}" has no OpenAI equivalent and is not supported through this proxy. ` +
      `Remove it from the request or route the request to a provider that supports it natively.`,
    );
    this.name = "AnthropicBuiltinToolError";
  }
}

export function anthropicToolsToOpenAI(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  // Fail fast on built-in tools — silent degradation causes empty-turn bugs.
  for (const tool of tools) {
    if (isAnthropicBuiltinTool(tool)) {
      throw new AnthropicBuiltinToolError(tool.type);
    }
  }
  return tools
    .map((tool) => {
      // Already OpenAI-shaped — pass through untouched.
      if (tool?.type === "function" && tool.function?.name) return tool;
      const name = tool?.name;
      if (!name) return null;
      const parameters =
        tool.input_schema ?? tool.parameters ?? { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name,
          description: tool.description || "",
          parameters,
          ...(tool.strict === true ? { strict: true } : {}), // Fix #7: carry strict
        },
      };
    })
    .filter(Boolean);
}

/**
 * Convert Anthropic `tool_choice` into the OpenAI equivalent.
 *   { type: "auto" }        -> "auto"
 *   { type: "any" }         -> "required"
 *   { type: "tool", name }  -> { type: "function", function: { name } }
 *   "auto" | "none" | ...   -> passed through
 */
export function anthropicToolChoiceToOpenAI(toolChoice: any): any {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return toolChoice.name
        ? { type: "function", function: { name: toolChoice.name } }
        : "required";
    case "none":
      return "none";
    default:
      return undefined;
  }
}

export function anthropicToOpenAI(body: AnthropicMessagesRequest): ChatCompletionRequest {
  const rawMessages: ChatCompletionRequest["messages"] = [];
  const system = contentToText(body.system);
  if (system) rawMessages.push({ role: "system", content: system });

  for (const message of body.messages || []) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    rawMessages.push(message as any);
  }

  // Centralized normalization — converts Anthropic content blocks
  // (tool_result, tool_use, image, thinking) into canonical OpenAI format.
  const messages = normalizeMessagesToOpenAI(rawMessages);
  const tools = normalizeToolsToOpenAI(body.tools);
  const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.effort ? { reasoning_effort: body.effort } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
  };
}

export function openAIToAnthropic(response: any, request: AnthropicMessagesRequest) {
  const choice = response?.choices?.[0];
  const text = choice?.message?.content || "";
  const reasoning = choice?.message?.reasoning_content || "";
  const toolCalls = choice?.message?.tool_calls || [];
  const finishReason = choice?.finish_reason;
  const content = [];
  // Extended thinking: when the request enables `thinking`, upstream
  // `reasoning_content` must become an Anthropic `thinking` block (rendered
  // separately from output by Claude Code / Cline). The `signature` is NOT
  // validated on first receipt — only when a client sends a prior thinking
  // block back to the REAL Anthropic API. Through this proxy the round-trip
  // goes to a non-Anthropic upstream that doesn't validate Anthropic
  // signatures, so a placeholder signature round-trips harmlessly. Without a
  // thinking block, the reasoning would leak into the text/output stream.
  const thinkingEnabled = Boolean(request?.thinking);
  if (reasoning && thinkingEnabled) {
    content.push({ type: "thinking", thinking: reasoning, signature: "poolprox_thinking_v1" });
  } else if (reasoning) {
    // No thinking requested — surface reasoning as text so it isn't lost,
    // but it won't render as a separate thinking section (the client didn't
    // ask for one).
    content.push({ type: "text", text: reasoning });
  }
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    let input = call?.function?.arguments || {};
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { input = {}; }
    }
    content.push({ type: "tool_use", id: ensureToolUseId(call.id), name: call?.function?.name, input });
  }
  const usage = response?.usage || {};
  return {
    id: response?.id?.replace(/^chatcmpl-/, "msg_") || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: response?.model || request.model,
    content: content.length > 0 ? content : [{ type: "text", text }],
    stop_reason: mapFinishReasonToStopReason(finishReason, toolCalls.length > 0, text),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
  };
}

export function openAIStreamToAnthropic(stream: ReadableStream<Uint8Array>, request: AnthropicMessagesRequest) {
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const thinkingEnabled = Boolean(request?.thinking);
  let buffer = "";
  let started = false;
  let index = 0;
  let blockIndex = -1;
  let textBlockOpen = false;
  let thinkingBlockOpen = false;
  let thinkingSignatureSent = false;
  const toolBlocks = new Map<number, number>();
  const closedToolBlocks = new Set<number>();
  let stopReason = "end_turn";
  let usageFromUpstream = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // Estimate input tokens from request content (system + messages)
  function estimateInputTokens(): number {
    let tokens = 0;
    if (request.system) {
      const sysText = typeof request.system === "string"
        ? request.system
        : request.system.map((b: any) => b?.text || "").join("");
      tokens += Math.max(1, Math.ceil(sysText.length / 4));
    }
    for (const msg of request.messages || []) {
      if (typeof msg.content === "string") {
        tokens += Math.max(1, Math.ceil(msg.content.length / 4));
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            tokens += Math.max(1, Math.ceil(block.text.length / 4));
          } else if (block?.type === "tool_result") {
            const text = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: any) => b?.text || "").join("")
                : "";
            tokens += Math.max(1, Math.ceil(text.length / 4));
          }
        }
      }
      tokens += 4; // role overhead
    }
    return Math.max(1, tokens);
  }

  const estimatedInputTokens = estimateInputTokens();

  function event(name: string, data: unknown) {
    return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function dataPayload(block: string): string | null {
    const lines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"));
    if (lines.length === 0) return null;
    return lines
      .map((line) => line.startsWith("data: ") ? line.slice(6) : line.slice(5))
      .join("\n")
      .trim();
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const startMessage = () => {
        if (started) return;
        started = true;
        controller.enqueue(event("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: request.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
          },
        }));
      };

      const ensureTextBlock = () => {
        if (textBlockOpen) return;
        if (thinkingBlockOpen) {
          closeThinkingBlock();
          thinkingBlockOpen = false;
        }
        blockIndex += 1;
        textBlockOpen = true;
        controller.enqueue(event("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        }));
      };

      const closeThinkingBlock = () => {
        if (!thinkingBlockOpen) return;
        // Emit the signature_delta once before closing (Anthropic streaming
        // spec). Placeholder signature — see the note on `thinkingEnabled`
        // above for why this is safe through this proxy.
        if (!thinkingSignatureSent) {
          controller.enqueue(event("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature: "poolprox_thinking_v1" },
          }));
          thinkingSignatureSent = true;
        }
        controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
        thinkingBlockOpen = false;
      };

      try {
        startMessage();
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(event("ping", { type: "ping" }));
          } catch {
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = null;
          }
        }, 10_000);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const payload = dataPayload(part);
            if (!payload) continue;
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              if (chunk?.error) {
                const message = typeof chunk.error === "string"
                  ? chunk.error
                  : chunk.error.message || "Upstream stream error";
                controller.enqueue(event("error", {
                  type: "error",
                  error: { type: "api_error", message },
                }));
                continue;
              }
              const finishReason = chunk?.choices?.[0]?.finish_reason;
              const delta = chunk?.choices?.[0]?.delta || {};
              const reasoning = delta.reasoning_content || "";
              const text = delta.content || "";

              // Capture upstream usage from final chunk
              if (chunk?.usage) {
                usageFromUpstream = {
                  prompt_tokens: Number(chunk.usage.prompt_tokens || 0),
                  completion_tokens: Number(chunk.usage.completion_tokens || 0),
                  total_tokens: Number(chunk.usage.total_tokens || 0),
                };
              }

              if (reasoning) {
                if (thinkingEnabled) {
                  // Extended thinking is on: emit a proper `thinking` block so
                  // clients render it as a separate thinking section (not
                  // leaked into output). The signature is not validated on
                  // first receipt and the round-trip goes to a non-Anthropic
                  // upstream that doesn't validate Anthropic signatures, so a
                  // placeholder signature is safe here.
                  if (!thinkingBlockOpen) {
                    if (textBlockOpen) {
                      controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
                      textBlockOpen = false;
                    }
                    blockIndex += 1;
                    thinkingBlockOpen = true;
                    thinkingSignatureSent = false;
                    controller.enqueue(event("content_block_start", {
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "thinking", thinking: "", signature: "" },
                    }));
                  }
                  controller.enqueue(event("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "thinking_delta", thinking: reasoning },
                  }));
                } else {
                  // No thinking requested — route reasoning to text so it
                  // isn't lost, but it won't render as a separate section.
                  ensureTextBlock();
                  controller.enqueue(event("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "text_delta", text: reasoning },
                  }));
                  index += reasoning.length;
                }
              }

              if (text) {
                ensureTextBlock();
                controller.enqueue(event("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text },
                }));
                index += text.length;
              }
              for (const call of delta.tool_calls || []) {
                stopReason = "tool_use";
                const callIndex = Number(call.index || 0);
                if (!toolBlocks.has(callIndex)) {
                  if (textBlockOpen) {
                    controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
                    textBlockOpen = false;
                  }
                  if (thinkingBlockOpen) {
                    closeThinkingBlock();
                  }
                  blockIndex += 1;
                  toolBlocks.set(callIndex, blockIndex);
                  controller.enqueue(event("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: {
                      type: "tool_use",
                      id: ensureToolUseId(call.id),
                      name: call.function?.name,
                      input: {},
                    },
                  }));
                }
                const toolBlockIndex = toolBlocks.get(callIndex)!;
                const partialJson = call.function?.arguments || "";
                if (partialJson) {
                  controller.enqueue(event("content_block_delta", {
                    type: "content_block_delta",
                    index: toolBlockIndex,
                    delta: { type: "input_json_delta", partial_json: partialJson },
                  }));
                }
              }
              if (finishReason === "tool_calls") {
                stopReason = "tool_use";
                for (const toolBlockIndex of toolBlocks.values()) {
                  if (!closedToolBlocks.has(toolBlockIndex)) {
                    controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: toolBlockIndex }));
                    closedToolBlocks.add(toolBlockIndex);
                  }
                }
              } else if (finishReason) {
                // length → max_tokens; content_filter/refusal/stop → end_turn.
                // (Has-tool-calls path already set tool_use above and wins.)
                stopReason = mapFinishReasonToStopReason(finishReason, false, "");
              }
            } catch {
              // ignore malformed upstream stream chunk
            }
          }
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (textBlockOpen) controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
        if (thinkingBlockOpen) closeThinkingBlock();
        for (const toolBlockIndex of toolBlocks.values()) {
          if (!closedToolBlocks.has(toolBlockIndex)) {
            controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: toolBlockIndex }));
          }
        }
        const outputTokens = usageFromUpstream.completion_tokens > 0
          ? usageFromUpstream.completion_tokens
          : Math.max(1, Math.ceil(index / 4));
        const inputTokens = usageFromUpstream.prompt_tokens > 0
          ? usageFromUpstream.prompt_tokens
          : estimatedInputTokens;
        controller.enqueue(event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }));
        controller.enqueue(event("message_stop", { type: "message_stop" }));
        controller.close();
      }
    },
  });
}
