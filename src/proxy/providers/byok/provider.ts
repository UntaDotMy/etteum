import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import { db } from "../../../db/index";
import { accounts } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../../../config";
import { decrypt } from "../../../utils/crypto";
import { safeJsonParse } from "../../../utils/safe-json";
import { resolveModelSpec } from "../../model-specs";
import { toCanonicalModelName } from "../../pricing";

/**
 * BYOK (Bring Your Own Key) Provider
 *
 * Memungkinkan user menambahkan custom AI provider (OpenRouter, Together, Groq, dll)
 * dengan API key mereka sendiri. Support OpenAI dan Anthropic formats.
 *
 * Storage:
 * - provider: "byok"
 * - email: label/nama provider (e.g., "openrouter", "myrouter")
 * - password: encrypted API key (XOR + base64)
 * - tokens: JSON { base_url, format, models[], model_prefix, headers }
 *
 * Model routing via prefix:
 * - User define label "openrouter" + models ["gpt-4o", "claude-sonnet-4.6"]
 * - Available: "openrouter-gpt-4o", "openrouter-claude-sonnet-4.6"
 * - Request { model: "openrouter-gpt-4o" } → forward ke base_url dengan model "gpt-4o"
 */

interface ByokTokens {
  base_url: string;
  api_key?: string; // kept in tokens for reference only, actual key is in password (encrypted)
  format: "openai" | "anthropic" | "auto";
  models: string[];
  model_prefix: string;
  headers?: Record<string, string>;
  /** Human-friendly key label inside a BYOK provider group (e.g. default, trial-1). */
  key_label?: string;
  /** Optional future-proofing for weighted balancing. Defaults to 1. */
  weight?: number;
  /** Lower number is preferred for sequential balancing. Defaults to account id order. */
  priority?: number;
}

interface CachedByokAccount {
  account: Account;
  config: ByokTokens;
  expiresAt: number;
}

interface ByokSelectionOptions {
  excludeAccountIds?: Set<number>;
  loadBalancingMethod?: string;
  getInFlightCount?: (accountId: number) => number;
}

export class ByokProvider extends BaseProvider {
  name = "byok";
  override supportedModels: ModelInfo[] = [];
  override isFallback = false;
  override nativeFormat: "openai" | "anthropic" = "openai";

  // Synchronous prefix → accounts cache (required for ownsModel sync check).
  // Multiple accounts can share a model_prefix; selection/load-balancing happens per prefix.
  private prefixCache = new Map<string, CachedByokAccount[]>();
  private prefixes: string[] = [];
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 10_000; // 10 seconds
  private refreshPromise: Promise<void> | null = null;
  private lastIndexByPrefix = new Map<string, number>();

  // ── Cache Management ──────────────────────────────────────────────

  /**
   * Refresh the prefix cache from the database.
   * Deduplicates concurrent calls so only one DB query runs at a time.
   */
  private async refreshCache(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.loadFromDb();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async loadFromDb(): Promise<void> {
    const byokAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "byok"));

    // Build new data in temporary variables first to avoid race condition
    const newPrefixCache = new Map<string, CachedByokAccount[]>();
    const newPrefixSet = new Set<string>();
    const newSupportedModels: ModelInfo[] = [];
    const modelIds = new Set<string>();

    for (const account of byokAccounts) {
      if (!account.enabled) continue;
      // Include error accounts so routing still claims their prefix.
      // The router will handle retries/failures; we must not let their
      // models fall through to the fallback provider (Kiro).
      if (account.status !== "active" && account.status !== "error") continue;

      const tokens = this.parseTokens(account.tokens);
      if (!tokens?.base_url || !tokens.models?.length) continue;

      const prefix = tokens.model_prefix || account.email;
      const expiresAt = Date.now() + this.CACHE_TTL;
      const entry: CachedByokAccount = { account, config: tokens, expiresAt };

      const existing = newPrefixCache.get(prefix) || [];
      existing.push(entry);
      newPrefixCache.set(prefix, existing);
      newPrefixSet.add(prefix);

      for (const model of tokens.models) {
        const modelId = `${prefix}-${model}`;
        if (modelIds.has(modelId)) continue;
        modelIds.add(modelId);
        // Prefer MODEL_SPECS for known bare names (e.g. claude-opus-4.8 → 1M),
        // not a hard-coded 200k default that mislabels frontier models.
        const bare = String(model || "").trim();
        const spec =
          resolveModelSpec(toCanonicalModelName(bare)) ||
          resolveModelSpec(bare) ||
          resolveModelSpec(toCanonicalModelName(modelId));
        newSupportedModels.push({
          id: modelId,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: `byok:${prefix}`,
          context_window: spec?.contextWindow ?? 200_000,
          max_output: spec?.maxOutput ?? 8192,
          ...(spec?.thinking != null ? { thinking: spec.thinking } : {}),
          ...(spec?.vision != null ? { vision: spec.vision } : {}),
        });
      }
    }

    for (const entries of newPrefixCache.values()) {
      entries.sort((a, b) => {
        const priorityA = Number(a.config.priority ?? Number.POSITIVE_INFINITY);
        const priorityB = Number(b.config.priority ?? Number.POSITIVE_INFINITY);
        if (priorityA !== priorityB) return priorityA - priorityB;
        return a.account.id - b.account.id;
      });
    }

    // Atomically swap in the new data
    this.prefixCache = newPrefixCache;
    this.prefixes = Array.from(newPrefixSet).sort((a, b) => b.length - a.length);
    this.supportedModels = newSupportedModels;
    this.cacheExpiry = Date.now() + this.CACHE_TTL;
  }

  /** Ensure cache is fresh, refreshing if stale. */
  private async ensureCache(): Promise<void> {
    if (Date.now() < this.cacheExpiry) return;
    await this.refreshCache();
  }

  /** Force-refresh cache (called after BYOK CRUD operations). */
  async refreshModelsCache(): Promise<void> {
    this.cacheExpiry = 0;
    await this.refreshCache();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private parseTokens(raw: unknown): ByokTokens | null {
    if (!raw) return null;
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      return obj as ByokTokens;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the API key for an account.
   * The real key lives in `password` (XOR-encrypted); tokens.api_key is optional.
   */
  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      // Fallback: try tokens.api_key (shouldn't happen, but defensive)
      const tokens = this.parseTokens(account.tokens);
      return tokens?.api_key || "";
    }
  }

  /**
   * Detect API format from base_url or use explicit setting.
   */
  private detectFormat(config: ByokTokens): "openai" | "anthropic" {
    if (config.format && config.format !== "auto") return config.format;
    const url = config.base_url.toLowerCase();
    if (url.includes("anthropic.com") || url.endsWith("/messages")) return "anthropic";
    return "openai";
  }

  /**
   * Strip the BYOK prefix from a model name.
   * "openrouter-gpt-4o" → "gpt-4o"
   */
  private extractModel(prefixedModel: string, prefix: string): string {
    return prefixedModel.startsWith(`${prefix}-`)
      ? prefixedModel.slice(prefix.length + 1)
      : prefixedModel;
  }

  /** Find which BYOK prefix a model belongs to. */
  private findPrefix(model: string): string | null {
    for (const prefix of this.prefixes) {
      if (model.startsWith(`${prefix}-`)) return prefix;
    }
    return null;
  }

  /** Public async helper for account-pool setting lookup. */
  findPrefixForModel(model: string): string | null {
    if (Date.now() >= this.cacheExpiry) {
      this.refreshCache().catch(() => {/* swallow — next call will retry */});
    }
    return this.findPrefix(model);
  }

  // ── Routing (synchronous — required by registry) ──────────────────

  /**
   * Synchronous ownsModel check. The cache MUST be pre-populated
   * (refreshed via refreshModelsCache() at startup and after CRUD).
   */
  override ownsModel(model: string): boolean {
    // If cache is stale, trigger a background refresh but still use last-known
    // prefixes so requests don't fall through to the fallback provider (Kiro).
    if (Date.now() >= this.cacheExpiry) {
      // Fire-and-forget: refresh in background, don't block routing
      this.refreshCache().catch(() => {/* swallow — next call will retry */});
    }
    return this.findPrefix(model) !== null;
  }

  /**
   * Find the BYOK account that owns a given model (by prefix) and select one
   * key from that prefix group using the configured load-balancing strategy.
   * Called by pool.getAccountForModel() for async account selection.
   */
  async findAccountForModel(
    model: string,
    options: ByokSelectionOptions = {}
  ): Promise<Account | null> {
    await this.ensureCache();
    const prefix = this.findPrefix(model);
    if (!prefix) return null;

    const actualModel = this.extractModel(model, prefix);
    const entries = this.prefixCache.get(prefix) || [];
    const excluded = options.excludeAccountIds || new Set<number>();

    // Prefer active keys. Error keys remain in the cache only to keep model
    // ownership claimed; they are tried only if no active key is available.
    const supportsModel = (entry: CachedByokAccount) => entry.config.models.includes(actualModel);
    const notExcluded = (entry: CachedByokAccount) => !excluded.has(entry.account.id);
    let candidates = entries.filter((entry) =>
      entry.account.enabled && entry.account.status === "active" && supportsModel(entry) && notExcluded(entry)
    );

    if (candidates.length === 0) {
      candidates = entries.filter((entry) =>
        entry.account.enabled && entry.account.status === "error" && supportsModel(entry) && notExcluded(entry)
      );
    }

    if (candidates.length === 0) return null;
    return this.selectAccount(prefix, candidates, options).account;
  }

  private selectAccount(
    prefix: string,
    candidates: CachedByokAccount[],
    options: ByokSelectionOptions
  ): CachedByokAccount {
    if (candidates.length === 1) return candidates[0]!;

    const getLoad = options.getInFlightCount || (() => 0);
    const method = options.loadBalancingMethod || "round_robin";

    if (method === "sequential") {
      for (const candidate of candidates) {
        if (getLoad(candidate.account.id) === 0) return candidate;
      }
      return candidates[0]!;
    }

    if (method === "least_inflight") {
      return candidates.reduce((best, candidate) =>
        getLoad(candidate.account.id) < getLoad(best.account.id) ? candidate : best
      );
    }

    // Round robin (default), with least-in-flight tie-break so bursty workloads
    // don't pile up on a slow upstream key.
    const startIdx = ((this.lastIndexByPrefix.get(prefix) ?? -1) + 1) % candidates.length;
    let selected = candidates[startIdx]!;
    let selectedIdx = startIdx;
    let selectedLoad = getLoad(selected.account.id);

    for (let i = 1; i < candidates.length; i++) {
      const idx = (startIdx + i) % candidates.length;
      const candidate = candidates[idx]!;
      const load = getLoad(candidate.account.id);
      if (load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    this.lastIndexByPrefix.set(prefix, selectedIdx);
    return selected;
  }

  /** Get all BYOK models for /v1/models endpoint. */
  async getAllByokModels(): Promise<ModelInfo[]> {
    await this.ensureCache();
    return this.supportedModels;
  }

  // ── Provider Interface ─────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens) return { success: false, error: "Invalid BYOK configuration" };

    const format = this.detectFormat(tokens);
    const actualModel = this.extractModel(request.model, tokens.model_prefix);

    return format === "anthropic"
      ? this.chatCompletionAnthropic(account, tokens, actualModel, request)
      : this.chatCompletionOpenAI(account, tokens, actualModel, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens) return { success: false, error: "Invalid BYOK configuration" };

    const format = this.detectFormat(tokens);
    const actualModel = this.extractModel(request.model, tokens.model_prefix);

    return format === "anthropic"
      ? this.chatCompletionStreamAnthropic(account, tokens, actualModel, request)
      : this.chatCompletionStreamOpenAI(account, tokens, actualModel, request);
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true }; // BYOK keys are static — user manages their own
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.parseTokens(account.tokens);
    return !!(tokens?.base_url && tokens?.models?.length);
  }

  async fetchQuota(): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    return {
      success: true,
      // BYOK has no built-in quota — return undefined to preserve
      // existing DB values instead of clobbering them with -1/-1.
      quota: undefined,
    };
  }

  /**
   * Override the default healthCheck to actually probe the upstream API.
   *
   * The base implementation only calls validateAccount (config exists) +
   * fetchQuota (stubbed to always succeed), so without this override a
   * BYOK account with a revoked key stays "healthy" forever and every
   * request routed to it fails at runtime.
   *
   * Probe strategy:
   *  - OpenAI format: GET /models — cheapest authenticated endpoint,
   *    returns 401/403 if the key is invalid. Some providers (e.g.
   *    Azure, legacy vLLM) don't expose /models, so fall back to a
   *    minimal chat completion probe with max_tokens=1.
   *  - Anthropic format: POST /v1/messages with max_tokens=1 — the
   *    cheapest possible request. 401 → expired, 429 → rate limited
   *    (key is valid, just throttled), 5xx → transient.
   */
  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens?.base_url || !tokens?.models?.length) {
      return { kind: "missing_tokens", success: false, error: "No base_url or models configured" };
    }

    const apiKey = this.getApiKey(account);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key" };
    }

    const format = this.detectFormat(tokens);
    const base = tokens.base_url.replace(/\/$/, "");

    // ── OpenAI format: try /models first ───────────────────────────
    if (format === "openai") {
      try {
        const resp = await this.fetchWithTimeout(`${base}/models`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            ...tokens.headers,
          },
        }, config.providerQuotaTimeoutMs, signal);

        if (resp.status === 401) {
          return { kind: "session_expired", success: false, error: "BYOK key rejected (HTTP 401 — invalid or expired key)" };
        }
        if (resp.status === 403) {
          return { kind: "banned", success: false, error: "BYOK key forbidden (HTTP 403 — key may be disabled, IP-restricted, or banned)" };
        }
        if (resp.ok) {
          // Key is valid — /models endpoint works.
          await resp.text().catch(() => {});
          return { kind: "healthy", success: true };
        }
        // /models not supported (404/405) — fall through to chat probe
      } catch {
        // Network error on /models — fall through to chat probe
      }
    }

    // ── Chat probe (both formats) ──────────────────────────────────
    // Use the first configured model with a 1-token request.
    const probeModel = tokens.models[0];
    if (!probeModel) {
      return { kind: "healthy", success: true };
    }

    try {
      if (format === "anthropic") {
        const resp = await this.fetchWithTimeout(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            ...tokens.headers,
          },
          body: JSON.stringify({
            model: probeModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        }, config.providerQuotaTimeoutMs, signal);

        if (resp.status === 401) {
          return { kind: "session_expired", success: false, error: "BYOK key rejected (HTTP 401 — invalid or expired key)" };
        }
        if (resp.status === 403) {
          return { kind: "banned", success: false, error: "BYOK key forbidden (HTTP 403 — key may be disabled, IP-restricted, or banned)" };
        }
        if (resp.status === 429) {
          // Rate limited — key is valid but should be backed off, not routed to
          // (a 'healthy' 429 key keeps receiving requests that then fail). Per
          // RFC 6585, 429 is a throttling signal for a valid client.
          return { kind: "transient_error", success: false, retryable: true, error: "BYOK upstream rate limited (HTTP 429)" };
        }
        if (resp.status >= 500) {
          return { kind: "transient_error", success: false, retryable: true, error: `BYOK upstream HTTP ${resp.status}` };
        }
        // 200 or 400 (bad model) or 404 — key is valid, model might be wrong
        // but that's not an auth issue. Drain to keep socket clean.
        await resp.text().catch(() => {});
        return { kind: "healthy", success: true };
      }

      // OpenAI chat probe
      const resp = await this.fetchWithTimeout(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          ...tokens.headers,
        },
        body: JSON.stringify({
          model: probeModel,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        }),
      }, config.providerQuotaTimeoutMs, signal);

      if (resp.status === 401) {
        return { kind: "session_expired", success: false, error: "BYOK key rejected (HTTP 401 — invalid or expired key)" };
      }
      if (resp.status === 403) {
        return { kind: "banned", success: false, error: "BYOK key forbidden (HTTP 403 — key may be disabled, IP-restricted, or banned)" };
      }
      if (resp.status === 429) {
        // Rate limited — back off rather than marking healthy (RFC 6585).
        return { kind: "transient_error", success: false, retryable: true, error: "BYOK upstream rate limited (HTTP 429)" };
      }
      if (resp.status >= 500) {
        return { kind: "transient_error", success: false, retryable: true, error: `BYOK upstream HTTP ${resp.status}` };
      }
      // 200 or 400/404 (bad model) — key is valid, drain body
      await resp.text().catch(() => {});
      return { kind: "healthy", success: true };
    } catch (err) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: `BYOK probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── OpenAI-compatible ──────────────────────────────────────────────

  private async chatCompletionOpenAI(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...tokens.headers,
    };

    const body: Record<string, unknown> = {
      model: actualModel,
      messages: request.messages,
      stream: false,
    };
    this.appendOptionalParams(body, request);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        return { success: false, error: `expired: HTTP 401`, banned: false };
      }
      if (response.status === 403) {
        return { success: false, error: `forbidden: HTTP 403`, banned: true };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      // Check if response is SSE (some providers return SSE even when stream: false)
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        // Parse SSE response - aggregate streaming chunks into single completion
        const text = await response.text();
        const lines = text.split("\n").filter((line) => line.startsWith("data: "));
        
        let aggregatedContent = "";
        let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
        let chunkId = "";
        let chunkModel = "";
        let created = 0;
        let finishReason: string | null = null;
        
        for (const line of lines) {
          const payload = line.slice(6).trim();
          if (payload === "[DONE]" || !payload || payload.startsWith(":")) continue;
          
          try {
            const chunk = JSON.parse(payload);
            
            // Check for error response
            if (chunk.error) {
              return { 
                success: false, 
                error: chunk.error.message || chunk.error.code || "Upstream error"
              };
            }
            
            // Extract metadata from first chunk
            if (!chunkId && chunk.id) chunkId = chunk.id;
            if (!chunkModel && chunk.model) chunkModel = chunk.model;
            if (!created && chunk.created) created = chunk.created;
            
            // Aggregate content from delta
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              aggregatedContent += delta.content;
            }
            
            // Capture finish reason
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            
            // Capture usage from final chunk
            if (chunk.usage) {
              usage = chunk.usage;
            }
          } catch {
            // Skip malformed chunks
          }
        }
        
        if (!aggregatedContent && !usage) {
          return { success: false, error: "No valid data in SSE response" };
        }
        
        // Build non-streaming response object
        const completionResponse: ChatCompletionResponse = {
          id: chunkId || this.generateId(),
          object: "chat.completion",
          created: created || Math.floor(Date.now() / 1000),
          model: request.model, // Return original prefixed model to client
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: aggregatedContent,
            },
            finish_reason: finishReason || "stop",
          }],
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || this.estimateTokens(aggregatedContent),
            total_tokens: usage.total_tokens || 0,
          },
        };
        
        const promptTokens = completionResponse.usage.prompt_tokens;
        const completionTokens = completionResponse.usage.completion_tokens;
        
        return {
          success: true,
          response: completionResponse,
          promptTokens,
          completionTokens,
          tokensUsed: promptTokens + completionTokens,
        };
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };

      const promptTokens = data.usage?.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = data.usage?.completion_tokens || this.estimateTokens(
        typeof choice.message?.content === "string" ? choice.message.content : ""
      );

      // Return original prefixed model to the client
      data.model = request.model;

      return {
        success: true,
        response: data,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamOpenAI(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "text/event-stream",
      ...tokens.headers,
    };

    const body: Record<string, unknown> = {
      model: actualModel,
      messages: request.messages,
      stream: true,
    };
    this.appendOptionalParams(body, request);

    try {
      const upstreamAbort = new AbortController();
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, config.providerRequestTimeoutMs, upstreamAbort.signal);

      if (response.status === 401) {
        return { success: false, error: `expired: HTTP 401` };
      }
      if (response.status === 403) {
        return { success: false, error: `forbidden: HTTP 403`, banned: true };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      // Pass upstream stream through, rewriting model and id
      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;
      // Hoisted so cancel() can release the upstream reader on client disconnect.
      let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          upstreamReader = reader;
          const decoder = new TextDecoder();
          let buffer = "";

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
                  const chunk = JSON.parse(payload);
                  chunk.model = model;
                  chunk.id = id;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } catch { /* skip malformed */ }
              }
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try { controller.error(err); } catch { /* already errored */ }
          }
        },
        async cancel(reason) {
          try {
            await upstreamReader?.cancel(reason).catch(() => {});
            upstreamAbort.abort();
          } catch { /* never throw from cancel */ }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic Messages API ─────────────────────────────────────────

  private async chatCompletionAnthropic(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...tokens.headers,
    };

    const body = this.toAnthropicRequest(request, actualModel, false);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        return { success: false, error: `expired: HTTP 401` };
      }
      if (response.status === 403) {
        return { success: false, error: `forbidden: HTTP 403`, banned: true };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json();
      const resp = this.fromAnthropicResponse(data, request.model);
      const promptTokens = resp.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = resp.usage.completion_tokens || 0;

      return {
        success: true,
        response: resp,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamAnthropic(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Accept": "text/event-stream",
      ...tokens.headers,
    };

    const body = this.toAnthropicRequest(request, actualModel, true);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        return { success: false, error: `expired: HTTP 401` };
      }
      if (response.status === 403) {
        return { success: false, error: `forbidden: HTTP 403`, banned: true };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const stream = this.transformAnthropicStream(response.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic Transform Helpers ────────────────────────────────────

  /**
   * Convert a canonical OpenAI ChatCompletionRequest into the Anthropic
   * Messages API format.
   *
   * This is the reverse of anthropicToOpenAI — it takes clean OpenAI messages
   * (role:"tool", assistant.tool_calls, etc.) and converts them to the
   * Anthropic shapes that BYOK Anthropic-compatible upstreams expect:
   *
   *   role:"system"    → body.system (string)
   *   role:"user"      → { role:"user", content:string | content_block[] }
   *   role:"assistant"  → { role:"assistant", content: content_block[] }
   *     • text content        → { type:"text", text }
   *     • tool_calls[]        → { type:"tool_use", id, name, input }
   *   role:"tool"      → { role:"user", content:[{ type:"tool_result",
   *                                                tool_use_id, content }] }
   *
   * Tools and tool_choice are also converted from OpenAI to Anthropic format.
   */
  private toAnthropicRequest(
    request: ChatCompletionRequest,
    model: string,
    stream: boolean
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [];

    // Merge consecutive role:"tool" messages into a single user message with
    // multiple tool_result blocks (Anthropic expects this).
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
        // Convert OpenAI role:"tool" → Anthropic tool_result content block.
        // Collect consecutive tool results into one user message.
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: msg.tool_call_id || "",
          content: text,
        });
        continue;
      }

      // Flush any pending tool results before the next user/assistant message.
      flushToolResults();

      if (msg.role === "assistant") {
        const contentBlocks: any[] = [];

        // Text content
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text) contentBlocks.push({ type: "text", text });

        // OpenAI tool_calls → Anthropic tool_use blocks
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (!tc?.function?.name) continue;
            let input: any = {};
            try {
              input = typeof tc.function.arguments === "string"
                ? safeJsonParse(tc.function.arguments) ?? {}
                : (tc.function.arguments ?? {});
            } catch { input = {}; }
            contentBlocks.push({
              type: "tool_use",
              id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              name: tc.function.name,
              input,
            });
          }
        }

        messages.push({
          role: "assistant",
          content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
        });
        continue;
      }

      // role:"user" — convert content blocks if array, otherwise pass string.
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({ role: "user", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Normalize content blocks: convert OpenAI image_url to Anthropic image.
          const blocks = (msg.content as any[]).map((block: any) => {
            if (block?.type === "text") return { type: "text", text: block.text || "" };
            if (block?.type === "image_url" && block.image_url?.url) {
              const url: string = block.image_url.url;
              const match = url.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
              if (match) {
                return {
                  type: "image",
                  source: { type: "base64", media_type: match[1], data: match[2] },
                };
              }
              return { type: "image", source: { type: "url", url } };
            }
            return block;
          }).filter(Boolean);
          messages.push({ role: "user", content: blocks });
        } else {
          messages.push({ role: "user", content: String(msg.content || "") });
        }
        continue;
      }
    }

    // Flush any remaining tool results.
    flushToolResults();

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.max_tokens || 4096,
      stream,
    };

    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    // Convert tools to Anthropic format if present.
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      body.tools = request.tools.map((tool: any) => {
        const fn = tool?.function || tool;
        return {
          name: fn?.name || tool?.name || "",
          description: fn?.description || tool?.description || "",
          input_schema: fn?.parameters || fn?.input_schema || { type: "object", properties: {} },
        };
      }).filter((t: any) => t.name);
    }

    // Convert tool_choice to Anthropic format if present.
    if (request.tool_choice !== undefined) {
      if (typeof request.tool_choice === "string") {
        body.tool_choice = { type: request.tool_choice === "required" ? "any" : request.tool_choice };
      } else if (request.tool_choice?.type === "function" && request.tool_choice?.function?.name) {
        body.tool_choice = { type: "tool", name: request.tool_choice.function.name };
      }
    }

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
      id: data.id || this.generateId(),
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

  /**
   * Transform Anthropic SSE stream → OpenAI-compatible SSE stream.
   */
  private transformAnthropicStream(
    anthropicStream: ReadableStream<Uint8Array>,
    originalModel: string
  ): ReadableStream<Uint8Array> {
    const reader = anthropicStream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = this.generateId();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let started = false;
    let hasToolUse = false;
    // Track tool_use blocks: index → { id, name, arguments }
    const toolUseBlocks = new Map<number, { id: string; name: string; arguments: string }>();

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

                if (event.type === "message_start") {
                  inputTokens = event.message?.usage?.input_tokens || 0;
                  if (!started) {
                    started = true;
                    controller.enqueue(makeChunk({ role: "assistant" }));
                  }
                }

                // ── Tool use: content_block_start with tool_use ──
                // Anthropic sends: { type:"content_block_start", index:N,
                //   content_block: { type:"tool_use", id, name } }
                if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
                  hasToolUse = true;
                  const idx = event.index ?? 0;
                  const blockId = event.content_block.id || `call_${idx}`;
                  const name = event.content_block.name || "";
                  toolUseBlocks.set(idx, { id: blockId, name, arguments: "" });
                  // Emit the tool call start (id + name, empty arguments)
                  controller.enqueue(makeChunk({
                    tool_calls: [{
                      index: idx,
                      id: blockId,
                      type: "function",
                      function: { name, arguments: "" },
                    }],
                  }));
                }

                if (event.type === "content_block_delta") {
                  // Text delta
                  const text = event.delta?.text || "";
                  if (text) controller.enqueue(makeChunk({ content: text }));

                  // Thinking/reasoning delta — forward as reasoning_content so
                  // the transform layer can convert it to Anthropic thinking
                  // blocks for Claude Code / other thinking-aware clients.
                  if (event.delta?.type === "thinking_delta" && event.delta?.thinking) {
                    controller.enqueue(makeChunk({ reasoning_content: event.delta.thinking }));
                  }

                  // Tool use input delta (JSON argument fragments)
                  // Anthropic: { delta: { type:"input_json_delta", partial_json } }
                  if (event.delta?.type === "input_json_delta" && event.delta?.partial_json) {
                    const idx = event.index ?? 0;
                    const block = toolUseBlocks.get(idx);
                    if (block) {
                      block.arguments += event.delta.partial_json;
                      // Stream the argument fragment to the client
                      controller.enqueue(makeChunk({
                        tool_calls: [{
                          index: idx,
                          function: { arguments: event.delta.partial_json },
                        }],
                      }));
                    }
                  }
                }

                if (event.type === "message_delta") {
                  outputTokens = event.usage?.output_tokens || 0;
                }

                if (event.type === "message_stop") {
                  const finishReason = hasToolUse ? "tool_calls" : "stop";
                  controller.enqueue(makeChunk({}, finishReason));
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

  // ── Shared Utilities ───────────────────────────────────────────────

  private appendOptionalParams(body: Record<string, unknown>, request: ChatCompletionRequest): void {
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;
    // Forward reasoning / thinking config so BYOK upstreams that support
    // extended thinking (e.g. OpenRouter routing to o1 / Claude) actually
    // receive it. Without this, thinking is silently dropped.
    //
    // Enable for: -thinking suffix, non-"none" reasoning_effort, or any
    // thinking.type other than "disabled" (Claude Code defaults to "adaptive").
    const effort = request.reasoning_effort;
    const thinkType = (request.thinking as any)?.type;
    const clientWantsThinking =
      (typeof request.model === "string" && request.model.endsWith("-thinking")) ||
      (typeof effort === "string" && effort !== "" && effort !== "none") ||
      (thinkType && thinkType !== "disabled");
    if (clientWantsThinking) {
      if (effort && effort !== "none") body.reasoning_effort = effort;
      if (thinkType && thinkType !== "disabled") body.thinking = request.thinking;
    }
  }
}
