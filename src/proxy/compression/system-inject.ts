/**
 * Shared system-prompt injector for OUTPUT-reducing prompt injections (F11).
 *
 * Ported from 9router `open-sse/rtk/systemInject.js`. Appends an instruction
 * into the request's system message, dispatching by shape:
 *   - Claude (`body.system` string | array of {type:"text"}): splice BEFORE the
 *     last `cache_control` block so the injection stays inside the cached prefix
 *     (critical — otherwise every injection busts the prompt cache).
 *   - OpenAI chat (`body.messages[]`): append to existing system/developer msg,
 *     or unshift a new one.
 *   - OpenAI Responses (`body.instructions` string / `body.input[]`): append.
 *
 * Our compression pipeline runs on the normalized OpenAI-shape request, but the
 * request may still carry a Claude-style `system` field when the client is
 * Anthropic-native (the transform layer reads it). We handle both shapes.
 */
import type { ChatCompletionRequest } from "../providers/base";

const SEP = "\n\n";

export type InjectionFormat = "openai" | "claude" | "gemini";

/** Detect the request's system-prompt shape. */
function detectFormat(body: ChatCompletionRequest & { system?: unknown; instructions?: unknown; input?: unknown }): InjectionFormat {
  if (body.system !== undefined) return "claude";
  if (typeof body.instructions === "string" || Array.isArray(body.input)) return "openai"; // Responses
  return "openai";
}

/**
 * Inject `prompt` into the request's system message in-place. No-op when there's
 * no system field and the shape is unrecognizable. Mirrors reference
 * injectSystemPrompt (systemInject.js:9-27).
 */
export function injectSystemPrompt(body: any, prompt: string, format?: InjectionFormat): void {
  if (!body || !prompt) return;
  const fmt = format ?? detectFormat(body);
  switch (fmt) {
    case "claude":
      injectClaudeSystem(body, prompt);
      return;
    case "gemini":
      injectGeminiSystem(body, prompt);
      return;
    default:
      injectMessagesSystem(body, prompt);
  }
}

// OpenAI-shaped: messages[] (chat) or input[] (responses) or instructions (responses string)
function injectMessagesSystem(body: any, prompt: string): void {
  if (typeof body.instructions === "string") {
    body.instructions = body.instructions ? `${body.instructions}${SEP}${prompt}` : prompt;
    return;
  }
  const arr = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
  if (!arr) return;
  const idx = arr.findIndex((m: any) => m && (m.role === "system" || m.role === "developer"));
  if (idx >= 0) {
    appendToOpenAIMessage(arr[idx], prompt);
  } else {
    arr.unshift({ role: "system", content: prompt });
  }
}

function appendToOpenAIMessage(msg: any, prompt: string): void {
  if (typeof msg.content === "string") {
    msg.content = `${msg.content}${SEP}${prompt}`;
  } else if (Array.isArray(msg.content)) {
    msg.content.push({ type: "input_text", text: prompt });
  } else {
    msg.content = prompt;
  }
}

// Claude shape: body.system as string | array of {type:"text", text}.
// Insert BEFORE the last cache_control block to stay in the cached prefix.
function injectClaudeSystem(body: any, prompt: string): void {
  if (typeof body.system === "string" && body.system.length > 0) {
    body.system = `${body.system}${SEP}${prompt}`;
    return;
  }
  if (Array.isArray(body.system)) {
    const block = { type: "text", text: prompt };
    let lastCacheIdx = -1;
    for (let i = body.system.length - 1; i >= 0; i--) {
      if (body.system[i]?.cache_control) { lastCacheIdx = i; break; }
    }
    if (lastCacheIdx >= 0) {
      body.system.splice(lastCacheIdx, 0, block);
    } else {
      body.system.push(block);
    }
    return;
  }
  body.system = prompt;
}

// Gemini shape: body.system_instruction | body.systemInstruction | body.request.systemInstruction
function injectGeminiSystem(body: any, prompt: string): void {
  const target = body.request && typeof body.request === "object" ? body.request : body;
  const useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction");
  const key = useSnake ? "system_instruction" : "systemInstruction";
  const sys = target[key];
  if (sys && Array.isArray(sys.parts)) {
    sys.parts.push({ text: prompt });
    return;
  }
  target[key] = { parts: [{ text: prompt }] };
}
