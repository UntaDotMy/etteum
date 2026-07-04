/**
 * OpenAI Responses API (`POST /v1/responses`) ↔ internal Chat Completions.
 *
 * The Responses API is OpenAI's newer stateless endpoint. The proxy's entire
 * provider pipeline speaks Chat Completions (`ChatCompletionRequest` /
 * `ChatCompletionResponse` / `chat.completion.chunk` streams), so this module
 * is a thin translation layer on the client boundary — the inverse of what the
 * Codex provider does when it calls OpenAI's `/responses` upstream.
 *
 * Non-streaming:  ResponsesApiRequest  →  ChatCompletionRequest  →  provider
 *                  ChatCompletionResponse  →  ResponsesApiResponse
 *
 * Streaming:       ResponsesApiRequest  →  ChatCompletionRequest  →  provider
 *                  chat.completion.chunk stream  →  response.* SSE stream
 *
 * Spec verified against OpenAI's "Migrate to the Responses API" guide, the
 * Responses create reference, and the streaming-events reference (July 2026).
 *
 * Scope note: the proxy is stateless w.r.t. conversation history — there is no
 * server-side response store. `previous_response_id` is accepted for client
 * compatibility (store:false semantics); multi-turn clients must replay prior
 * output items in `input`, which round-trip correctly through these transforms.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  StreamChunk,
} from "../providers/base";

/* ------------------------------------------------------------------ */
/* Request types                                                       */
/* ------------------------------------------------------------------ */

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

/** A content block inside a Responses message item. */
export type ResponsesContentBlock =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: string; [key: string]: unknown };

/** A message input item: role + content (string or content blocks). */
export interface ResponsesMessageItem {
  type?: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: string | ResponsesContentBlock[];
}

/** An assistant tool call replayed as an input item. */
export interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** A tool result replayed as an input item. */
export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | { type: string; [key: string]: unknown };

export interface ResponsesTextFormat {
  format?:
    | { type: "json_schema"; name?: string; schema?: Record<string, unknown>; strict?: boolean }
    | { type: "json_object" }
    | { type: "text" };
}

export interface ResponsesApiRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: ResponsesFunctionTool[];
  tool_choice?: any;
  reasoning?: { effort?: string; summary?: string };
  previous_response_id?: string;
  text?: ResponsesTextFormat["format"];
  /** Passed through for logging only (proxy is stateless). */
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Response types                                                      */
/* ------------------------------------------------------------------ */

export interface ResponsesMessageOutput {
  type: "message";
  id: string;
  status: "completed" | "in_progress" | "incomplete";
  role: "assistant";
  content: { type: "output_text"; text: string; annotations?: any[] }[];
}

export interface ResponsesFunctionCallOutput {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed" | "in_progress";
}

export interface ResponsesReasoningOutput {
  type: "reasoning";
  id: string;
  summary: { type: "summary_text"; text: string }[];
  content?: any[];
  encrypted_content?: string;
  status: "completed" | "in_progress";
}

export type ResponsesOutputItem =
  | ResponsesMessageOutput
  | ResponsesFunctionCallOutput
  | ResponsesReasoningOutput
  | { type: string; [key: string]: unknown };

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens: number };
  total_tokens: number;
}

export interface ResponsesApiResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "in_progress" | "incomplete" | "failed";
  output: ResponsesOutputItem[];
  usage: ResponsesUsage;
  /** Present when `previous_response_id` was supplied (echoed, store:false). */
  previous_response_id?: string | null;
  reasoning?: { effort: string | null; summary: string | null } | null;
}

/* ------------------------------------------------------------------ */
/* Request: Responses → Chat Completions                               */
/* ------------------------------------------------------------------ */

function isMessageItem(item: ResponsesInputItem): item is ResponsesMessageItem {
  return (
    (item.type === undefined || item.type === "message") &&
    "role" in item &&
    typeof (item as any).role === "string"
  );
}

function isFunctionCallItem(item: ResponsesInputItem): item is ResponsesFunctionCallItem {
  return item.type === "function_call";
}

function isFunctionCallOutputItem(item: ResponsesInputItem): item is ResponsesFunctionCallOutputItem {
  return item.type === "function_call_output";
}

/** Map a Responses content block array to Chat Completions content blocks. */
function mapContentToChat(
  content: string | ResponsesContentBlock[]
): string | any[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "input_text" || block.type === "output_text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "input_image") {
      return { type: "image_url", image_url: { url: (block as any).image_url } };
    }
    // Unknown block: pass through so providers can decide.
    return block;
  });
}

/** Map Responses (internally-tagged) function tools to Chat Completions (externally-tagged). */
function mapToolsToChat(
  tools?: ResponsesFunctionTool[]
): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: "object", properties: {} },
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
}

/** Map Responses `text.format` (structured outputs) to `response_format`. */
function mapTextFormatToResponseFormat(
  text?: ResponsesTextFormat["format"]
): any | undefined {
  if (!text) return undefined;
  if (text.type === "json_object") {
    return { type: "json_object" };
  }
  if (text.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        ...(text.name ? { name: text.name } : {}),
        schema: text.schema ?? { type: "object" },
        ...(text.strict !== undefined ? { strict: text.strict } : {}),
      },
    };
  }
  return undefined; // "text" or unknown → no constraint
}

/**
 * Convert a Responses API request into a Chat Completions request.
 *
 * Mapping rules (verified against OpenAI's migrate-to-responses guide):
 *   - `input` (string) → a single user message.
 *   - `input` (array):
 *       system/developer message item → a `system` message (developer is
 *         normalized to system by the router's sanitizeRequest downstream).
 *       user/assistant message item → message with mapped content blocks.
 *       function_call item → appended to the preceding assistant message's
 *         `tool_calls` (or a new assistant message) as
 *         `{id: call_id, type:"function", function:{name, arguments}}`.
 *       function_call_output item → `{role:"tool", tool_call_id, content:output}`.
 *   - `instructions` → prepended as a `system` message (before any system
 *     input items, matching OpenAI semantics where instructions are the
 *     primary system prompt).
 *   - `max_output_tokens` → `max_tokens`.
 *   - `reasoning.effort` → `reasoning_effort` + `thinking.effort`.
 *   - `text.format` → `response_format`.
 *   - `tools` (flat) → wrapped in `.function` (Chat Completions shape).
 */
export function responsesRequestToChat(
  req: ResponsesApiRequest
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // 1. Instructions become the leading system message.
  if (typeof req.instructions === "string" && req.instructions.length > 0) {
    messages.push({ role: "system", content: req.instructions });
  }

  // 2. String input → a single user message.
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (isMessageItem(item)) {
        const role = item.role === "developer" ? "system" : item.role;
        messages.push({
          role: role as ChatMessage["role"],
          content: mapContentToChat(item.content),
        });
      } else if (isFunctionCallItem(item)) {
        // Attach to the previous assistant message if possible, else create one.
        const last = messages[messages.length - 1];
        const toolCall = {
          id: item.call_id,
          type: "function" as const,
          function: { name: item.name, arguments: item.arguments },
        };
        if (last && last.role === "assistant") {
          last.tool_calls = [...(last.tool_calls ?? []), toolCall];
        } else {
          messages.push({
            role: "assistant",
            content: last && last.role === "assistant" ? last.content : "",
            tool_calls: [toolCall],
          });
        }
      } else if (isFunctionCallOutputItem(item)) {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
      } else {
        // Unknown item type — best-effort: if it carries role+content, treat
        // as a message; otherwise drop (don't throw, mirror lenient callers).
        const anyItem = item as any;
        if (typeof anyItem.role === "string") {
          messages.push({
            role: anyItem.role === "developer" ? "system" : anyItem.role,
            content: mapContentToChat(anyItem.content ?? ""),
          });
        }
      }
    }
  }

  const out: ChatCompletionRequest = {
    model: req.model,
    messages,
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.max_output_tokens !== undefined
      ? { max_tokens: req.max_output_tokens }
      : {}),
    ...(mapToolsToChat(req.tools) ? { tools: mapToolsToChat(req.tools) } : {}),
    ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
  };

  if (req.reasoning?.effort) {
    out.reasoning_effort = req.reasoning.effort;
    out.thinking = { type: "enabled", effort: req.reasoning.effort };
  }

  const responseFormat = mapTextFormatToResponseFormat(req.text);
  if (responseFormat) {
    (out as any).response_format = responseFormat;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Response: Chat Completions → Responses (non-streaming)              */
/* ------------------------------------------------------------------ */

let responseCounter = 0;
/** Deterministic response id (Date.now/Math.random are fine here — this is a
 *  real HTTP server context, not the workflow sandbox). */
function makeResponseId(): string {
  const ts = Date.now().toString(36);
  const n = (responseCounter++).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `resp_${ts}${n}${rand}`;
}

function finishReasonToStatus(
  finishReason: string | null | undefined
): ResponsesApiResponse["status"] {
  if (finishReason === "length") return "incomplete";
  if (finishReason === "content_filter") return "incomplete";
  return "completed";
}

/**
 * Convert a Chat Completions response into a Responses API response object.
 */
export function chatResponseToResponses(
  resp: ChatCompletionResponse,
  model: string
): ResponsesApiResponse {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  const output: ResponsesOutputItem[] = [];

  // Assistant text message.
  if (msg) {
    const textParts: { type: "output_text"; text: string; annotations?: any[] }[] = [];
    if (typeof msg.content === "string") {
      if (msg.content.length > 0) {
        textParts.push({ type: "output_text", text: msg.content, annotations: [] });
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === "text" && typeof block.text === "string") {
          textParts.push({ type: "output_text", text: block.text, annotations: [] });
        }
      }
    }

    // Only emit a message item if there is text content. (If the assistant
    // only made tool calls, the message item would be empty — skip it, like
    // OpenAI does for tool-call-only turns.)
    if (textParts.length > 0) {
      output.push({
        type: "message",
        id: `msg_${makeResponseId().slice(5)}`,
        status: "completed",
        role: "assistant",
        content: textParts,
      });
    }

    // Function calls → function_call output items.
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        output.push({
          type: "function_call",
          id: `fc_${makeResponseId().slice(5)}`,
          call_id: tc.id ?? `call_${makeResponseId().slice(5)}`,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
          status: "completed",
        });
      }
    }
  }

  const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const reasoningTokens =
    (usage as any).completion_tokens_details?.reasoning_tokens ?? 0;
  const cachedTokens = (usage as any).prompt_tokens_details?.cached_tokens ?? 0;

  return {
    id: resp.id?.startsWith("resp_") ? resp.id : makeResponseId(),
    object: "response",
    created_at: resp.created ?? Math.floor(Date.now() / 1000),
    model: resp.model ?? model,
    status: finishReasonToStatus(choice?.finish_reason),
    output,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: cachedTokens },
      output_tokens: usage.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Response: Chat Completions stream → Responses SSE stream            */
/* ------------------------------------------------------------------ */

function ssePack(event: string, data: unknown): Uint8Array {
  const json = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

interface ParsedChunk {
  type?: string;
  id?: string;
  created?: number;
  model?: string;
  choices?: StreamChunk["choices"];
  usage?: StreamChunk["usage"];
}

/** Parse one `data: {...}` SSE line into a chat.completion.chunk, or null. */
function parseChatSseLine(line: string): ParsedChunk | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as ParsedChunk;
  } catch {
    return null;
  }
}

/**
 * Wrap a `chat.completion.chunk` SSE byte stream as a Responses-API
 * `response.*` SSE byte stream.
 *
 * Emits the full event lifecycle for the common case (text + tool calls):
 *   response.created → response.in_progress
 *   → (per output item) response.output_item.added → response.content_part.added
 *     → response.output_text.delta* → response.output_text.done
 *     → response.content_part.done → response.output_item.done
 *   → response.completed
 *
 * Tool-call argument deltas use response.function_call_arguments.delta/.done.
 */
export function chatStreamToResponsesStream(
  chatStream: ReadableStream<Uint8Array>,
  model: string,
  responseId: string,
  createdAt: number
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  // Accumulated state for the final response.completed event.
  let textAccum = "";
  const toolCalls: {
    index: number;
    id?: string;
    name?: string;
    arguments: string;
  }[] = [];
  let finalUsage: ResponsesUsage | null = null;
  let lastModel = model;

  // Output indices: message is 0, tool calls follow.
  let messageItemEmitted = false;
  const messageItemId = `msg_${responseId.slice(5)}`;
  const toolCallItemIds: string[] = [];

  let buffer = "";

  return new ReadableStream<Uint8Array>({
    // `start` must NOT block on the source read loop — Bun won't deliver
    // enqueued chunks to the consumer until `start` returns. So we kick off
    // the async processing here without awaiting it; the IIFE enqueues and
    // closes the controller on its own.
    start(controller) {
      const reader = chatStream.getReader();
      const emit = (event: string, data: unknown) =>
        controller.enqueue(ssePack(event, data));

      const responseSkeleton = (status: string) => ({
        id: responseId,
        object: "response",
        created_at: createdAt,
        model: lastModel,
        status,
        output: [],
        usage: null,
      });

      void (async () => {
      try {
        // Lifecycle open.
        emit("response.created", responseSkeleton("in_progress"));
        emit("response.in_progress", responseSkeleton("in_progress"));

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const chunk = parseChatSseLine(line);
            if (!chunk) continue;
            if (chunk.model) lastModel = chunk.model;
            if (chunk.usage) {
              const u = chunk.usage;
              finalUsage = {
                input_tokens: u.prompt_tokens ?? 0,
                input_tokens_details: { cached_tokens: (u as any).prompt_tokens_details?.cached_tokens ?? 0 },
                output_tokens: u.completion_tokens ?? 0,
                output_tokens_details: { reasoning_tokens: (u as any).completion_tokens_details?.reasoning_tokens ?? 0 },
                total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
              };
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta;

            // Text deltas.
            if (delta) {
              if (typeof delta.content === "string" && delta.content.length > 0) {
                if (!messageItemEmitted) {
                  messageItemEmitted = true;
                  emit("response.output_item.added", {
                    output_index: 0,
                    item: { type: "message", id: messageItemId, status: "in_progress", role: "assistant", content: [] },
                  });
                  emit("response.content_part.added", {
                    item_id: messageItemId,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  });
                }
                textAccum += delta.content;
                emit("response.output_text.delta", {
                  item_id: messageItemId,
                  output_index: 0,
                  content_index: 0,
                  delta: delta.content,
                });
              }

              // Tool call deltas.
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = typeof tc.index === "number" ? tc.index : 0;
                  let entry = toolCalls.find((t) => t.index === idx);
                  if (!entry) {
                    entry = { index: idx, arguments: "" };
                    toolCalls.push(entry);
                    const outputIndex = 1 + idx; // message is 0
                    const itemId = `fc_${responseId.slice(5)}_${idx}`;
                    toolCallItemIds[idx] = itemId;
                    emit("response.output_item.added", {
                      output_index: outputIndex,
                      item: {
                        type: "function_call",
                        id: itemId,
                        call_id: tc.id ?? `call_${responseId.slice(5)}_${idx}`,
                        name: tc.function?.name ?? "",
                        arguments: "",
                        status: "in_progress",
                      },
                    });
                  }
                  if (tc.id && !entry.id) entry.id = tc.id;
                  if (tc.function?.name && !entry.name) entry.name = tc.function.name;
                  if (typeof tc.function?.arguments === "string") {
                    entry.arguments += tc.function.arguments;
                    emit("response.function_call_arguments.delta", {
                      item_id: toolCallItemIds[idx],
                      output_index: 1 + idx,
                      delta: tc.function.arguments,
                    });
                  }
                }
              }
            }
          }
        }

        // Flush any trailing buffered line.
        const tail = buffer.trim();
        if (tail) {
          const chunk = parseChatSseLine(tail);
          if (chunk?.usage) {
            const u = chunk.usage;
            finalUsage = {
              input_tokens: u.prompt_tokens ?? 0,
              input_tokens_details: { cached_tokens: (u as any).prompt_tokens_details?.cached_tokens ?? 0 },
              output_tokens: u.completion_tokens ?? 0,
              output_tokens_details: { reasoning_tokens: (u as any).completion_tokens_details?.reasoning_tokens ?? 0 },
              total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
            };
          }
        }

        // Close the message item if it was opened.
        if (messageItemEmitted) {
          emit("response.output_text.done", {
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            text: textAccum,
          });
          emit("response.content_part.done", {
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: textAccum, annotations: [] },
          });
          emit("response.output_item.done", {
            output_index: 0,
            item: {
              type: "message",
              id: messageItemId,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: textAccum, annotations: [] }],
            },
          });
        }

        // Close tool-call items.
        for (const tc of toolCalls) {
          const outputIndex = 1 + tc.index;
          const itemId = toolCallItemIds[tc.index] ?? `fc_${responseId.slice(5)}_${tc.index}`;
          emit("response.function_call_arguments.done", {
            item_id: itemId,
            output_index: outputIndex,
            arguments: tc.arguments,
          });
          emit("response.output_item.done", {
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: itemId,
              call_id: tc.id ?? `call_${responseId.slice(5)}_${tc.index}`,
              name: tc.name ?? "",
              arguments: tc.arguments,
              status: "completed",
            },
          });
        }

        // Assemble final output for response.completed.
        const output: ResponsesOutputItem[] = [];
        if (messageItemEmitted) {
          output.push({
            type: "message",
            id: messageItemId,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: textAccum, annotations: [] }],
          });
        }
        for (const tc of toolCalls) {
          output.push({
            type: "function_call",
            id: toolCallItemIds[tc.index] ?? `fc_${responseId.slice(5)}_${tc.index}`,
            call_id: tc.id ?? `call_${responseId.slice(5)}_${tc.index}`,
            name: tc.name ?? "",
            arguments: tc.arguments,
            status: "completed",
          });
        }

        const usage: ResponsesUsage = finalUsage ?? {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 0,
        };

        emit("response.completed", {
          id: responseId,
          object: "response",
          created_at: createdAt,
          model: lastModel,
          status: "completed",
          output,
          usage,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit("response.failed", {
          id: responseId,
          object: "response",
          created_at: createdAt,
          model: lastModel,
          status: "failed",
          error: { type: "api_error", message },
          output: [],
          usage: null,
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by client cancel.
        }
      }
      })(); // end async IIFE
    },
    async cancel(reason) {
      // Best-effort; the source reader is released by GC. No-op is safe.
      void reason;
    },
  });
}

/** Helper for the endpoint: build a response id + created_at pair. */
export function newResponsesResponseMeta(): { id: string; createdAt: number } {
  return { id: makeResponseId(), createdAt: Math.floor(Date.now() / 1000) };
}
