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
  /** Human label for dashboard-added custom models (see custom-models.ts). */
  display_name?: string;
  context_window?: number; // e.g. 200000
  max_output?: number; // e.g. 64000
  thinking?: boolean; // supports -thinking suffix
  vision?: boolean; // supports image_url content blocks
  /** Reasoning-effort levels this model accepts, ascending (drives the dashboard selector). */
  effort_levels?: string[];
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
  rateLimited?: boolean;
  /**
   * When the upstream rate limit / quota window resets, if known (e.g. parsed
   * from a 429 `reset_at` header/body). Used by the router to honor the real
   * cooldown instead of immediately retrying. Optional — providers that don't
   * surface it leave it undefined and the pool falls back to backoff.
   */
  resetsAt?: Date;
  /** Parsed `Retry-After` (ms), if the upstream gave one. Same role as resetsAt. */
  retryAfterMs?: number; // 429 rate-limit (temporary, don't mark exhausted)
  banned?: boolean; // 403 — account is banned/restricted, not an auth issue
  tokens?: unknown; // New tokens after refresh (if refreshed during request)
  metadata?: Record<string, unknown>; // Provider-specific diagnostics (e.g. upstream error text)
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

  abstract fetchQuota(account: Account, signal?: AbortSignal): Promise<{
    success: boolean;
    quota?: {
      limit: number;
      remaining: number;
      used: number;
      resetAt?: Date | string | null;
    };
    error?: string;
  }>;

  async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) {
      return {
        kind: "missing_tokens",
        success: false,
        error: "No valid tokens available",
      };
    }

    let quota = await this.fetchQuota(account, signal);
    let refreshedTokens: unknown | undefined;
    // auth-expired-retry on quota fetch. When fetchQuota fails with a
    // 401/expired/unauthorized error AND the provider supports refresh, force a
    // token refresh + retry the quota fetch once. Mirrors reference
    // usage/[connectionId]/route.js:173-183 (isAuthExpiredMessage → force refresh → re-fetch).
    if (!quota.success) {
      const errText = (quota.error || "").toLowerCase();
      const isAuthExpired = errText.includes("expired") || errText.includes("401") || errText.includes("unauthorized") || errText.includes("re-authorize");
      if (isAuthExpired) {
        try {
          const refresh = await this.refreshToken(account);
          if (refresh.success && refresh.tokens) {
            let parsedTokens: unknown;
            try { parsedTokens = typeof refresh.tokens === "string" ? JSON.parse(refresh.tokens) : refresh.tokens; }
            catch { parsedTokens = refresh.tokens; }
            refreshedTokens = parsedTokens;
            // Refresh the account object's tokens in-memory for the retry fetch.
            const refreshedAccount = { ...account, tokens: parsedTokens };
            const retry = await this.fetchQuota(refreshedAccount as Account, signal);
            if (retry.success) {
              quota = retry;
            }
          }
        } catch {
          // refresh failed — fall through with the original quota error
        }
      }
    }
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
        ...(refreshedTokens ? { tokens: refreshedTokens } : {}),
      };
    }

    return {
      kind: "healthy",
      success: true,
      quota: quota.quota ? { ...quota.quota, source: `${this.name}.fetchQuota` } : undefined,
      ...(refreshedTokens ? { tokens: refreshedTokens } : {}),
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

  /**
   * F12: when true, the provider only works in streaming mode upstream. A
   * non-streaming client request (`stream:false`) is then served by fetching
   * the stream and assembling it into a single JSON response (forcedSseToJson).
   * Default false; streaming-only providers opt in. Mirrors reference
   * PROVIDERS[provider].forceStream.
   */
  forceStream = false;

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

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = config.providerRequestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<Response> {
    const { getNextProxy, markProxySuccess, markProxyFail } = await import("../../services/proxy-pool");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Link an external abort signal (e.g. warmup stop) so it fires immediately,
    // not after the timeout elapses. Without this, a stopped warmup job would
    // keep its in-flight HTTP open for up to providerRequestTimeoutMs (~120s).
    let onAbort: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        onAbort = () => controller.abort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
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
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
  }
}
