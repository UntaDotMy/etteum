/**
 * Official Grok CLI ↔ cli-chat-proxy wire format (verified against CLI 0.2.106).
 *
 * Live catalog sets api_backend:"responses" for grok-4.5. Chat must go to
 * POST /v1/responses (not /chat/completions). Required headers from CLI docs:
 *   Authorization: Bearer <token>
 *   X-XAI-Token-Auth: xai-grok-cli
 *   x-grok-model-override: <model>
 * Plus version gate: x-grok-client-version (auto-resolved).
 */

import type { ChatCompletionRequest, ChatMessage } from "../base";
import { getGrokCliVersion } from "./oauth";

export type CliProxySurface = "grok-shell" | "grok-build";

export type CliProxyHeadersOpts = {
  /** Upstream model id for x-grok-model-override (omit when not routing chat). */
  modelOverride?: string;
  accept?: string;
  surface?: CliProxySurface;
  /** Default "grok-build" — matches CLI binary + image/probe surfaces. */
  identifier?: string;
};

/**
 * Headers every cli-chat-proxy request should send (CLI 0.2.106 parity).
 * Version is resolved dynamically — never hardcode a bump here.
 */
export async function buildCliProxyHeaders(
  bearer: string,
  opts: CliProxyHeadersOpts = {},
): Promise<Record<string, string>> {
  const cliVersion = await getGrokCliVersion();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Accept: opts.accept ?? "application/json",
    // Required by CLI docs — auth middleware treats token as CLI session.
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": cliVersion,
    "x-grok-client-surface": opts.surface ?? "grok-shell",
    "x-grok-client-identifier": opts.identifier ?? "grok-build",
  };
  if (opts.modelOverride) {
    headers["x-grok-model-override"] = opts.modelOverride;
  }
  return headers;
}

/** Map Chat Completions tools → Responses flat function tools. */
function mapToolsToResponses(tools: ChatCompletionRequest["tools"]): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t: any) => {
    if (t?.type === "function" && t.function) {
      return {
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        ...(t.function.strict != null ? { strict: t.function.strict } : {}),
      };
    }
    // Already Responses-shaped or non-function tool (e.g. image_generation).
    return t;
  });
}

/**
 * Map an internal (OpenAI chat-shaped) tool_choice to the Responses wire
 * shape. Chat shape nests the name ({type:"function", function:{name}});
 * Responses expects it flat ({type:"function", name}). Anthropic remnants
 * ({type:"tool", name}) map to the same flat function choice. Strings
 * ("auto"/"required"/"none") pass through.
 */
export function normalizeToolChoiceForResponses(toolChoice: unknown): unknown {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice !== "object") return toolChoice;
  const tc = toolChoice as any;
  if (tc.type === "function") {
    const name = tc.function?.name ?? tc.name;
    return typeof name === "string" && name ? { type: "function", name } : "auto";
  }
  if (tc.type === "tool" && typeof tc.name === "string" && tc.name) {
    return { type: "function", name: tc.name };
  }
  return tc;
}

function contentToInputBlocks(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: String(content ?? "") }];
  }
  const blocks: unknown[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as any;
    if (p.type === "text" && typeof p.text === "string") {
      blocks.push({ type: "input_text", text: p.text });
    } else if (p.type === "input_text" && typeof p.text === "string") {
      blocks.push(p);
    } else if (p.type === "image_url") {
      const url =
        typeof p.image_url === "string"
          ? p.image_url
          : typeof p.image_url?.url === "string"
            ? p.image_url.url
            : "";
      if (url) blocks.push({ type: "input_image", image_url: url });
    } else if (p.type === "input_image") {
      blocks.push(p);
    } else if (typeof p.text === "string") {
      blocks.push({ type: "input_text", text: p.text });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "input_text", text: "" }];
}

/**
 * Chat Completions request → CLI /v1/responses body.
 * Matches live cli-chat-proxy (model, input, stream, reasoning_effort, tools).
 */
export function chatToCliResponsesBody(
  request: ChatCompletionRequest,
  upstreamModel: string,
  opts?: { stream?: boolean; reasoningEffort?: string },
): Record<string, unknown> {
  const stream = opts?.stream ?? request.stream === true;
  const input: unknown[] = [];
  let instructions: string | undefined;

  for (const msg of request.messages ?? []) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as any[])
                .map((b) => (typeof b?.text === "string" ? b.text : ""))
                .join("")
            : String(msg.content ?? "");
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : "";
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id || `call_${Date.now()}`,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "",
        });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as any[])
                .map((b) => (typeof b?.text === "string" ? b.text : ""))
                .join("")
            : String(msg.content ?? "");
      input.push({
        type: "message",
        role: "assistant",
        content: text ? [{ type: "output_text", text }] : [],
      });
      continue;
    }

    // user
    input.push({
      type: "message",
      role: "user",
      content: contentToInputBlocks(msg.content),
    });
  }

  const body: Record<string, unknown> = {
    model: upstreamModel,
    input,
    stream,
    // Store so we can GET /v1/responses/{id} after stream if summary deltas
    // were omitted (common on free Build: reasoning runs, stream has no text).
    store: true,
  };
  if (instructions) body.instructions = instructions;

  // Responses API: reasoning is always-on for grok-4.5 (cannot disable). We
  // still send effort + summary so the surface streams a visible summary —
  // without `summary`, many builds run reasoning but emit no client-visible
  // text (only encrypted traces / empty summary arrays).
  const effortRaw =
    opts?.reasoningEffort ||
    request.reasoning_effort ||
    (request as any).thinking?.effort ||
    "high";
  const effort = String(effortRaw).toLowerCase().trim();
  if (effort && effort !== "none") {
    // Prefer the Responses-native shape. Docs: summary is auto|concise|detailed;
    // "detailed" is what the model is documented to return. Keep top-level
    // reasoning_effort as a non-standard alias some proxy builds still read.
    body.reasoning_effort = effort;
    body.reasoning = { effort, summary: "detailed" };
    // Encrypted traces unlock multi-turn continuity; also correlates with
    // summary population on some Build builds (see xAI generate-text docs).
    body.include = ["reasoning.encrypted_content"];
  }

  if (request.temperature != null) body.temperature = request.temperature;
  if (request.top_p != null) body.top_p = request.top_p;
  if (request.max_tokens != null) body.max_output_tokens = request.max_tokens;

  const tools = mapToolsToResponses(request.tools);
  if (tools) body.tools = tools;
  // tool_choice is only valid WITH tools — xAI rejects the request otherwise:
  // 400 invalid-argument "A tool_choice was set on the request but no tools
  // were specified." Attach it only when tools exist, in Responses shape.
  if (tools && request.tool_choice != null) {
    body.tool_choice = normalizeToolChoiceForResponses(request.tool_choice);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Reasoning text extraction (Responses SSE) — mirrors CodexProvider coverage
// ---------------------------------------------------------------------------

/** Flatten a summary/content part into plain text. */
export function textFromReasoningPart(part: unknown): string {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  if (typeof p.text === "string") return p.text;
  if (typeof p.summary_text === "string") return p.summary_text;
  if (typeof p.content === "string") return p.content;
  if (Array.isArray(p.content)) {
    return p.content.map((inner) => textFromReasoningPart(inner)).filter(Boolean).join("\n");
  }
  return "";
}

/** Full text from a reasoning output item (summary / content / text fields). */
export function extractReasoningItemText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const it = item as Record<string, unknown>;
  if (it.type != null && it.type !== "reasoning") return "";
  const bags = [it.summary, it.content, it.text, it.reasoning].flatMap((value) => {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  });
  return bags.map((part) => textFromReasoningPart(part)).filter(Boolean).join("\n");
}

/**
 * Streaming delta text for reasoning-related event types.
 * xAI docs: response.reasoning_text.delta | response.reasoning_summary_text.delta
 * Also accept response.reasoning.delta (OpenAI-compatible alias) and `text`.
 */
export function extractReasoningDelta(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, unknown>;
  const type = String(e.type || "");
  if (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta"
  ) {
    if (typeof e.delta === "string") return e.delta;
    if (typeof e.text === "string") return e.text;
  }
  return "";
}

/** Done-event full text (when deltas were skipped / empty). */
export function extractReasoningDoneText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, unknown>;
  const type = String(e.type || "");
  if (
    type === "response.reasoning_summary_text.done" ||
    type === "response.reasoning_summary_part.done" ||
    type === "response.reasoning_text.done"
  ) {
    if (typeof e.text === "string" && e.text) return e.text;
    const fromPart = textFromReasoningPart(e.part);
    if (fromPart) return fromPart;
  }
  return "";
}

/**
 * Convert cli-chat-proxy Responses SSE → OpenAI chat.completion.chunk SSE
 * (what the rest of the proxy pipeline expects).
 */
export function responsesSseToChatCompletionStream(
  upstream: ReadableStream<Uint8Array>,
  meta: {
    id: string;
    created: number;
    model: string;
    onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void;
    /**
     * When the stream finished with zero reasoning text, fetch the stored
     * Responses object (GET /v1/responses/{id}) — xAI often only attaches the
     * summary there (see docs response.output reasoning item).
     */
    fetchStoredReasoning?: (responseId: string) => Promise<string | null>;
  },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let roleSent = false;
  // True once any reasoning summary has been streamed (delta or completed item).
  let reasoningEmitted = false;
  // Per-output_index so we do not re-emit the same summary from done + completed.
  const reasoningByOutput = new Map<number, string>();
  // tool_call index by item_id for streaming function args
  const toolIndexByItem = new Map<string, number>();
  let nextToolIndex = 0;

  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finish_reason: string | null = null,
    usage?: Record<string, unknown>,
  ) => {
    const chunk: Record<string, unknown> = {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason }],
    };
    if (usage) chunk.usage = usage;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const ensureRole = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (roleSent) return;
    roleSent = true;
    emit(controller, { role: "assistant" });
  };

  const emitReasoning = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
    outputIndex = 0,
  ) => {
    if (!text) return;
    ensureRole(controller);
    reasoningEmitted = true;
    reasoningByOutput.set(outputIndex, `${reasoningByOutput.get(outputIndex) || ""}${text}`);
    emit(controller, { reasoning_content: text });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            let eventName = "";
            let dataPayload = "";
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataPayload += line.slice(5).trim();
            }
            if (!dataPayload || dataPayload === "[DONE]") continue;

            let data: any;
            try {
              data = JSON.parse(dataPayload);
            } catch {
              continue;
            }
            const type = (data.type || eventName || "") as string;
            // why: set GROK_DEBUG_SSE=1 to log every SSE event type cli-chat-proxy
            // emits, so unknown event names are observable.
            if (process.env.GROK_DEBUG_SSE) {
              console.log(`[grok-sse] ${type}`);
            }

            // Text content
            if (type === "response.output_text.delta" && typeof data.delta === "string") {
              ensureRole(controller);
              emit(controller, { content: data.delta });
              continue;
            }

            // Streaming reasoning deltas (xAI + OpenAI aliases)
            const reasoningDelta = extractReasoningDelta(data);
            if (reasoningDelta) {
              emitReasoning(controller, reasoningDelta, Number(data.output_index ?? 0));
              continue;
            }

            // Done events with full summary text (when deltas were empty)
            const doneText = extractReasoningDoneText(data);
            if (doneText) {
              const index = Number(data.output_index ?? 0);
              if (!reasoningByOutput.get(index)) {
                emitReasoning(controller, doneText, index);
              }
              continue;
            }

            // Reasoning / tool items on added|done
            if (type === "response.output_item.added" || type === "response.output_item.done") {
              const item = data.item;
              if (item?.type === "reasoning") {
                const index = Number(data.output_index ?? 0);
                const itemText = extractReasoningItemText(item);
                if (itemText && !reasoningByOutput.get(index)) {
                  emitReasoning(controller, itemText, index);
                }
                continue;
              }
              if (item?.type === "function_call") {
                ensureRole(controller);
                const itemId = String(item.id || item.call_id || `fc_${nextToolIndex}`);
                let idx = toolIndexByItem.get(itemId);
                if (idx == null && item.call_id) idx = toolIndexByItem.get(String(item.call_id));
                if (idx == null) {
                  idx = nextToolIndex++;
                  toolIndexByItem.set(itemId, idx);
                  if (item.call_id) toolIndexByItem.set(String(item.call_id), idx);
                }
                // Only emit start frame once (on added, or done if we never saw added).
                if (type === "response.output_item.added" || !item.arguments) {
                  emit(controller, {
                    tool_calls: [
                      {
                        index: idx,
                        id: item.call_id || itemId,
                        type: "function",
                        function: {
                          name: item.name || "",
                          arguments: typeof item.arguments === "string" ? item.arguments : "",
                        },
                      },
                    ],
                  });
                }
                continue;
              }
            }

            // Tool call argument deltas
            if (type === "response.function_call_arguments.delta") {
              ensureRole(controller);
              const itemId = String(data.item_id || "");
              let idx = toolIndexByItem.get(itemId);
              if (idx == null) {
                idx = nextToolIndex++;
                toolIndexByItem.set(itemId, idx);
              }
              emit(controller, {
                tool_calls: [
                  {
                    index: idx,
                    function: { arguments: typeof data.delta === "string" ? data.delta : "" },
                  },
                ],
              });
              continue;
            }

            // Completed — usage + finish
            if (type === "response.completed" || type === "response.failed") {
              // Fallback 1: summary only on the final reasoning output item.
              if (!reasoningEmitted) {
                const output: any[] = Array.isArray(data.response?.output) ? data.response.output : [];
                let summaryText = "";
                for (const item of output) {
                  if (item?.type === "reasoning") {
                    summaryText += extractReasoningItemText(item);
                  }
                }
                // Fallback 2: free Build often streams only final text + keepalives
                // while reasoning_tokens accrue. Retrieve the stored response —
                // docs show summary_text on GET /v1/responses/{id} even when
                // the stream never emitted reasoning_* deltas.
                if (!summaryText && meta.fetchStoredReasoning) {
                  const rid = String(
                    data.response?.id || data.id || data.response_id || "",
                  );
                  if (rid) {
                    try {
                      const fetched = await meta.fetchStoredReasoning(rid);
                      if (fetched) summaryText = fetched;
                    } catch {
                      /* best-effort */
                    }
                  }
                }
                if (summaryText) {
                  emitReasoning(controller, summaryText, 0);
                }
              }
              const usageRaw = data.response?.usage;
              let usageOut: Record<string, unknown> | undefined;
              if (usageRaw && typeof usageRaw === "object") {
                const prompt =
                  Number(usageRaw.input_tokens ?? usageRaw.prompt_tokens ?? 0) || 0;
                const completion =
                  Number(usageRaw.output_tokens ?? usageRaw.completion_tokens ?? 0) || 0;
                const reasoningTok = Number(
                  usageRaw.output_tokens_details?.reasoning_tokens ??
                    usageRaw.completion_tokens_details?.reasoning_tokens ??
                    0,
                );
                usageOut = {
                  prompt_tokens: prompt,
                  completion_tokens: completion,
                  total_tokens:
                    Number(usageRaw.total_tokens ?? prompt + completion) || prompt + completion,
                };
                if (reasoningTok > 0) {
                  (usageOut as any).completion_tokens_details = {
                    reasoning_tokens: reasoningTok,
                  };
                }
                meta.onUsage?.({ prompt_tokens: prompt, completion_tokens: completion });
                // Fallback 3: reasoning ran (tokens > 0) but no text was ever
                // returned — surface a short note so the Thinking panel is not empty.
                if (!reasoningEmitted && reasoningTok > 0) {
                  emitReasoning(
                    controller,
                    `_(Grok used ${reasoningTok} reasoning tokens; the Build surface did not return a readable reasoning summary for this account.)_`,
                    0,
                  );
                }
              }
              const finish =
                type === "response.failed"
                  ? "error"
                  : toolIndexByItem.size > 0
                    ? "tool_calls"
                    : "stop";
              emit(controller, {}, finish, usageOut);
              continue;
            }
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}
