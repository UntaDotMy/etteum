/**
 * Agent loop for the shimmed `web_search` server tool.
 *
 * Anthropic's server-side web_search executes on Anthropic's servers between
 * model turns. We replicate it locally: the proxy converts the server tool
 * into a regular OpenAI function tool (`web_search`), runs the model, and when
 * the model calls `web_search` we execute the search via the open-source
 * backend, inject the result, and re-run — looping until the model produces a
 * final answer. The final Anthropic response carries `server_tool_use` +
 * `web_search_tool_result` blocks so the client renders native search results.
 *
 * The loop wraps at the request edge (called from /v1/messages) and calls the
 * existing `handleChatCompletion` for each iteration — so pooling, retry,
 * quota, and logging all work unchanged.
 *
 * STREAMING: we keep ONE SSE output stream open across multiple upstream
 * calls. We do NOT emit a real `pause_turn`+`message_stop` to the client
 * (the client asked for the server-side tool and cannot send a tool_result
 * for our internal function tool). Instead we emit the
 * `server_tool_use`/`web_search_tool_result` blocks inline and continue the
 * same logical Anthropic message into the next upstream iteration.
 */

import type { ChatCompletionRequest } from "../providers/base";
import type { AnthropicMessagesRequest } from "../transforms/anthropic";
import { searchWeb, type WebSearchResult } from "./web-search";
import { config } from "../../config";
import { safeJsonParse } from "../../utils/safe-json";

const WEB_SEARCH_FN_NAME = "web_search";
// Agent-driven: high ceiling, not a low fixed cap. Bounds cost/abuse; the 2-min
// overall timeout is the other backstop. Override default via WEB_SEARCH_MAX_USES.
const DEFAULT_MAX_USES = 50;
const HARD_MAX_USES = 50;
const OVERALL_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 10_000;

/** The OpenAI function tool we inject so the upstream model can "call" search. */
function webSearchFunctionTool() {
  return {
    type: "function",
    function: {
      name: WEB_SEARCH_FN_NAME,
      description:
        "Search the web for current information. Call this when the user asks about recent events, current prices, news, or anything outside your training data. Returns search results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  };
}

/** System instruction nudging the model to use the web_search tool. */
function webSearchSystemInstruction(maxUses: number): string {
  return [
    "You have access to a `web_search` tool. Use it whenever the user's request depends on current, changing, or recent information (news, prices, events, people, products).",
    "Do NOT search for stable knowledge (math, science fundamentals, coding concepts, creative writing).",
    "You decide how many searches this turn needs: search as many times as is genuinely useful, and stop as soon as you have enough information to answer well.",
    `There is a hard ceiling of ${maxUses} searches per turn as a backstop. Each search returns all results the backend finds — read them before searching again.`,
    "After receiving search results, synthesize a final answer with citations to the result URLs.",
  ].join(" ");
}

/**
 * Detect a web_search_* server tool and read its max_uses (if any). When the
 * request omits max_uses, fall back to config.webSearchMaxUses (the
 * WEB_SEARCH_MAX_USES env var) so the operator — not a hardcoded constant —
 * controls the ceiling. Always clamped to HARD_MAX_USES.
 */
export function extractWebSearchConfig(
  tools: any[] | undefined,
): { present: boolean; maxUses: number } {
  if (!Array.isArray(tools)) return { present: false, maxUses: 0 };
  for (const t of tools) {
    if (t && typeof t === "object" && typeof t.type === "string" && t.type.startsWith("web_search_")) {
      const fromReq = Number(t.max_uses);
      const fromCfg = config.webSearchMaxUses;
      // Resolution order: request max_uses, then env var, then default. Each
      // must be a positive finite number; malformed values fall through.
      const max =
        (Number.isFinite(fromReq) && fromReq > 0) ? fromReq
        : (Number.isFinite(fromCfg) && fromCfg > 0) ? fromCfg
        : DEFAULT_MAX_USES;
      return {
        present: true,
        maxUses: Math.min(Math.max(1, Math.floor(max)), HARD_MAX_USES),
      };
    }
  }
  return { present: false, maxUses: 0 };
}

/** Strip web_search_* server tools from an Anthropic request's tools array. */
export function stripWebSearchTools(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const kept = tools.filter(
    (t) => !(t && typeof t === "object" && typeof t.type === "string" && t.type.startsWith("web_search_")),
  );
  return kept.length > 0 ? kept : undefined;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function mapStopReason(finishReason: string | null | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_use";
  switch (finishReason) {
    case "length": return "max_tokens";
    default: return "end_turn";
  }
}

/** Build the OpenAI request for one loop iteration, merging our function tool. */
function buildIterationRequest(
  base: ChatCompletionRequest,
  messages: ChatCompletionRequest["messages"],
  maxUses: number,
  stream: boolean,
): ChatCompletionRequest {
  const existingTools = Array.isArray(base.tools) ? base.tools : [];
  // Avoid duplicate web_search tool entries across iterations.
  const tools = [
    ...existingTools.filter((t: any) => t?.function?.name !== WEB_SEARCH_FN_NAME),
    webSearchFunctionTool(),
  ];
  // Prepend the search instruction to the system message.
  const instr = webSearchSystemInstruction(maxUses);
  const messagesWithInstr = prependSystemInstruction(messages, instr);
  return {
    ...base,
    messages: messagesWithInstr,
    tools,
    stream,
  };
}

function prependSystemInstruction(
  messages: ChatCompletionRequest["messages"],
  instr: string,
): ChatCompletionRequest["messages"] {
  const first = messages[0];
  if (first && first.role === "system") {
    const sys = typeof first.content === "string" ? first.content : "";
    const merged = sys ? `${sys}\n\n${instr}` : instr;
    return [{ ...first, content: merged }, ...messages.slice(1)];
  }
  return [{ role: "system", content: instr }, ...messages];
}

/** Parse streamed tool_call arguments fragments into a final {query}. */
function parseWebSearchInput(args: string): { query: string } {
  try {
    const obj = safeJsonParse(args || "{}") ?? {};
    return { query: typeof obj.query === "string" ? obj.query : "" };
  } catch {
    return { query: "" };
  }
}

/** Convert a WebSearchResult to an Anthropic web_search_result block. */
function toResultBlock(r: WebSearchResult, index: number) {
  return {
    type: "web_search_result",
    url: r.url,
    title: r.title,
    page_age: r.pageAge ?? null,
    // Opaque citation token; clients pass it back unchanged. We store the
    // snippet here so the model has content context if the client surfaces it.
    encrypted_content: r.snippet ?? "",
    index,
  };
}

// ── Public API: run the loop ───────────────────────────────────────────────

export interface LoopRunners {
  /** Non-streaming completion. Returns the raw OpenAI ChatCompletion response. */
  runCompletion: (req: ChatCompletionRequest) => Promise<{ response: any }>;
  /** Streaming completion. Returns the raw OpenAI SSE ReadableStream + usage. */
  runStream: (req: ChatCompletionRequest) => Promise<{ stream: ReadableStream<Uint8Array> }>;
}

/**
 * Non-streaming loop. Returns a final Anthropic Messages response (the shape
 * `openAIToAnthropic` produces), augmented with server_tool_use +
 * web_search_tool_result blocks for every search executed.
 */
export async function runWebSearchLoopNonStreaming(
  anthropicRequest: AnthropicMessagesRequest,
  openAIRequest: ChatCompletionRequest,
  runners: LoopRunners,
): Promise<any> {
  const { maxUses } = extractWebSearchConfig(anthropicRequest.tools);
  const started = Date.now();
  let searches = 0;
  const searchBlocks: any[] = [];
  // Working message list grows with tool_use + tool_result across iterations.
  let messages = openAIRequest.messages;

  for (let iter = 0; iter < maxUses + 1; iter++) {
    if (Date.now() - started > OVERALL_TIMEOUT_MS) break;
    const req = buildIterationRequest(openAIRequest, messages, maxUses, false);
    const { response } = await runners.runCompletion(req);
    const choice = response?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls || [];
    const wsCall = (toolCalls as any[]).find(
      (c) => c?.function?.name === WEB_SEARCH_FN_NAME,
    );

    if (!wsCall) {
      // Final answer. Build the Anthropic response, then prepend search blocks.
      return finalizeNonStreaming(response, anthropicRequest, searchBlocks);
    }

    // Execute the search.
    const input = parseWebSearchInput(wsCall.function?.arguments || "");
    const outcome = await searchWeb(input.query);
    const results = outcome.results;
    searches++;
    const serverToolUseId = newId("srvtoolu");
    searchBlocks.push({
      server_tool_use: {
        type: "server_tool_use",
        id: serverToolUseId,
        name: "web_search",
        input: { query: input.query },
      },
      web_search_tool_result: {
        type: "web_search_tool_result",
        tool_use_id: serverToolUseId,
        content: results.map((r, i) => toResultBlock(r, i)),
      },
    });

    // Append the model's tool_use + our tool_result to the working messages.
    // On backend failure (outcome.error), tell the model the search service is
    // unavailable so it stops retrying and informs the user — instead of looping
    // on empty results as if no information exists.
    const toolResultContent = outcome.error
      ? JSON.stringify({ error: "web_search_unavailable", message: outcome.error })
      : JSON.stringify(results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet ?? "" })));
    messages = [
      ...messages,
      {
        role: "assistant",
        content: choice?.message?.content || "",
        tool_calls: toolCalls,
      },
      {
        role: "tool",
        tool_call_id: wsCall.id || serverToolUseId,
        content: toolResultContent,
      },
    ];
  }

  // Exhausted max_uses: run one final non-search pass to get an answer.
  const req = buildIterationRequest(openAIRequest, messages, 0, false);
  const { response } = await runners.runCompletion(req);
  return finalizeNonStreaming(response, anthropicRequest, searchBlocks);
}

function finalizeNonStreaming(response: any, request: AnthropicMessagesRequest, searchBlocks: any[]): any {
  const choice = response?.choices?.[0];
  const text = choice?.message?.content || "";
  const reasoning = choice?.message?.reasoning_content || "";
  const toolCalls = (choice?.message?.tool_calls || []).filter(
    (c: any) => c?.function?.name !== WEB_SEARCH_FN_NAME,
  );
  const finishReason = choice?.finish_reason;
  const content: any[] = [];

  // Emit server_tool_use + web_search_tool_result blocks FIRST (searches
  // happened before the final text).
  for (const sb of searchBlocks) {
    content.push(sb.server_tool_use);
    content.push(sb.web_search_tool_result);
  }
  // When thinking is not enabled, discard reasoning_content completely.
  // Do NOT add it to the text output - that's the leak we're fixing.
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    let input = call?.function?.arguments || {};
    if (typeof input === "string") {
      input = safeJsonParse(input, {}) ?? {};
    }
    content.push({ type: "tool_use", id: call.id, name: call?.function?.name, input });
  }
  const usage = response?.usage || {};
  return {
    id: response?.id?.replace(/^chatcmpl-/, "msg_") || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: response?.model || request.model,
    content: content.length > 0 ? content : [{ type: "text", text }],
    stop_reason: mapStopReason(finishReason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
  };
}

// ── Streaming loop ─────────────────────────────────────────────────────────

/**
 * Streaming loop. Returns ONE Anthropic SSE ReadableStream that spans all
 * upstream iterations: text deltas are forwarded live; when the model calls
 * `web_search` we emit `server_tool_use` + `web_search_tool_result` blocks
 * inline, run the search, and continue the SAME logical message with the next
 * upstream stream. The stream ends with a single message_delta+message_stop
 * on the final (non-search) iteration.
 */
export function runWebSearchLoopStreaming(
  anthropicRequest: AnthropicMessagesRequest,
  openAIRequest: ChatCompletionRequest,
  runners: LoopRunners,
): ReadableStream<Uint8Array> {
  const { maxUses } = extractWebSearchConfig(anthropicRequest.tools);
  const messageId = newId("msg");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const started = Date.now();

  // Per-message stream state (carried across iterations).
  let blockIndex = -1;
  let textBlockOpen = false;
  let outputTokens = 0;
  let inputTokens = 0;

  const event = (name: string, data: unknown) =>
    encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  function ensureTextBlock(controller: any) {
    if (textBlockOpen) return;
    blockIndex += 1;
    textBlockOpen = true;
    controller.enqueue(event("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    }));
  }

  function closeTextBlock(controller: any) {
    if (!textBlockOpen) return;
    controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    textBlockOpen = false;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      // Working conversation for the loop.
      let messages = openAIRequest.messages;
      let searches = 0;

      try {
        controller.enqueue(event("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: anthropicRequest.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }));

        heartbeat = setInterval(() => {
          try { controller.enqueue(event("ping", { type: "ping" })); }
          catch { if (heartbeat) clearInterval(heartbeat); }
        }, HEARTBEAT_MS);

        for (let iter = 0; iter < maxUses + 1; iter++) {
          if (Date.now() - started > OVERALL_TIMEOUT_MS) break;
          const req = buildIterationRequest(openAIRequest, messages, maxUses, true);
          const { stream } = await runners.runStream(req);

          // Consume this upstream stream; forward deltas, detect web_search calls.
          const reader = stream.getReader();
          let buffer = "";
          let finishReason: string | null = null;
          // Accumulate streaming tool_calls by index (OpenAI streams them in fragments).
          const toolCallAccum = new Map<number, { id?: string; name?: string; args: string }>();
          let modelText = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";
            for (const part of parts) {
              const payload = dataPayload(part);
              if (!payload || payload === "[DONE]") continue;
              let chunk: any;
              try { chunk = JSON.parse(payload); } catch { continue; }
              if (chunk?.error) continue;
              const choice = chunk?.choices?.[0];
              const delta = choice?.delta || {};
              if (chunk?.usage) {
                inputTokens = Number(chunk.usage.prompt_tokens || inputTokens);
                outputTokens = Number(chunk.usage.completion_tokens || outputTokens);
              }

              // Forward text + reasoning as text deltas.
              const text = delta.content || "";
              const reasoning = delta.reasoning_content || "";
              if (reasoning || text) {
                ensureTextBlock(controller);
                const out = reasoning + text;
                if (out) {
                  controller.enqueue(event("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "text_delta", text: out },
                  }));
                  outputTokens += Math.ceil(out.length / 4);
                  modelText += out;
                }
              }

              // Accumulate tool_calls (may arrive in fragments).
              for (const call of delta.tool_calls || []) {
                const idx = Number(call.index || 0);
                const prev = toolCallAccum.get(idx) || { id: undefined, name: undefined, args: "" };
                if (call.id) prev.id = call.id;
                if (call.function?.name) prev.name = call.function.name;
                if (call.function?.arguments) prev.args += call.function.arguments;
                toolCallAccum.set(idx, prev as any);
              }

              if (choice?.finish_reason) finishReason = choice.finish_reason;
            }
          }

          // After this upstream stream ends, check for a web_search call.
          const wsCall = [...toolCallAccum.values()].find((c) => c.name === WEB_SEARCH_FN_NAME);
          const otherCalls = [...toolCallAccum.values()].filter((c) => c.name && c.name !== WEB_SEARCH_FN_NAME);

          // Forward any non-web_search tool_calls as normal tool_use blocks.
          for (const call of otherCalls) {
            closeTextBlock(controller);
            blockIndex += 1;
            let input: any = call.args;
            if (typeof input === "string") {
              input = safeJsonParse(input, {}) ?? {};
            }
            // F15: sanitize the accumulated args for Windows backslash repair
            // before emitting as partial_json, so Claude Code doesn't see
            // corrupted JSON (C:\Users → C:\\Users).
            const rawJson = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
            const partialJson = (() => {
              if (!rawJson) return "";
              const parsed = safeJsonParse(rawJson);
              return parsed !== undefined ? JSON.stringify(parsed) : rawJson;
            })();
            controller.enqueue(event("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
            }));
            if (partialJson) {
              controller.enqueue(event("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: partialJson },
              }));
            }
            controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
          }

          if (!wsCall) {
            // Final answer — close out and end the stream.
            closeTextBlock(controller);
            const stopReason = mapStopReason(finishReason, otherCalls.length > 0);
            controller.enqueue(event("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { input_tokens: inputTokens, output_tokens: Math.max(1, outputTokens) },
            }));
            controller.enqueue(event("message_stop", { type: "message_stop" }));
            controller.close();
            return;
          }

          // Execute the search and emit server_tool_use + web_search_tool_result.
          searches++;
          const input = parseWebSearchInput(wsCall.args);
          const outcome = await searchWeb(input.query);
          const results = outcome.results;
          closeTextBlock(controller);

          const serverToolUseId = newId("srvtoolu");
          blockIndex += 1;
          controller.enqueue(event("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "server_tool_use",
              id: serverToolUseId,
              name: "web_search",
              input: { query: input.query },
            },
          }));
          controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));

          blockIndex += 1;
          controller.enqueue(event("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: serverToolUseId,
              content: results.map((r, i) => toResultBlock(r, i)),
            },
          }));
          controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));

          // Append the model's turn + tool_result to the working conversation.
          // On backend failure (outcome.error), tell the model the search service
          // is unavailable so it stops retrying and informs the user.
          const toolResultContent = outcome.error
            ? JSON.stringify({ error: "web_search_unavailable", message: outcome.error })
            : JSON.stringify(results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet ?? "" })));
          const allCalls = [...toolCallAccum.values()].map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args },
          }));
          messages = [
            ...messages,
            { role: "assistant", content: modelText || "", tool_calls: allCalls },
            {
              role: "tool",
              tool_call_id: wsCall.id || serverToolUseId,
              content: toolResultContent,
            },
          ];
        }

        // Exhausted max_uses without a final answer — end gracefully.
        closeTextBlock(controller);
        controller.enqueue(event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: Math.max(1, outputTokens) },
        }));
        controller.enqueue(event("message_stop", { type: "message_stop" }));
        controller.close();
      } catch (err) {
        try {
          controller.enqueue(event("error", {
            type: "error",
            error: { type: "api_error", message: err instanceof Error ? err.message : "web_search loop error" },
          }));
        } catch { /* client gone */ }
        try { controller.close(); } catch { /* */ }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    },
  });
}

function dataPayload(block: string): string | null {
  const lines = block.split("\n").filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return null;
  return lines
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
    .join("\n")
    .trim();
}
