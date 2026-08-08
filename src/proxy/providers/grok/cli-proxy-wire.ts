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
  };
  if (instructions) body.instructions = instructions;

  const effort =
    opts?.reasoningEffort ||
    request.reasoning_effort ||
    (request as any).thinking?.effort;
  if (effort && String(effort).toLowerCase() !== "none") {
    body.reasoning_effort = String(effort).toLowerCase();
    // why: Responses endpoints hide reasoning unless a summary is requested.
    // Verified live: reasoning ran but returned nothing until summary:"auto".
    body.reasoning = { effort: String(effort).toLowerCase(), summary: "auto" };
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
  },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let roleSent = false;
  // True once any reasoning summary has been streamed (delta or completed item).
  let reasoningEmitted = false;
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

            // Text content
            if (type === "response.output_text.delta" && typeof data.delta === "string") {
              ensureRole(controller);
              emit(controller, { content: data.delta });
              continue;
            }

            // Reasoning summary → reasoning_content (matches chat/completions shape)
            if (
              type === "response.reasoning_summary_text.delta" &&
              typeof data.delta === "string"
            ) {
              ensureRole(controller);
              reasoningEmitted = true;
              emit(controller, { reasoning_content: data.delta });
              continue;
            }

            // Tool call start
            if (type === "response.output_item.added" && data.item?.type === "function_call") {
              ensureRole(controller);
              const itemId = String(data.item.id || data.item.call_id || `fc_${nextToolIndex}`);
              const idx = nextToolIndex++;
              toolIndexByItem.set(itemId, idx);
              if (data.item.call_id) toolIndexByItem.set(String(data.item.call_id), idx);
              emit(controller, {
                tool_calls: [
                  {
                    index: idx,
                    id: data.item.call_id || itemId,
                    type: "function",
                    function: {
                      name: data.item.name || "",
                      arguments: typeof data.item.arguments === "string" ? data.item.arguments : "",
                    },
                  },
                ],
              });
              continue;
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
              // Fallback: some surfaces only carry the summary in the final
              // reasoning output item, not as deltas.
              if (!reasoningEmitted) {
                const output: any[] = Array.isArray(data.response?.output) ? data.response.output : [];
                let summaryText = "";
                for (const item of output) {
                  if (item?.type === "reasoning" && Array.isArray(item.summary)) {
                    for (const part of item.summary) {
                      if (part?.type === "summary_text" && typeof part.text === "string") {
                        summaryText += part.text;
                      }
                    }
                  }
                }
                if (summaryText) {
                  ensureRole(controller);
                  emit(controller, { reasoning_content: summaryText });
                }
              }
              const usageRaw = data.response?.usage;
              let usageOut: Record<string, unknown> | undefined;
              if (usageRaw && typeof usageRaw === "object") {
                const prompt =
                  Number(usageRaw.input_tokens ?? usageRaw.prompt_tokens ?? 0) || 0;
                const completion =
                  Number(usageRaw.output_tokens ?? usageRaw.completion_tokens ?? 0) || 0;
                usageOut = {
                  prompt_tokens: prompt,
                  completion_tokens: completion,
                  total_tokens:
                    Number(usageRaw.total_tokens ?? prompt + completion) || prompt + completion,
                };
                meta.onUsage?.({ prompt_tokens: prompt, completion_tokens: completion });
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
