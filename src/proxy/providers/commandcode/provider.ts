/**
 * Command Code provider — native integration with api.commandcode.ai
 *
 * Unlike BYOK (which points at the `/provider/v1` gateway that requires a
 * "Provider" or higher plan), this provider talks to the private
 * `/alpha/generate` NDJSON endpoint the CLI itself uses, so `user_...` keys
 * from any plan work.
 *
 * Protocol (mirrors 9router's CommandCodeExecutor):
 *   - POST https://api.commandcode.ai/alpha/generate
 *   - Auth: Authorization: Bearer user_...
 *   - Headers: x-session-id (uuid), x-command-code-version, x-cli-environment
 *   - Body: { threadId, memory, config, params: { model, messages, stream, ... } }
 *   - Response: AI SDK v5 NDJSON — one JSON event per line, no `data:` prefix:
 *       {"type":"start"} {"type":"start-step"}
 *       {"type":"reasoning-start","id"} {"type":"reasoning-delta","text"}
 *       {"type":"text-start","id"}     {"type":"text-delta","text"}
 *       {"type":"tool-input-start","id","toolName"} / -delta / -end
 *       {"type":"tool-call","toolCallId","toolName","input"}
 *       {"type":"finish-step","finishReason","usage"} {"type":"finish","totalUsage"}
 *       {"type":"error","error"}
 *
 * Streaming is always on upstream (forceStream); a non-streaming client request
 * is served by draining the NDJSON and assembling a single JSON completion.
 */

import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "../base";
import type { Account } from "../../../db/schema";
import { decrypt } from "../../../utils/crypto";
import { applyModelSpecs } from "../../model-specs";

// ============================================================================
// Catalog
// ============================================================================

export interface CommandCodeModelDef {
  /** Proxy-facing id (bare upstream id — no prefix; owned_by commandcode). */
  id: string;
  name: string;
  context_window: number;
  max_output: number;
  thinking: boolean;
  vision: boolean;
  /** USD per 1k tokens (mixed avg) — credit accounting. */
  creditRate: number;
}

/**
 * Models verified against the /alpha/generate endpoint for Go-plan keys
 * (same set 9router ships for the commandcode provider). Claude/GPT/frontier
 * models exist on higher plans but are not guaranteed for a Go key, so they
 * are intentionally omitted — surfacing them would produce upstream errors.
 */
export const COMMANDCODE_MODELS: CommandCodeModelDef[] = [
  // Specs verified against the canonical model-specs registry (model-specs.ts)
  // and openrouter.ai 2026-07. The registry wins at list time (applyModelSpecs);
  // these values are the pre-apply fallback.
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context_window: 1_000_000, max_output: 384_000, thinking: true, vision: false, creditRate: 0.004 },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_window: 1_000_000, max_output: 384_000, thinking: true, vision: false, creditRate: 0.001 },
  { id: "moonshotai/Kimi-K3", name: "Kimi K3", context_window: 1_048_576, max_output: 1_048_576, thinking: true, vision: true, creditRate: 0.002 },
  { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", context_window: 262_144, max_output: 98_304, thinking: true, vision: false, creditRate: 0.002 },
  { id: "moonshotai/Kimi-K2.7-Code-Highspeed", name: "Kimi K2.7 Code Highspeed", context_window: 262_144, max_output: 98_304, thinking: true, vision: false, creditRate: 0.002 },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", context_window: 262_144, max_output: 65_536, thinking: true, vision: true, creditRate: 0.002 },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", context_window: 164_000, max_output: 8_192, thinking: true, vision: true, creditRate: 0.002 },
  { id: "zai-org/GLM-5.2", name: "GLM 5.2", context_window: 1_000_000, max_output: 131_072, thinking: true, vision: true, creditRate: 0.002 },
  { id: "zai-org/GLM-5.2-Fast", name: "GLM 5.2 Fast", context_window: 1_000_000, max_output: 131_072, thinking: true, vision: true, creditRate: 0.001 },
  { id: "zai-org/GLM-5.1", name: "GLM 5.1", context_window: 198_000, max_output: 8_192, thinking: true, vision: true, creditRate: 0.002 },
  { id: "zai-org/GLM-5", name: "GLM 5", context_window: 200_000, max_output: 8_192, thinking: false, vision: false, creditRate: 0.002 },
  { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", context_window: 1_000_000, max_output: 65_536, thinking: false, vision: true, creditRate: 0.002 },
  { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", context_window: 1_000_000, max_output: 65_536, thinking: false, vision: true, creditRate: 0.002 },
  { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5", context_window: 196_000, max_output: 65_536, thinking: false, vision: false, creditRate: 0.002 },
  { id: "xiaomi/mimo-v2.5-pro", name: "MiMo v2.5 Pro", context_window: 1_050_000, max_output: 131_072, thinking: true, vision: true, creditRate: 0.002 },
  { id: "xiaomi/mimo-v2.5", name: "MiMo v2.5", context_window: 1_050_000, max_output: 131_072, thinking: true, vision: true, creditRate: 0.001 },
  { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview", context_window: 262_144, max_output: 65_536, thinking: true, vision: true, creditRate: 0.003 },
  { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus", context_window: 1_000_000, max_output: 65_536, thinking: true, vision: true, creditRate: 0.002 },
  { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", context_window: 1_000_000, max_output: 65_536, thinking: true, vision: true, creditRate: 0.003 },
  { id: "Qwen/Qwen3.7-Plus", name: "Qwen 3.7 Plus", context_window: 1_000_000, max_output: 65_536, thinking: true, vision: true, creditRate: 0.002 },
  { id: "Qwen/Qwen3.7-Flash", name: "Qwen 3.7 Flash", context_window: 1_000_000, max_output: 65_536, thinking: true, vision: true, creditRate: 0.0005 },
  { id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash", context_window: 262_144, max_output: 256_000, thinking: true, vision: true, creditRate: 0.0005 },
  { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash", context_window: 262_144, max_output: 65_536, thinking: true, vision: true, creditRate: 0.0005 },
  { id: "tencent/hy3-paid", name: "Tencent Hunyuan 3 Paid", context_window: 262_144, max_output: 128_000, thinking: true, vision: true, creditRate: 0.002 },
  { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash", context_window: 1_048_576, max_output: 65_536, thinking: true, vision: true, creditRate: 0.0005 },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", context_window: 1_048_576, max_output: 65_536, thinking: true, vision: true, creditRate: 0.0005 },
  { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", context_window: 1_048_576, max_output: 65_536, thinking: true, vision: true, creditRate: 0.00025 },
  { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", context_window: 1_048_576, max_output: 65_536, thinking: true, vision: true, creditRate: 0.00025 },
  { id: "sakana/fugu-ultra", name: "Sakana Fugu Ultra", context_window: 1_000_000, max_output: 128_000, thinking: true, vision: true, creditRate: 0.002 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "NVIDIA Nemotron 3 Ultra", context_window: 512_288, max_output: 16_384, thinking: true, vision: true, creditRate: 0.002 },
  { id: "thinkingmachines/inkling", name: "Inkling", context_window: 1_048_576, max_output: 65_536, thinking: true, vision: true, creditRate: 0.002 },
  { id: "thinkingmachines/inkling-small", name: "Inkling Small", context_window: 524_288, max_output: 65_536, thinking: true, vision: true, creditRate: 0.001 },
  { id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1 Free", context_window: 1_048_576, max_output: 131_072, thinking: true, vision: true, creditRate: 0 },
  { id: "inclusionai/ling-3.0-flash-free", name: "Ling 3.0 Flash Free", context_window: 262_144, max_output: 32_768, thinking: true, vision: true, creditRate: 0 },
  { id: "meta/muse-spark-1.1", name: "Muse Spark 1.1", context_window: 1_048_576, max_output: 65_536, thinking: true, vision: true, creditRate: 0.0005 },
  { id: "xai/grok-4.5", name: "Grok 4.5", context_window: 500_000, max_output: 65_536, thinking: true, vision: true, creditRate: 0.003 },
];

export const COMMANDCODE_MODEL_BY_ID: Record<string, CommandCodeModelDef> = Object.fromEntries(
  COMMANDCODE_MODELS.map((m) => [m.id.toLowerCase(), m]),
);

export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/alpha/generate";
export const COMMANDCODE_API_BASE = "https://api.commandcode.ai";
export const COMMANDCODE_CLI_ENV = "cli";

/**
 * The upstream `/alpha/generate` endpoint checks `x-command-code-version`
 * (the CLI's own version). The CLI gets its version from its npm package
 * (`npm view command-code versions` → dist-tag `latest`). Hardcoding a
 * version works until the CLI ships a new one, so we resolve the latest
 * from the npm registry with a long TTL cache and fall back to a sensible
 * pinned version when offline.
 */
const COMMANDCODE_VERSION_FALLBACK = "0.25.7";
const COMMANDCODE_VERSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let commandCodeVersionCache: { version: string; expiresAt: number } | null = null;

export async function resolveCommandCodeVersion(): Promise<string> {
  if (commandCodeVersionCache && commandCodeVersionCache.expiresAt > Date.now()) {
    return commandCodeVersionCache.version;
  }
  try {
    const res = await fetch("https://registry.npmjs.org/command-code", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return commandCodeVersionCache?.version ?? COMMANDCODE_VERSION_FALLBACK;
    const pkg = (await res.json()) as { "dist-tags"?: { latest?: string } };
    const latest = pkg?.["dist-tags"]?.latest;
    if (latest && /^\d+\.\d+\.\d+/.test(latest)) {
      commandCodeVersionCache = { version: latest, expiresAt: Date.now() + COMMANDCODE_VERSION_TTL_MS };
      return latest;
    }
  } catch {
    // offline / registry unreachable — keep the last-known or fallback
  }
  return commandCodeVersionCache?.version ?? COMMANDCODE_VERSION_FALLBACK;
}

/** One rolling usage window from /alpha/billing/credits → windowLimits. */
export interface CmcWindowLimit {
  used: number;
  cap: number;
  exceeded: boolean;
  resetAt: number;
}

// ============================================================================
// NDJSON → OpenAI translator (port of 9router commandcode-to-openai.js)
// ============================================================================

interface CmcStreamState {
  responseId: string;
  created: number;
  model: string;
  chunkIndex: number;
  toolIndex: number;
  toolIndexById: Map<string, number>;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  openText: boolean;
}

function ensureState(state: CmcStreamState, model: string): void {
  if (state.responseId) return;
  state.responseId = `chatcmpl-${Date.now()}`;
  state.created = Math.floor(Date.now() / 1000);
  state.model = model || "commandcode";
  state.chunkIndex = 0;
  state.toolIndex = 0;
  state.toolIndexById = new Map();
  state.finishReason = null;
  state.usage = null;
  state.openText = false;
}

function mapFinishReason(reason: string | undefined | null): string | null {
  if (!reason) return null;
  const r = String(reason).toLowerCase();
  if (r === "tool-calls" || r === "tool_use" || r.includes("tool")) return "tool_calls";
  if (r === "length" || r === "max-tokens" || r === "max_tokens") return "length";
  if (r === "error" || r === "error-step") return "stop";
  return "stop";
}

function extractUsage(raw: Record<string, unknown> | null | undefined): {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const input = typeof raw.inputTokens === "number" ? raw.inputTokens : 0;
  const output = typeof raw.outputTokens === "number" ? raw.outputTokens : 0;
  const total = typeof raw.totalTokens === "number" ? raw.totalTokens : input + output;
  if (input === 0 && output === 0 && total === 0) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

export function commandCodeEventToOpenAIChunk(
  rawEvent: string | Record<string, unknown>,
  state: CmcStreamState,
): StreamChunk[] | null {
  if (!rawEvent) return null;

  // Already-OpenAI chunk: pass through.
  if (typeof rawEvent === "object" && (rawEvent as { object?: string }).object === "chat.completion.chunk") {
    return [rawEvent as unknown as StreamChunk];
  }

  let event: Record<string, any> | null = null;
  if (typeof rawEvent === "string") {
    const line = rawEvent.trim();
    if (!line) return null;
    const json = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!json || json === "[DONE]") return null;
    try {
      event = JSON.parse(json);
    } catch {
      return null;
    }
  } else {
    event = rawEvent;
  }

  if (!event || typeof event !== "object" || !event.type) return null;

  ensureState(state, String(event.model || state.model || ""));

  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): StreamChunk => ({
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: delta as any, finish_reason: finishReason }],
  });

  const out: StreamChunk[] = [];

  switch (event.type) {
    case "text-delta": {
      const text = String(event.text ?? event.delta ?? "");
      if (!text) break;
      const delta = state.chunkIndex === 0 ? { role: "assistant", content: text } : { content: text };
      state.chunkIndex++;
      state.openText = true;
      out.push(makeChunk(delta));
      break;
    }
    case "reasoning-delta": {
      const text = String(event.text ?? "");
      if (!text) break;
      const delta = { reasoning_content: text } as Record<string, unknown>;
      if (state.chunkIndex === 0) {
        (delta as Record<string, unknown>).role = "assistant";
      }
      state.chunkIndex++;
      out.push(makeChunk(delta));
      break;
    }
    case "tool-input-start": {
      const id = String(event.id ?? event.toolCallId ?? `call_${state.toolIndex}`);
      let idx = state.toolIndexById.get(id);
      if (idx === undefined) {
        idx = state.toolIndex++;
        state.toolIndexById.set(id, idx);
      }
      const delta: Record<string, unknown> = {};
      if (state.chunkIndex === 0) delta.role = "assistant";
      delta.tool_calls = [{
        index: idx,
        id,
        type: "function",
        function: { name: String(event.toolName ?? ""), arguments: "" },
      }];
      state.chunkIndex++;
      out.push(makeChunk(delta));
      break;
    }
    case "tool-input-delta": {
      const id = String(event.id ?? event.toolCallId ?? "");
      const idx = state.toolIndexById.get(id);
      if (idx === undefined) break;
      const delta: Record<string, unknown> = {
        tool_calls: [{ index: idx, function: { arguments: String(event.delta ?? event.inputTextDelta ?? "") } }],
      };
      out.push(makeChunk(delta));
      break;
    }
    case "tool-call": {
      // Final consolidated tool call — only emit if we never saw tool-input-* deltas.
      const id = String(event.toolCallId ?? "");
      if (state.toolIndexById.has(id)) break;
      const idx = state.toolIndex++;
      state.toolIndexById.set(id, idx);
      const argsStr = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {});
      const delta: Record<string, unknown> = {};
      if (state.chunkIndex === 0) delta.role = "assistant";
      delta.tool_calls = [{
        index: idx,
        id,
        type: "function",
        function: { name: String(event.toolName ?? ""), arguments: argsStr },
      }];
      state.chunkIndex++;
      out.push(makeChunk(delta));
      break;
    }
    case "finish-step": {
      state.finishReason = mapFinishReason(event.finishReason);
      if (event.usage && typeof event.usage === "object") state.usage = event.usage;
      break;
    }
    case "finish": {
      const finishReason = state.finishReason || mapFinishReason(event.finishReason || "stop");
      const finalChunk = makeChunk({}, finishReason);
      const usage = extractUsage(event.totalUsage || state.usage);
      if (usage) finalChunk.usage = usage;
      out.push(finalChunk);
      break;
    }
    case "error": {
      const errVal = event.error ?? event.message ?? "unknown";
      const errStr = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
      out.push(makeChunk({ content: `\n\n[CommandCode error: ${errStr}]` }));
      out.push(makeChunk({}, "stop"));
      break;
    }
    default:
      // Silently ignore: start, start-step, reasoning-start, text-start,
      // text-end, provider-metadata, message-metadata, etc.
      break;
  }

  return out.length ? out : null;
}

// ============================================================================
// Provider
// ============================================================================

export class CommandCodeProvider extends BaseProvider {
  name = "commandcode";

  override ownsModel(model: string): boolean {
    return COMMANDCODE_MODEL_BY_ID[model.toLowerCase()] !== undefined;
  }

  supportedModels: ModelInfo[] = applyModelSpecs(
    COMMANDCODE_MODELS.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: Date.now(),
      owned_by: "commandcode",
      display_name: m.name,
      context_window: m.context_window,
      max_output: m.max_output,
      thinking: m.thinking,
      vision: m.vision,
      creditUnit: "token" as const,
      creditRate: m.creditRate,
      creditSource: "estimated" as const,
    })),
    // Spec registry keys are canonical bare ids (lowercase, no vendor path):
    // "moonshotai/Kimi-K3" → "kimi-k3", "Qwen/Qwen3.7-Max" → "qwen3.7-max".
    (m) => m.id.toLowerCase().slice(m.id.lastIndexOf("/") + 1),
  );

  /** The real API key lives in `password` (AES-256-GCM encrypted at rest). */
  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      return "";
    }
  }

  private async buildHeaders(account: Account, stream: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-session-id": crypto.randomUUID(),
      "x-command-code-version": await resolveCommandCodeVersion(),
      "x-cli-environment": COMMANDCODE_CLI_ENV,
    };
    const key = this.getApiKey(account);
    if (key) headers["Authorization"] = `Bearer ${key}`;
    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  /** Translate an OpenAI ChatCompletionRequest into the CommandCode envelope. */
  private buildRequestBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
    const messages = request.messages.map((msg: ChatMessage) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      return { role: msg.role === "tool" ? "tool" : msg.role, content };
    });

    const params: Record<string, unknown> = {
      model: request.model,
      messages,
      stream,
      max_tokens: request.max_tokens ?? 4096,
      temperature: request.temperature ?? 0.3,
    };
    if (request.tools?.length) params.tools = request.tools;
    if (request.top_p != null) params.top_p = request.top_p;

    const today = new Date().toISOString().slice(0, 10);
    return {
      threadId: crypto.randomUUID(),
      memory: "",
      config: {
        workingDir: process.cwd(),
        date: today,
        environment: process.platform,
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      params,
    };
  }

  private async doGenerate(account: Account, request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    const body = this.buildRequestBody(request, stream);
    return this.fetchWithTimeout(COMMANDCODE_BASE_URL, {
      method: "POST",
      headers: await this.buildHeaders(account, stream),
      body: JSON.stringify(body),
    });
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    if (!this.getApiKey(account)) return { success: false, error: "No API key" };

    try {
      // Upstream is streaming-only; for a non-stream client, drain the NDJSON
      // and assemble a single completion (matches forceStream semantics).
      const resp = await this.doGenerate(account, request, true);
      if (!resp.ok || !resp.body) {
        return this.errorFromResponse(resp);
      }

      const text = await resp.text();
      const lines = text.split("\n");
      const state: CmcStreamState = {
        responseId: "",
        created: 0,
        model: request.model,
        chunkIndex: 0,
        toolIndex: 0,
        toolIndexById: new Map(),
        finishReason: null,
        usage: null,
        openText: false,
      };
      let content = "";
      let reasoning = "";
      const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
      let finishReason: string | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
      let upstreamError: string | null = null;

      for (const line of lines) {
        const chunks = commandCodeEventToOpenAIChunk(line, state);
        if (!chunks) continue;
        for (const chunk of chunks) {
          const delta = chunk.choices?.[0]?.delta as Record<string, any> | undefined;
          if (delta) {
            if (typeof delta.content === "string") content += delta.content;
            if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                let existing = toolCalls.find((t) => t.id && t.id === tc.id);
                if (!existing) {
                  existing = { id: tc.id || `call_${toolCalls.length}`, type: "function", function: { name: "", arguments: "" } };
                  toolCalls.push(existing);
                }
                if (tc.function?.name) existing.function.name = tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }
            if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
            if (typeof (delta.content as string)?.startsWith === "function" && (delta.content as string).startsWith("[CommandCode error:")) {
              upstreamError = (delta.content as string).replace(/^\[CommandCode error: /, "").replace(/\]$/, "");
            }
          }
          if (chunk.usage) usage = chunk.usage;
        }
      }

      if (upstreamError && !content) {
        return { success: false, error: upstreamError };
      }

      const response: ChatCompletionResponse = {
        id: state.responseId || `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: state.created || Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          } as ChatMessage,
          finish_reason: finishReason,
        }],
        usage: {
          prompt_tokens: usage?.prompt_tokens ?? this.estimateMessagesTokens(request.messages),
          completion_tokens: usage?.completion_tokens ?? this.estimateTokens(content),
          total_tokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
        },
      };

      const promptTokens = response.usage.prompt_tokens;
      const completionTokens = response.usage.completion_tokens;
      return {
        success: true,
        response,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    if (!this.getApiKey(account)) return { success: false, error: "No API key" };

    try {
      const resp = await this.doGenerate(account, request, true);
      if (!resp.ok || !resp.body) {
        return this.errorFromResponse(resp);
      }

      const state: CmcStreamState = {
        responseId: "",
        created: 0,
        model: request.model,
        chunkIndex: 0,
        toolIndex: 0,
        toolIndexById: new Map(),
        finishReason: null,
        usage: null,
        openText: false,
      };
      const encoder = new TextEncoder();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const chunks = commandCodeEventToOpenAIChunk(trimmed, state);
                if (!chunks) continue;
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              }
            }
            if (buffer.trim()) {
              const chunks = commandCodeEventToOpenAIChunk(buffer.trim(), state);
              if (chunks) {
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              }
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try { controller.error(err); } catch { /* already errored */ }
          }
        },
        async cancel() {
          try { await reader.cancel().catch(() => {}); } catch { /* never throw */ }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async errorFromResponse(resp: Response): Promise<ProviderResult> {
    const text = await resp.text().catch(() => "");
    if (resp.status === 401) return { success: false, error: `expired: HTTP 401`, banned: false };
    if (resp.status === 403) return { success: false, error: `forbidden: HTTP 403`, banned: true };
    if (resp.status === 429) return { success: false, error: text || "Rate limited", rateLimited: true };
    return { success: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  /** Static keys — nothing to refresh. */
  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  /**
   * Fetch live credit balance + 5-hour/weekly window limits from
   * /alpha/billing/credits. The response has no orgId for personal accounts:
   *
   *   { credits: { monthlyCredits, purchasedCredits, freeCredits },
   *     windowLimits: { limited, exceeded,
   *       fiveHour: { used, cap, exceeded, resetAt },
   *       weekly:   { used, cap, exceeded, resetAt } } }
   *
   * Quota is reported in USD credits (1 credit = $1). We surface the 5-hour
   * window as quotaLimit/quotaRemaining (the tightest gate) and stash the full
   * windowLimits in `metadata` so the dashboard can render both bars.
   */
  private async fetchCreditsAndLimits(account: Account, signal?: AbortSignal): Promise<{
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    meta?: Record<string, unknown>;
    error?: string;
  }> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { error: "No API key" };

    try {
      const resp = await this.fetchWithTimeout(`${COMMANDCODE_API_BASE}/alpha/billing/credits`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }, undefined, signal);

      if (resp.status === 401) return { error: `expired: HTTP 401` };
      if (resp.status === 403) return { error: `banned: HTTP 403` };
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { error: `CommandCode credits HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }

      const data = (await resp.json().catch(() => null)) as {
        credits?: { monthlyCredits?: number; purchasedCredits?: number; freeCredits?: number };
        windowLimits?: {
          limited?: boolean;
          exceeded?: unknown;
          fiveHour?: CmcWindowLimit;
          weekly?: CmcWindowLimit;
        };
      } | null;

      const fiveHour = data?.windowLimits?.fiveHour;
      const weekly = data?.windowLimits?.weekly;
      const monthly = Number(data?.credits?.monthlyCredits ?? 0);
      const purchased = Number(data?.credits?.purchasedCredits ?? 0);
      const free = Number(data?.credits?.freeCredits ?? 0);

      // Persist the raw window limits so the dashboard can render both meters.
      const windowLimits = data?.windowLimits
        ? {
            limited: Boolean(data.windowLimits.limited),
            fiveHour: fiveHour ?? null,
            weekly: weekly ?? null,
            fetchedAt: new Date().toISOString(),
          }
        : null;
      const meta: Record<string, unknown> = {};
      if (windowLimits) meta.window_limits = windowLimits;
      meta.credits = { monthly, purchased, free, fetchedAt: new Date().toISOString() };

      // 5-hour window is the tightest gate — surface it as the account quota.
      const cap = Number(fiveHour?.cap ?? 0);
      const used = Number(fiveHour?.used ?? 0);
      const limit = cap > 0 ? cap : monthly + purchased + free;
      const remaining = Math.max(0, limit - used);
      const resetAt = typeof fiveHour?.resetAt === "number" && fiveHour.resetAt > 0
        ? new Date(fiveHour.resetAt)
        : null;

      return {
        quota: {
          limit,
          remaining,
          used,
          ...(resetAt ? { resetAt } : {}),
        },
        meta,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const { quota, error } = await this.fetchCreditsAndLimits(account, signal);
    if (error || !quota) return { success: false, error: error || "Quota fetch failed" };
    return { success: true, quota };
  }

  /**
   * Health probe: POST a 1-token generate and require a non-401/403 status.
   * A valid key on a Go plan returns 200 with NDJSON (even if the specific
   * model is unsupported, the auth itself passes). 401 → expired, 403 → banned.
   */
  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key" };
    }
    try {
      const resp = await this.fetchWithTimeout(COMMANDCODE_BASE_URL, {
        method: "POST",
        headers: await this.buildHeaders(account, true),
        body: JSON.stringify({
          threadId: crypto.randomUUID(),
          memory: "",
          config: {
            workingDir: process.cwd(),
            date: new Date().toISOString().slice(0, 10),
            environment: process.platform,
            structure: [],
            isGitRepo: false,
            currentBranch: "",
            mainBranch: "",
            gitStatus: "",
            recentCommits: [],
          },
          params: {
            model: COMMANDCODE_MODELS[0]!.id,
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            max_tokens: 1,
          },
        }),
      }, undefined, signal);

      if (resp.status === 401) {
        return { kind: "session_expired", success: false, error: "CommandCode key rejected (HTTP 401)" };
      }
      if (resp.status === 403) {
        return { kind: "banned", success: false, error: "CommandCode key forbidden (HTTP 403)" };
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { kind: "transient_error", success: false, retryable: true, error: `CommandCode probe HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }
      // Drain body (NDJSON) — keep the socket clean.
      await resp.text().catch(() => {});
      // Sync live credit balance + window limits (5h/weekly) so the warmup
      // runner persists quota columns + metadata for the dashboard.
      const { quota, meta } = await this.fetchCreditsAndLimits(account, signal);
      return {
        kind: "healthy",
        success: true,
        quota: quota
          ? { ...quota, source: "commandcode.fetchQuota" }
          : undefined,
        metadata: meta,
      };
    } catch (err) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: `CommandCode probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ============================================================================
// Account activation helper (used by the POST /api/accounts route)
// ============================================================================

export interface CommandCodeActivation {
  email: string;
  metadata: Record<string, unknown>;
}

/**
 * Validate a `user_...` key against /alpha/generate and derive a stable
 * email-like account label from the key tail. Throws on invalid keys so the
 * API route can surface a 400.
 */
export async function activateCommandCodeKey(apiKey: string): Promise<CommandCodeActivation> {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("user_")) {
    throw new Error("CommandCode API key must start with user_ (from ~/.commandcode/auth.json or commandcode.ai/studio)");
  }

  let resp: Response;
  try {
    resp = await fetch(COMMANDCODE_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": crypto.randomUUID(),
        "x-command-code-version": await resolveCommandCodeVersion(),
        "x-cli-environment": COMMANDCODE_CLI_ENV,
        "Authorization": `Bearer ${trimmed}`,
      },
      body: JSON.stringify({
        threadId: crypto.randomUUID(),
        memory: "",
        config: {
          workingDir: process.cwd(),
          date: new Date().toISOString().slice(0, 10),
          environment: process.platform,
          structure: [],
          isGitRepo: false,
          currentBranch: "",
          mainBranch: "",
          gitStatus: "",
          recentCommits: [],
        },
        params: {
          model: COMMANDCODE_MODELS[0]!.id,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          max_tokens: 1,
        },
      }),
    });
  } catch (err) {
    throw new Error(`Network error contacting CommandCode: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API key rejected (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`CommandCode probe HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  // Drain the NDJSON body — keeps the socket clean.
  await resp.text().catch(() => {});

  const keyTail = trimmed.slice(-8);
  return {
    email: `commandcode-${keyTail}@apikey`,
    metadata: {
      key_tail: keyTail,
      validated_at: new Date().toISOString(),
    },
  };
}

/**
 * After a CommandCode request, re-probe /alpha/billing/credits and persist the
 * fresh 5-hour/weekly window limits + credit balance so the dashboard meters
 * update in real time (mirrors refreshGrokWeeklyPoolAfterRequest).
 *
 * Fire-and-forget from the proxy edge. Failures are silent (next warmup heals).
 */
export async function refreshCommandCodeUsageAfterRequest(account: Account): Promise<void> {
  try {
    if (!account?.id || account.id <= 0) return;
    if (account.provider !== "commandcode") return;
    const apiKey = (() => {
      try { return decrypt(account.password); } catch { return ""; }
    })();
    if (!apiKey) return;

    const resp = await fetch(`${COMMANDCODE_API_BASE}/alpha/billing/credits`, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = (await resp.json().catch(() => null)) as {
      credits?: { monthlyCredits?: number; purchasedCredits?: number; freeCredits?: number };
      windowLimits?: {
        limited?: boolean;
        exceeded?: unknown;
        fiveHour?: CmcWindowLimit;
        weekly?: CmcWindowLimit;
      };
    } | null;
    if (!data) return;

    const fh = data.windowLimits?.fiveHour;
    const wk = data.windowLimits?.weekly;
    const monthly = Number(data.credits?.monthlyCredits ?? 0);
    const purchased = Number(data.credits?.purchasedCredits ?? 0);
    const free = Number(data.credits?.freeCredits ?? 0);

    const meta = (typeof account.metadata === "object" && account.metadata
      ? { ...(account.metadata as Record<string, unknown>) }
      : {});
    if (data.windowLimits) {
      meta.window_limits = {
        limited: Boolean(data.windowLimits.limited),
        fiveHour: fh ?? null,
        weekly: wk ?? null,
        fetchedAt: new Date().toISOString(),
      };
    }
    meta.credits = { monthly, purchased, free, fetchedAt: new Date().toISOString() };

    const { db } = await import("../../../db/index");
    const { accounts } = await import("../../../db/schema");
    const { eq } = await import("drizzle-orm");
    const remaining = fh?.cap ? Math.max(0, Number(fh.cap) - Number(fh.used ?? 0)) : undefined;
    // Upstream is the source of truth: if the 5-hour window is NOT exceeded,
    // the key is usable — keep the account active even if the local debit
    // counter briefly hit 0 (the local count double-counts the same request).
    const status = fh && !fh.exceeded ? "active" : undefined;
    await db.update(accounts).set({
      metadata: meta,
      quotaLimit: fh?.cap ? Number(fh.cap) : undefined,
      quotaRemaining: remaining,
      quotaResetAt: fh?.resetAt ? new Date(fh.resetAt) : undefined,
      ...(status ? { status, errorMessage: null } : {}),
      updatedAt: new Date(),
    }).where(eq(accounts.id, account.id));

    const { broadcast } = await import("../../../ws/index");
    broadcast({
      type: "account_status",
      data: {
        id: account.id,
        provider: "commandcode",
        status: status ?? "active",
        quotaRemaining: remaining,
        quotaLimit: fh?.cap ? Number(fh.cap) : undefined,
      },
    });
  } catch {
    // best-effort; do not fail the client response
  }
}
