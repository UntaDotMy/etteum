/**
 * Generic OpenAI-compatible API-key provider (F13).
 *
 * One class, instantiated N times for the API-key LLM catalog (openai,
 * anthropic-direct, deepseek, groq, openrouter, together, mistral, cohere,
 * fireworks, etc.). Each instance carries a static { id, baseUrl, models } and
 * relays chat-completion requests with the account's API key (stored encrypted
 * in account.password, decrypted via utils/crypto — same scheme as BYOK).
 *
 * When `apiType` is "anthropic", uses Anthropic Messages wire format
 * (`/messages`, `x-api-key`, `anthropic-version`) instead of OpenAI chat.
 *
 * Optional `staticApiKey` binds a key at the provider/node level (compatible
 * nodes) so routing works without a separate accounts row.
 */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { decrypt } from "../../utils/crypto";

export interface OpenAICompatibleSpec {
  /** Provider id / slug (e.g. "openai", "deepseek", "groq"). */
  id: string;
  /** Display name (e.g. "OpenAI", "DeepSeek"). */
  displayName: string;
  /** Base URL WITHOUT trailing slash (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** Model ids this provider serves (prefix-free; matched by ownsModel). */
  models: string[];
  /** Model prefix used for routing (e.g. "openai" → "openai-gpt-4o"). Optional. */
  prefix?: string;
  /** Extra headers (e.g. OpenAI org/project). */
  extraHeaders?: Record<string, string>;
  /** Wire format. Default openai. anthropic → /messages + x-api-key. */
  apiType?: "openai" | "anthropic";
  /**
   * Optional provider-level API key (compatible-node credential binding).
   * Used when the selected account has no key, or with a synthetic account
   * when no accounts.provider=<id> row exists.
   */
  staticApiKey?: string;
}

export class OpenAICompatibleProvider extends BaseProvider {
  name: string;
  override supportedModels: ModelInfo[];
  override nativeFormat: "openai" | "anthropic" = "openai";
  private readonly spec: OpenAICompatibleSpec;

  constructor(spec: OpenAICompatibleSpec) {
    super();
    this.spec = spec;
    this.name = spec.id;
    this.nativeFormat = spec.apiType === "anthropic" ? "anthropic" : "openai";
    this.supportedModels = spec.models.map((m) => ({
      id: m,
      object: "model" as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: spec.id,
    }));
  }

  /** True when this provider can auth without a DB account row. */
  hasStaticCredentials(): boolean {
    return !!this.spec.staticApiKey || !!(this.spec.extraHeaders && Object.keys(this.spec.extraHeaders).length);
  }

  /**
   * Synthetic account for node-level credentials when no accounts row exists
   * for this provider id. id=0 is never written to FK columns as a real account
   * (logging should treat 0 as null — call sites pass account.id through).
   */
  getStaticAccount(): Account | null {
    if (!this.hasStaticCredentials()) return null;
    const now = new Date();
    return {
      id: 0,
      provider: this.name,
      email: `${this.name}@node`,
      password: this.spec.staticApiKey || "",
      status: "active",
      enabled: true,
      tokens: this.spec.staticApiKey ? { api_key: this.spec.staticApiKey } : null,
      quotaLimit: 0,
      quotaRemaining: 0,
      quotaResetAt: null,
      freeLimit: 0,
      freeRemaining: 0,
      freeResetAt: null,
      lastUsedAt: null,
      lastLoginAt: null,
      errorMessage: null,
      metadata: { staticNodeCredentials: true },
      cooldownUntil: null,
      consecutiveTransientFailures: 0,
      nextBackoffMs: 0,
      consecutiveAuthErrors: 0,
      priority: 0,
      consecutiveUseCount: 0,
      createdAt: now,
      updatedAt: now,
    } as Account;
  }

  override ownsModel(model: string): boolean {
    if (!model) return false;
    if (this.spec.models.includes(model)) return true;
    if (this.spec.prefix && model.startsWith(`${this.spec.prefix}-`)) return true;
    return false;
  }

  private getApiKey(account: Account): string {
    const tokens = account.tokens as any;
    if (tokens?.api_key) return String(tokens.api_key);
    try {
      if (account.password) {
        // Static node keys may be stored plaintext on the synthetic account.
        if ((account.metadata as any)?.staticNodeCredentials) return String(account.password);
        return decrypt(account.password);
      }
    } catch {
      // Plaintext fallback for node static keys that were not encrypted.
      if (account.password) return String(account.password);
    }
    if (this.spec.staticApiKey) return this.spec.staticApiKey;
    return "";
  }

  private actualModel(model: string): string {
    if (this.spec.prefix && model.startsWith(`${this.spec.prefix}-`)) {
      return model.slice(this.spec.prefix.length + 1);
    }
    return model;
  }

  private isAnthropic(): boolean {
    return this.spec.apiType === "anthropic" || this.nativeFormat === "anthropic";
  }

  private buildOpenAIHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(this.spec.extraHeaders || {}),
    };
  }

  private buildAnthropicHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...(this.spec.extraHeaders || {}),
    };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key configured for this account" };
    const model = this.actualModel(request.model);

    if (this.isAnthropic()) {
      return this.chatCompletionAnthropic(apiKey, model, request, false);
    }

    const body = { ...request, model, stream: false };
    try {
      const resp = await this.fetchWithTimeout(`${this.spec.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildOpenAIHeaders(apiKey),
        body: JSON.stringify(body),
      }, config.providerRequestTimeoutMs);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `Upstream ${resp.status}: ${text.slice(0, 500)}`, rateLimited: resp.status === 429 };
      }
      const response = (await resp.json()) as ChatCompletionResponse;
      return { success: true, response };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key configured for this account" };
    const model = this.actualModel(request.model);

    if (this.isAnthropic()) {
      return this.chatCompletionAnthropic(apiKey, model, request, true);
    }

    const body = { ...request, model, stream: true, stream_options: { include_usage: true } };
    try {
      const resp = await this.fetchWithTimeout(`${this.spec.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...this.buildOpenAIHeaders(apiKey), Accept: "text/event-stream" },
        body: JSON.stringify(body),
      }, config.providerRequestTimeoutMs);
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `Upstream ${resp.status}: ${text.slice(0, 500)}`, rateLimited: resp.status === 429 };
      }
      return { success: true, stream: resp.body as unknown as ReadableStream<Uint8Array> };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  private async chatCompletionAnthropic(
    apiKey: string,
    model: string,
    request: ChatCompletionRequest,
    stream: boolean,
  ): Promise<ProviderResult> {
    const url = `${this.spec.baseUrl.replace(/\/$/, "")}/messages`;
    const headers = this.buildAnthropicHeaders(apiKey);
    if (stream) headers.Accept = "text/event-stream";
    const body = this.toAnthropicRequest(request, model, stream);

    try {
      const resp = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, config.providerRequestTimeoutMs);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return {
          success: false,
          error: `Upstream ${resp.status}: ${text.slice(0, 500)}`,
          rateLimited: resp.status === 429,
        };
      }

      if (stream) {
        if (!resp.body) return { success: false, error: "No stream body from Anthropic upstream" };
        return {
          success: true,
          stream: this.transformAnthropicStream(resp.body as unknown as ReadableStream<Uint8Array>, request.model),
        };
      }

      const data = await resp.json();
      return { success: true, response: this.fromAnthropicResponse(data, request.model) };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  private toAnthropicRequest(
    request: ChatCompletionRequest,
    model: string,
    stream: boolean,
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [];
    let pendingToolResults: any[] = [];

    const flushToolResults = () => {
      if (pendingToolResults.length > 0) {
        messages.push({ role: "user", content: pendingToolResults });
        pendingToolResults = [];
      }
    };

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
        continue;
      }
      if (msg.role === "tool") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: msg.tool_call_id || "",
          content: text,
        });
        continue;
      }
      flushToolResults();
      if (msg.role === "assistant") {
        const contentBlocks: any[] = [];
        if (typeof msg.content === "string" && msg.content) {
          contentBlocks.push({ type: "text", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const b of msg.content as any[]) {
            if (b?.type === "text") contentBlocks.push({ type: "text", text: b.text || "" });
          }
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let input: unknown = {};
            try {
              input = typeof tc.function?.arguments === "string"
                ? JSON.parse(tc.function.arguments || "{}")
                : (tc.function?.arguments || {});
            } catch {
              input = { raw: tc.function?.arguments };
            }
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function?.name || "",
              input,
            });
          }
        }
        messages.push({ role: "assistant", content: contentBlocks.length ? contentBlocks : "" });
        continue;
      }
      // user
      messages.push({
        role: "user",
        content: typeof msg.content === "string" || Array.isArray(msg.content) ? msg.content : String(msg.content ?? ""),
      });
    }
    flushToolResults();

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.max_tokens ?? 4096,
      stream,
    };
    if (systemParts.length) body.system = systemParts.join("\n\n");
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.tools?.length) {
      body.tools = request.tools.map((t: any) => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || "",
        input_schema: t.function?.parameters || t.input_schema || { type: "object", properties: {} },
      }));
    }
    if (request.tool_choice) body.tool_choice = request.tool_choice;
    return body;
  }

  private fromAnthropicResponse(data: any, originalModel: string): ChatCompletionResponse {
    const content: any[] = data.content || [];
    const textContent = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join("");
    const toolCalls = content
      .filter((c: any) => c.type === "tool_use")
      .map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name || "", arguments: JSON.stringify(c.input || {}) },
      }));
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return {
      id: data.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        } as any,
        finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  private transformAnthropicStream(
    anthropicStream: ReadableStream<Uint8Array>,
    originalModel: string,
  ): ReadableStream<Uint8Array> {
    const reader = anthropicStream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = `chatcmpl-${Date.now()}`;
    let buffer = "";
    let started = false;
    let hasToolUse = false;

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: originalModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";
            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              const payload = dataLine.slice(6).trim();
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              try {
                const event = JSON.parse(payload);
                if (event.type === "message_start" && !started) {
                  started = true;
                  controller.enqueue(makeChunk({ role: "assistant" }));
                }
                if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
                  hasToolUse = true;
                  const idx = event.index ?? 0;
                  controller.enqueue(makeChunk({
                    tool_calls: [{
                      index: idx,
                      id: event.content_block.id || `call_${idx}`,
                      type: "function",
                      function: { name: event.content_block.name || "", arguments: "" },
                    }],
                  }));
                }
                if (event.type === "content_block_delta") {
                  const text = event.delta?.text || "";
                  if (text) controller.enqueue(makeChunk({ content: text }));
                  if (event.delta?.type === "input_json_delta" && event.delta?.partial_json) {
                    controller.enqueue(makeChunk({
                      tool_calls: [{
                        index: event.index ?? 0,
                        function: { arguments: event.delta.partial_json },
                      }],
                    }));
                  }
                }
                if (event.type === "message_stop") {
                  controller.enqueue(makeChunk({}, hasToolUse ? "tool_calls" : "stop"));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }
              } catch { /* skip malformed */ }
            }
          }
          if (!started) controller.enqueue(makeChunk({ role: "assistant", content: "" }));
          controller.enqueue(makeChunk({}, "stop"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch { /* already errored */ }
        }
      },
    });
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "API-key provider — no refresh; re-enter key to rotate" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  async fetchQuota(_account: Account, _signal?: AbortSignal): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    return { success: true, quota: { limit: 0, remaining: 0, used: 0 } };
  }

  override getProviderCreditRate(): number {
    return 0;
  }
}

/**
 * The API-key LLM catalog (F13). Each entry is one OpenAI-compatible relay.
 * Ported from the reference proxy open-sse/providers/registry/{openai,deepseek,groq,...}.js
 * (the "apikey" category). Add/remove providers here in one place.
 */
export const OPENAI_COMPATIBLE_CATALOG: OpenAICompatibleSpec[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    prefix: "openai",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo", "o1", "o1-mini", "o3-mini"],
  },
  {
    id: "anthropic-direct",
    displayName: "Anthropic (API key)",
    baseUrl: "https://api.anthropic.com/v1",
    prefix: "anthropic",
    apiType: "anthropic",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    prefix: "deepseek",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"],
  },
  {
    id: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    prefix: "groq",
    models: ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile", "mixtral-8x7b-32768"],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    prefix: "or",
    models: ["openrouter/auto", "anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-2.5-pro"],
    extraHeaders: { "HTTP-Referer": "https://etteum.local", "X-Title": "etteum" },
  },
  {
    id: "together",
    displayName: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    prefix: "together",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo"],
  },
  {
    id: "mistral",
    displayName: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    prefix: "mistral",
    models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
  },
  {
    id: "cohere",
    displayName: "Cohere",
    baseUrl: "https://api.cohere.ai/v1",
    prefix: "cohere",
    models: ["command-r-plus", "command-r", "command-r7b"],
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    prefix: "fireworks",
    models: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/qwen2p5-72b-instruct"],
  },
  // Grok / xAI is owned exclusively by first-party GrokProvider (OAuth/SSO +
  // cli-chat-proxy). Do not re-add an F13 catalog entry with id "grok" or "xai"
  // — a colliding id overwrites providers.grok and breaks OAuth Bearer auth.
];

/** Instantiate all catalog providers. Call once at registry init. */
export function createOpenAICompatibleProviders(): OpenAICompatibleProvider[] {
  return OPENAI_COMPATIBLE_CATALOG.map((spec) => new OpenAICompatibleProvider(spec));
}
