import type { Account } from "../../db/schema";
import { config } from "../../config";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: any[];
  tool_choice?: any;
  reasoning_effort?: string;
  thinking?: { type: string; budget_tokens?: number; display?: string; effort?: string; summary?: string };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage & { tool_calls?: any[] };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
      delta: Partial<ChatMessage> & { tool_calls?: any[] };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export type CreditUnit = "token" | "request" | "image" | "credit";
export type CreditSource = "upstream" | "quota_delta" | "estimated" | "fixed";
export type ProviderHealthKind =
  | "healthy"
  | "exhausted"
  | "auth_error"
  | "banned"
  | "session_expired"
  | "missing_tokens"
  | "transient_error"
  | "unsupported";

export interface ProviderQuotaSnapshot {
  limit: number;
  remaining: number;
  used: number;
  resetAt?: Date | string | null;
  source: string;
  raw?: unknown;
  overage?: {
    enabled: boolean;
    capable: boolean;
    used: number;
    cap: number;
    remaining: number;
  };
}

export interface ProviderHealthResult {
  kind: ProviderHealthKind;
  success: boolean;
  retryable?: boolean;
  quota?: ProviderQuotaSnapshot;
  tokens?: unknown;
  error?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window?: number; // e.g. 200000
  max_output?: number; // e.g. 64000
  thinking?: boolean; // supports -thinking suffix
  vision?: boolean; // supports image_url content blocks
  creditUnit?: CreditUnit;
  creditRate?: number;
  creditSource?: CreditSource;
}

export interface ProviderResult {
  success: boolean;
  response?: ChatCompletionResponse;
  stream?: ReadableStream<Uint8Array>;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  creditsUsed?: number;
  creditSource?: CreditSource;
  error?: string;
  quotaExhausted?: boolean;
  rateLimited?: boolean; // 429 rate-limit (temporary, don't mark exhausted)
  banned?: boolean; // 403 — account is banned/restricted, not an auth issue
  tokens?: unknown; // New tokens after refresh (if refreshed during request)
}

export abstract class BaseProvider {
  abstract name: string;
  abstract supportedModels: ModelInfo[];

  abstract chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult>;

  abstract chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult>;

  abstract refreshToken(account: Account): Promise<{
    success: boolean;
    tokens?: string;
    error?: string;
  }>;

  abstract validateAccount(account: Account): Promise<boolean>;

  abstract fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: {
      limit: number;
      remaining: number;
      used: number;
      resetAt?: Date | string | null;
    };
    error?: string;
  }>;

  async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) {
      return {
        kind: "missing_tokens",
        success: false,
        error: "No valid tokens available",
      };
    }

    const quota = await this.fetchQuota(account);
    if (!quota.success) {
      const error = quota.error || "Quota check failed";
      const unsupported = /not support|does not support/i.test(error);
      return {
        kind: unsupported ? "unsupported" : "transient_error",
        success: false,
        retryable: !unsupported,
        error,
      };
    }

    // Sentinel `-1` means "unknown / unlimited" — not exhausted. Only flip
    // status to exhausted when we have a real positive limit and it's drained.
    if (
      quota.quota &&
      typeof quota.quota.limit === "number" &&
      quota.quota.limit > 0 &&
      quota.quota.remaining <= 0
    ) {
      return {
        kind: "exhausted",
        success: true,
        quota: { ...quota.quota, source: `${this.name}.fetchQuota` },
      };
    }

    return {
      kind: "healthy",
      success: true,
      quota: quota.quota ? { ...quota.quota, source: `${this.name}.fetchQuota` } : undefined,
    };
  }

  getModelInfo(model: string): ModelInfo | undefined {
    const normalized = model.toLowerCase();
    return this.supportedModels.find((item) => item.id.toLowerCase() === normalized);
  }

  getProviderCreditRate(model: string): number {
    return this.getModelInfo(model)?.creditRate ?? 1 / 1000;
  }

  getProviderCreditUnit(model: string): CreditUnit {
    return this.getModelInfo(model)?.creditUnit ?? "token";
  }

  getModels(): ModelInfo[] {
    return this.supportedModels;
  }

  /**
   * Whether this provider handles the given model id. The registry calls this
   * to route a request to a provider. Default: exact match against
   * supportedModels. Providers with a model-id prefix (qd-, kp-, cb-, codex-,
   * canva, ...) override this with their own pattern, so adding/changing a
   * provider's models only touches that provider's file.
   */
  ownsModel(model: string): boolean {
    return this.getModelInfo(model) !== undefined;
  }

  /**
   * Catch-all provider used when no provider's ownsModel() matches. Exactly one
   * provider sets this true (kiro). Others must leave it false.
   */
  isFallback = false;

  /**
   * Wire format this provider speaks natively. The edge uses this to avoid
   * needless Anthropic↔OpenAI round-trips (see proxy/index.ts). "openai" is the
   * canonical internal shape; Anthropic-native providers set "anthropic".
   */
  nativeFormat: "openai" | "anthropic" = "openai";

  protected generateId(): string {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  protected createSSEChunk(chunk: StreamChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  protected createSSEDone(): string {
    return "data: [DONE]\n\n";
  }

  protected estimateTokens(text: string): number {
    if (!text) return 0;
    // Conservative rough estimate for dashboard/accounting when upstream usage is absent.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  protected estimateMessagesTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      return total + this.estimateTokens(content) + 4;
    }, 0);
  }

  protected async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = config.providerRequestTimeoutMs): Promise<Response> {
    const { getNextProxy, markProxySuccess, markProxyFail } = await import("../../services/proxy-pool");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const proxy = await getNextProxy("model");
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        ...(proxy ? { proxy: proxy.url } : {}),
      } as any);
      if (proxy) void markProxySuccess(proxy.id);
      return response;
    } catch (err) {
      if (proxy) void markProxyFail(proxy.id, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
