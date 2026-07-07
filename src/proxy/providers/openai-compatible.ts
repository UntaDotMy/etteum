/**
 * Generic OpenAI-compatible API-key provider (F13).
 *
 * One class, instantiated N times for the API-key LLM catalog (openai,
 * anthropic-direct, deepseek, groq, openrouter, together, mistral, cohere,
 * fireworks, etc.). Each instance carries a static { id, baseUrl, models } and
 * relays chat-completion requests to `${baseUrl}/chat/completions` with the
 * account's API key (stored encrypted in account.password, decrypted via
 * utils/crypto — same scheme as BYOK).
 *
 * This is the efficient F13 approach: avoid N bespoke provider files by
 * reusing one generic OpenAI-compatible relay (mirrors BYOK's relay logic but
 * with a static base URL + model list instead of per-account config).
 *
 * The reference's DefaultExecutor (open-sse/executors/base.js) does exactly
 * this — POST to baseUrl with Authorization: Bearer key for every "apikey"
 * category provider.
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
    this.supportedModels = spec.models.map((m) => ({ id: m, owned_by: spec.id } as ModelInfo));
  }

  override ownsModel(model: string): boolean {
    if (!model) return false;
    // Exact model match.
    if (this.spec.models.includes(model)) return true;
    // Prefix match (e.g. "openai-gpt-4o" → prefix "openai").
    if (this.spec.prefix && model.startsWith(`${this.spec.prefix}-`)) return true;
    return false;
  }

  /** Resolve the API key for an account (stored encrypted in password; mirrors BYOK). */
  private getApiKey(account: Account): string {
    const tokens = account.tokens as any;
    if (tokens?.api_key) return String(tokens.api_key);
    // Encrypted in password (BYOK scheme).
    try {
      if (account.password) return decrypt(account.password);
    } catch { /* fall through */ }
    return "";
  }

  /** Strip this provider's prefix from a model id (openai-gpt-4o → gpt-4o). */
  private actualModel(model: string): string {
    if (this.spec.prefix && model.startsWith(`${this.spec.prefix}-`)) {
      return model.slice(this.spec.prefix.length + 1);
    }
    return model;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(this.spec.extraHeaders || {}),
    };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key configured for this account" };
    const model = this.actualModel(request.model);
    const body = { ...request, model, stream: false };
    try {
      const resp = await this.fetchWithTimeout(`${this.spec.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(apiKey),
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
    const body = { ...request, model, stream: true };
    try {
      const resp = await this.fetchWithTimeout(`${this.spec.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...this.buildHeaders(apiKey), Accept: "text/event-stream" },
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

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    // API-key providers don't refresh; the key is static.
    return { success: false, error: "API-key provider — no refresh; re-enter key to rotate" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  async fetchQuota(_account: Account, _signal?: AbortSignal): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    // Most API-key providers don't expose a standard quota API. Return healthy
    // (no limit info); cost is tracked via USD pricing (F6) instead.
    return { success: true, quota: { limit: 0, remaining: 0, used: 0 } };
  }

  override getProviderCreditRate(): number {
    return 0; // API-key providers cost is tracked via USD pricing (F6), not credits
  }
}

/**
 * The API-key LLM catalog (F13). Each entry is one OpenAI-compatible relay.
 * Ported from 9router open-sse/providers/registry/{openai,deepseek,groq,...}.js
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
  {
    id: "grok",
    displayName: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    prefix: "grok",
    models: ["grok-2", "grok-2-latest", "grok-beta"],
  },
];

/** Instantiate all catalog providers. Call once at registry init. */
export function createOpenAICompatibleProviders(): OpenAICompatibleProvider[] {
  return OPENAI_COMPATIBLE_CATALOG.map((spec) => new OpenAICompatibleProvider(spec));
}
