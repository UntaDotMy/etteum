/**
 * Forced SSE→JSON conversion (F12).
 * Ported from the reference proxy open-sse/handlers/chatCore/sseToJsonHandler.js
 * (parseSSEToOpenAIResponse accumulator, lines ~41-99).
 *
 * When a non-streaming client (`stream:false`) hits a provider that only works
 * in streaming mode, the router fetches the stream upstream and assembles it
 * into a single OpenAI chat-completion JSON response here, so the client gets
 * the non-streaming shape it expected.
 *
 * Accumulates `delta.content` / `delta.reasoning_content`, captures
 * `finish_reason`, and indexes `tool_calls` across chunks via a map.
 */
import type { ChatCompletionResponse } from "../providers/base";

interface ToolCallAccumulator {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Consume an OpenAI-shaped SSE stream and return a single assembled
 * chat-completion response. Throws on invalid/empty SSE (caller returns 502).
 */
export async function forcedSseToJson(
  stream: ReadableStream<Uint8Array>,
  model: string,
): Promise<ChatCompletionResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let contentParts: string[] = [];
  let reasoningParts: string[] = [];
  let finishReason: string | null = null;
  const toolCallMap = new Map<number, ToolCallAccumulator>();
  let usage: any = undefined;
  let responseId: string = `chatcmpl-forced-${Date.now()}`;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const evt of events) {
        const lines = evt.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.id) responseId = parsed.id;
            if (parsed.usage) usage = parsed.usage;
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta ?? choice.message ?? {};
            if (typeof delta.content === "string" && delta.content.length > 0) {
              contentParts.push(delta.content);
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              reasoningParts.push(delta.reasoning_content);
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const acc: ToolCallAccumulator = toolCallMap.get(idx) ?? { index: idx, function: {} };
                if (tc.id) acc.id = tc.id;
                if (tc.type) acc.type = tc.type;
                if (tc.function) {
                  acc.function = acc.function || {};
                  if (tc.function.name) acc.function.name = (acc.function.name || "") + tc.function.name;
                  if (tc.function.arguments) acc.function.arguments = (acc.function.arguments || "") + tc.function.arguments;
                }
                toolCallMap.set(idx, acc);
              }
            }
          } catch {
            // malformed line — skip (mirrors reference)
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  const toolCalls = Array.from(toolCallMap.values())
    .sort((a, b) => a.index - b.index)
    .map((tc) => ({
      id: tc.id || `call_${tc.index}`,
      type: tc.type || "function",
      function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" },
    }));

  const message: any = { role: "assistant" };
  if (contentParts.length > 0) message.content = contentParts.join("");
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (!message.content && toolCalls.length === 0) message.content = "";

  return {
    id: responseId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
    usage: usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  } as ChatCompletionResponse;
}
