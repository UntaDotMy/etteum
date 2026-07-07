/**
 * Cursor (Connect proto) response → OpenAI translator (F12).
 *
 * Ported from 9router open-sse/translator/response/cursor-to-openai.js. Cursor's
 * Connect-proto response is converted to OpenAI shape at the executor/provider
 * level (the proto→SSE/JSON transform happens before this translator runs), so
 * this is a passthrough boundary translator — it validates + forwards OpenAI
 * chunks, used by the MITM Cursor handler + translator playground.
 *
 * NOTE: a full Cursor request translator (OpenAI→Connect-proto) is the executor's
 * responsibility (protobuf encoding) and is provider-specific; the response
 * direction is passthrough, mirroring the reference.
 */
import type { ChatCompletionResponse } from "../providers/base";

/**
 * Pass a Cursor response/chunk through as OpenAI shape. The Cursor executor
 * already emits OpenAI format; this validates + returns it. Non-OpenAI input
 * (raw proto) is best-effort wrapped as a content delta.
 */
export function cursorResponseToOpenAI(chunk: any): any | null {
  if (!chunk) return null;
  // Already OpenAI chat-completion chunk or completion → return as-is.
  if ((chunk.object === "chat.completion.chunk" || chunk.object === "chat.completion") && Array.isArray(chunk.choices)) {
    return chunk;
  }
  // Fallback: wrap a raw string/object as a content delta chunk.
  const text = typeof chunk === "string" ? chunk : (chunk.text || chunk.content || "");
  if (!text) return null;
  return {
    id: `chatcmpl-cursor-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: chunk.model || "cursor",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

/** Cursor stream passthrough — the executor already emits OpenAI SSE; forward as-is. */
export function cursorStreamToOpenAIStream(cursorStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return cursorStream;
}

/** Cursor non-stream response passthrough. */
export function cursorResponseToOpenAICompletion(resp: any, model: string): ChatCompletionResponse {
  if (resp && resp.object === "chat.completion" && Array.isArray(resp.choices)) return resp as ChatCompletionResponse;
  const text = typeof resp === "string" ? resp : (resp?.text || resp?.content || "");
  return {
    id: `chatcmpl-cursor-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  } as ChatCompletionResponse;
}
