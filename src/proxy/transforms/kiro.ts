/**
 * Kiro (AWS CodeWhisperer) response → OpenAI translator (F12).
 *
 * Ported from the reference proxy open-sse/translator/response/kiro-to-openai.js. Parses the
 * Kiro AWS-eventstream SSE events (assistantResponseEvent, codeEvent, etc.) into
 * OpenAI chat-completion chunks. Used by the MITM Kiro handler to convert an
 * intercepted Kiro response back to OpenAI shape for forwarding to the router.
 *
 * NOTE: the kiro *provider* (src/proxy/providers/kiro.ts) already translates
 * OpenAI→Kiro→OpenAI internally for the provider path; this module exposes the
 * response translation as a reusable transform for the MITM/translator path.
 */
import type { ChatCompletionResponse } from "../providers/base";

interface KiroTranslatorState {
  responseId: string;
  created: number;
  model: string;
  content: string;
  reasoning: string;
  toolCalls: any[];
  finishReason: string | null;
  usage?: any;
}

function newState(model: string): KiroTranslatorState {
  return {
    responseId: `chatcmpl-kiro-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: model || "kiro",
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
  };
}

/**
 * Parse one Kiro SSE event (string or pre-parsed object) + update state.
 * Returns an OpenAI chat.completion.chunk if the event produced a delta, else null.
 */
export function kiroEventToOpenAIChunk(raw: any, state: KiroTranslatorState): any | null {
  let data = raw;
  let eventType = "";
  if (typeof raw === "string") {
    const lines = raw.split("\n");
    let eventData = "";
    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith(":event-type:")) eventType = line.slice(12).trim();
      else if (line.startsWith("data:")) eventData = line.slice(5).trim();
      else if (line.trim() && !line.startsWith(":")) eventData = line.trim();
    }
    if (!eventData) return null;
    try { data = JSON.parse(eventData); } catch { return null; }
  }
  if (!data || typeof data !== "object") return null;
  eventType = eventType || data._eventType || data.eventType || "";

  const delta: any = {};
  let hasDelta = false;

  // assistantResponseEvent: the main text content stream.
  if (eventType === "assistantResponseEvent" || data.content) {
    const text = data.content || data.text || data.message || "";
    if (text) { state.content += text; delta.content = text; hasDelta = true; }
  }
  // codeEvent: code generation — treat as content.
  if (eventType === "codeEvent" || data.code) {
    const code = data.code || "";
    if (code) { state.content += code; delta.content = code; hasDelta = true; }
  }
  // Reasoning/thinking.
  if (data.reasoning || data.thinking) {
    const r = data.reasoning || data.thinking;
    state.reasoning += r; delta.reasoning_content = r; hasDelta = true;
  }
  // Tool call.
  if (data.toolCall || data.functionCall) {
    const tc = data.toolCall || data.functionCall;
    const idx = state.toolCalls.length;
    state.toolCalls.push({
      index: idx,
      id: tc.id || `call_${idx}`,
      type: "function",
      function: { name: tc.name || "", arguments: JSON.stringify(tc.args || tc.arguments || {}) },
    });
    delta.tool_calls = [{ index: idx, id: tc.id || `call_${idx}`, type: "function", function: { name: tc.name || "", arguments: JSON.stringify(tc.args || tc.arguments || {}) } }];
    hasDelta = true;
  }
  // Usage.
  if (data.usage || data.usageMetadata) {
    state.usage = data.usage || data.usageMetadata;
  }
  // Finish.
  if (eventType === "messageMetadataEvent" || data.usageMetadata || eventType.includes("End") || eventType.includes("Stop")) {
    state.finishReason = "stop";
  }

  if (!hasDelta && !state.finishReason) return null;

  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{
      index: 0,
      delta: hasDelta ? delta : {},
      finish_reason: state.finishReason || null,
    }],
  };
}

/**
 * Consume a Kiro SSE stream + emit an OpenAI SSE chunk stream.
 * Returns a ReadableStream<Uint8Array> of `data: {openai chunk}\n\n` lines.
 */
export function kiroStreamToOpenAIStream(kiroStream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = kiroStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state = newState(model);
  let sentRole = false;

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (state.finishReason) {
            const finalChunk = { id: state.responseId, object: "chat.completion.chunk", created: state.created, model: state.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const evt of events) {
          if (!evt.trim()) continue;
          const chunk = kiroEventToOpenAIChunk(evt, state);
          if (chunk) {
            if (!sentRole) { chunk.choices[0].delta.role = "assistant"; sentRole = true; }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
      }
    },
    cancel() { try { reader.cancel(); } catch { /* ignore */ } },
  });
}

/** Convert a non-streaming Kiro response (assembled) to an OpenAI chat-completion. */
export function kiroResponseToOpenAI(kiroResp: any, model: string): ChatCompletionResponse {
  const state = newState(model);
  // A non-stream Kiro response is typically an array of events or a single object.
  const events = Array.isArray(kiroResp) ? kiroResp : [kiroResp];
  for (const evt of events) kiroEventToOpenAIChunk(evt, state);

  const message: any = { role: "assistant", content: state.content || "" };
  if (state.reasoning) message.reasoning_content = state.reasoning;
  if (state.toolCalls.length > 0) message.tool_calls = state.toolCalls;

  return {
    id: state.responseId,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, message, finish_reason: state.finishReason || "stop" }],
    usage: state.usage ? {
      prompt_tokens: Number(state.usage.prompt_tokens ?? state.usage.promptTokenCount ?? 0),
      completion_tokens: Number(state.usage.completion_tokens ?? state.usage.candidatesTokenCount ?? 0),
      total_tokens: Number(state.usage.total_tokens ?? state.usage.totalTokenCount ?? 0),
    } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  } as ChatCompletionResponse;
}
