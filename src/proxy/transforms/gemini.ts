/**
 * Gemini ↔ OpenAI translators (F12).
 *
 * The request direction (OpenAI→Gemini) already exists inline in the antigravity
 * provider (`openAIToGemini`). This module adds the MISSING reverse direction —
 * Gemini response → OpenAI chat-completion — so Gemini upstream responses can be
 * translated back to the OpenAI canonical shape at the client boundary (e.g. a
 * non-Antigravity client hitting a Gemini upstream, or the MITM forwarding a
 * Gemini `generateContent` response back as OpenAI).
 *
 * Ported from 9router open-sse/translator/response/gemini-to-openai.js.
 */
import type { ChatCompletionResponse } from "../providers/base";

/**
 * Convert a Gemini `generateContent` response to an OpenAI chat-completion.
 * Gemini shape: { candidates: [{ content: { parts: [{ text } | { functionCall }], role }, finishReason }], usageMetadata }
 */
export function geminiToOpenAI(geminiResp: any, model: string): ChatCompletionResponse {
  const candidate = geminiResp?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const finishReason = candidate?.finishReason;

  let text = "";
  const toolCalls: any[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (typeof part.text === "string") {
      text += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        index: toolCalls.length,
        id: `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: part.functionCall.name || "",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  const message: any = { role: "assistant", content: text || "" };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = geminiResp?.usageMetadata || {};
  const openaiFinish = mapGeminiFinishReason(finishReason);

  return {
    id: `chatcmpl-gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: openaiFinish }],
    usage: {
      prompt_tokens: Number(usage.promptTokenCount ?? 0),
      completion_tokens: Number(usage.candidatesTokenCount ?? 0),
      total_tokens: Number(usage.totalTokenCount ?? 0),
    },
  } as ChatCompletionResponse;
}

/** Map Gemini finishReason → OpenAI finish_reason. */
function mapGeminiFinishReason(reason?: string): string {
  switch (reason) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default: return "stop";
  }
}

/**
 * Convert a Gemini `streamGenerateContent` SSE stream into an OpenAI
 * chat-completion chunk stream. Each Gemini chunk carries `candidates[0].content.parts`
 * with `text` or `functionCall` deltas; emit OpenAI `delta` chunks.
 *
 * Returns a ReadableStream<Uint8Array> of `data: {openai chunk}\n\n` lines.
 */
export function geminiStreamToOpenAIStream(
  geminiStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = geminiStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkIndex = 0;

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        // Try to emit one OpenAI chunk per Gemini chunk already buffered.
        const evt = nextGeminiEvent();
        if (evt) {
          const openaiChunk = geminiChunkToOpenAI(evt, model, chunkIndex++);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining buffered event.
          const last = nextGeminiEvent();
          if (last) {
            const openaiChunk = geminiChunkToOpenAI(last, model, chunkIndex++);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() { try { reader.cancel(); } catch { /* ignore */ } },
  });

  /** Parse the next complete Gemini JSON event from the buffer; return it + trim. */
  function nextGeminiEvent(): any | null {
    // Gemini stream chunks are JSON objects, possibly newline- or array-separated.
    // Try to parse the first balanced JSON object in the buffer.
    const start = buffer.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < buffer.length; i++) {
      const ch = buffer[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const jsonStr = buffer.slice(start, i + 1);
          buffer = buffer.slice(i + 1);
          try { return JSON.parse(jsonStr); } catch { return null; }
        }
      }
    }
    return null; // incomplete object — wait for more data
  }
}

/** Convert one Gemini stream chunk → an OpenAI chat.completion.chunk. */
function geminiChunkToOpenAI(chunk: any, model: string, index: number): any {
  const candidate = chunk?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  let text = "";
  const toolCalls: any[] = [];
  for (const part of parts) {
    if (typeof part?.text === "string") text += part.text;
    else if (part?.functionCall) {
      toolCalls.push({
        index: toolCalls.length,
        function: {
          name: part.functionCall.name || "",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  const finishReason = candidate?.finishReason;
  const delta: any = {};
  if (text) delta.content = text;
  if (toolCalls.length > 0) delta.tool_calls = toolCalls;
  if (index === 0) delta.role = "assistant";
  return {
    id: `chatcmpl-gemini-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ? mapGeminiFinishReason(finishReason) : null }],
    ...(chunk?.usageMetadata ? {
      usage: {
        prompt_tokens: Number(chunk.usageMetadata.promptTokenCount ?? 0),
        completion_tokens: Number(chunk.usageMetadata.candidatesTokenCount ?? 0),
        total_tokens: Number(chunk.usageMetadata.totalTokenCount ?? 0),
      },
    } : {}),
  };
}
