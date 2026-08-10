/** alibaba provider class. */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "../base";
import type { Account } from "../../../db/schema";
import { db } from "../../../db/index";
import { accounts } from "../../../db/schema";
import { eq, and } from "drizzle-orm";
import { decrypt } from "../../../utils/crypto";
import { config } from "../../../config";
import { resolveModelSpec } from "../../model-specs";
import {
  ALI_MODEL_MAP,
  CHAT_URL,
  DASHSCOPE_BASE,
  MODELS_URL,
  QUOTAS_URL,
} from "./helpers";
import type {
  AlibabaQuotaTokens,
  QuotaLimitEntry,
} from "./helpers";

export class AlibabaProvider extends BaseProvider {
  name = "alibaba";
  override isFallback = false;
  override nativeFormat: "openai" = "openai";

  supportedModels: ModelInfo[] = Object.entries(ALI_MODEL_MAP).map(([id, def]) => {
    // Specs are a property of the model, not the provider — resolve the
    // canonical context/max_output from the central registry (verified
    // against DashScope docs). Falls back to the hardcoded def only if the
    // model isn't registered yet.
    const spec = resolveModelSpec(def.upstream);
    return {
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "alibaba",
      context_window: spec?.contextWindow ?? def.context_window,
      max_output: spec?.maxOutput ?? def.max_output,
      thinking: spec?.thinking ?? def.thinking,
      vision: spec?.vision ?? def.vision,
      creditUnit: "token" as const,
      creditRate: def.creditRate,
      creditSource: "estimated" as const,
    };
  });

  /**
   * Models discovered live from DashScope GET /v1/models, refreshed on startup
   * (and on demand). These are listed in /v1/models so users can see and use
   * the FULL upstream catalog, not just the curated subset. Quota tracking
   * still only covers the 6 KEY_PROBE_MODELS in healthCheck — discovery is
   * for listing/usage, not billing.
   */
  private discoveredModels: ModelInfo[] = [];
  private discoveryExpiry = 0;
  private readonly DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

  /** Full list = curated (with specs/credit rates) + discovered (full catalog). */
  override getModels(): ModelInfo[] {
    if (this.discoveredModels.length === 0) return this.supportedModels;
    const seen = new Set(this.supportedModels.map((m) => m.id));
    const merged = [...this.supportedModels];
    for (const m of this.discoveredModels) {
      if (!seen.has(m.id)) { merged.push(m); seen.add(m.id); }
    }
    return merged;
  }

  override getModelInfo(model: string): ModelInfo | undefined {
    const normalized = model.toLowerCase();
    const curated = this.supportedModels.find((m) => m.id.toLowerCase() === normalized);
    if (curated) return curated;
    return this.discoveredModels.find((m) => m.id.toLowerCase() === normalized);
  }

  /**
   * Discover the full DashScope model catalog from a healthy account's API key.
   * Called on startup (via refreshAlibabaModels) and refreshes on a 6h TTL.
   * Failures are non-fatal — the curated list remains served.
   */
  async refreshModelsCache(force = false): Promise<void> {
    if (!force && Date.now() < this.discoveryExpiry && this.discoveredModels.length > 0) return;
    try {
      const account = await this.pickHealthyAccount();
      if (!account) return;
      const apiKey = this.getApiKey(account);
      if (!apiKey) return;
      const res = await this.fetchWithTimeout(MODELS_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }, config.providerQuotaTimeoutMs);
      if (!res.ok) return;
      const data: any = await res.json().catch(() => ({}));
      const upstreamModels: any[] = Array.isArray(data?.data) ? data.data : [];
      const known = new Set(Object.keys(ALI_MODEL_MAP));
      const discovered: ModelInfo[] = [];
      for (const m of upstreamModels) {
        const upstream = typeof m?.id === "string" ? m.id : null;
        if (!upstream) continue;
        const id = `ali-${upstream}`;
        if (known.has(id)) continue; // curated already covers it (with verified spec)
        const spec = resolveModelSpec(upstream); // fill real specs where known
        // why: never emit 0 context/output. A discovered model with no registry
        // entry falls back to a conservative floor so max_tokens clamps work.
        discovered.push({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "alibaba",
          context_window: spec?.contextWindow ?? 128_000,
          max_output: spec?.maxOutput ?? 8_192,
          thinking: spec?.thinking ?? false,
          vision: spec?.vision ?? false,
          creditUnit: "token" as const,
          creditRate: 0.002 / 1000, // fallback rate; curated models keep their real rate
          creditSource: "estimated" as const,
        });
      }
      this.discoveredModels = discovered;
      this.discoveryExpiry = Date.now() + this.DISCOVERY_TTL_MS;
    } catch {
      // non-fatal — curated list stays served
    }
  }

  /** Pick any enabled alibaba account with a usable API key for discovery. */
  private async pickHealthyAccount(): Promise<Account | null> {
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, "alibaba"), eq(accounts.enabled, true)))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Routing ──────────────────────────────────────────────────────

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("ali-");
  }

  /**
   * Resolve proxy-facing model id (ali-qwen-plus) to upstream model name
   * (qwen-plus). Falls back to stripping the `ali-` prefix for dynamic
   * models not in the map.
   */
  private resolveModel(model: string): string {
    const lower = model.toLowerCase();
    const mapped = ALI_MODEL_MAP[lower];
    if (mapped) return mapped.upstream;
    // Fallback: strip `ali-` prefix for models the user may have added manually
    return lower.startsWith("ali-") ? lower.slice(4) : lower;
  }

  // ── Account helpers ──────────────────────────────────────────────

  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      return "";
    }
  }

  // ── Provider Interface ───────────────────────────────────────────

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const upstreamModel = this.resolveModel(request.model);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };

    const body: Record<string, unknown> = {
      model: upstreamModel,
      messages: request.messages,
      stream: false,
    };
    this.appendOptionalParams(body, request);

    try {
      const response = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, config.providerRequestTimeoutMs);

      const result = await this.handleOpenAIResponse(response, upstreamModel, request.model, request.messages);

      // Decrement per-model quota on success (aggregate handled by pool.decrementQuota).
      if (result.success && result.creditsUsed) {
        await this.decrementModelQuota(account, upstreamModel, result.creditsUsed);
      }

      // Model not activated on THIS account — drop from queryableModels and
      // zero remaining so ghost "1M left" does not keep this key in the walk.
      // NO invalid_model: prefix — that would fail-fast the whole request on
      // this one account; the router only surfaces invalid_model when EVERY
      // account lacks the model.
      if (!result.success && result.metadata?.modelUnavailable === true) {
        await this.dropModelFromQueryable(account, upstreamModel).catch(() => {});
        await this.setModelQuotaToZero(account, upstreamModel).catch(() => {});
        result.error = `Model "${upstreamModel}" not activated/purchased on this account`;
      }

      // Check if the upstream returned a quota-exhausted 403. handleOpenAIResponse
      // flags generic 403s as `banned`, but a quota-exhaustion body must NOT be a
      // terminal ban — rewrite it to quotaExhausted so the router parks the account
      // (self-reviving) instead of permanently banning it.
      if (!result.success && result.metadata?.errorText) {
        const errText = result.metadata.errorText as string;
        if (this.isFreeQuotaExhaustedError(errText)) {
          const { allModelsDrained } = await this.setModelQuotaToZero(account, upstreamModel)
            .catch(() => ({ allModelsDrained: false }));
          result.banned = false;
          result.quotaExhausted = true;
          result.error = `Free quota exhausted for "${upstreamModel}"`;
          result.metadata = { ...result.metadata, allModelsDrained };
        }
      }

      return result;
    } catch (err) {
      return { success: false, error: `Alibaba request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const upstreamModel = this.resolveModel(request.model);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "text/event-stream",
    };

    const body: Record<string, unknown> = {
      model: upstreamModel,
      messages: request.messages,
      stream: true,
    };
    this.appendOptionalParams(body, request);

    try {
      const response = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, config.providerRequestTimeoutMs);

      if (response.status === 401) {
        return { success: false, error: "Invalid API key (401)" };
      }
      if (response.status === 403) {
        const errText = await response.text().catch(() => "");
        // Free quota exhausted (various wordings / codes). Mark THIS model
        // drained and rotate — do NOT ban the whole account.
        if (this.isFreeQuotaExhaustedError(errText)) {
          const { allModelsDrained } = await this.setModelQuotaToZero(account, upstreamModel)
            .catch(() => ({ allModelsDrained: false }));
          return {
            success: false,
            error: `Free quota exhausted for "${upstreamModel}"`,
            quotaExhausted: true,
            metadata: { allModelsDrained },
          };
        }
        // AccessDenied.Unpurchased = this account cannot use this model right
        // now (never activated OR free package gone). Drop from queryable +
        // zero remaining so the dashboard stops showing "1M left", then rotate.
        if (
          errText.includes("AccessDenied.Unpurchased") ||
          /not activated|not purchased|unpurchased/i.test(errText)
        ) {
          await this.dropModelFromQueryable(account, upstreamModel).catch(() => {});
          await this.setModelQuotaToZero(account, upstreamModel).catch(() => {});
          return {
            success: false,
            error: `Model "${upstreamModel}" not activated/purchased on this account`,
            metadata: { modelUnavailable: true },
          };
        }
        return { success: false, error: `Forbidden (403): ${errText.slice(0, 200)}`, banned: true };
      }
      if (response.status === 429) {
        return { success: false, error: "Rate limited", rateLimited: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      return this.createStreamResponse(response, request.model, upstreamModel, account);
    } catch (err) {
      return { success: false, error: `Alibaba stream failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true }; // Static API key — user manages their own
  }

  async validateAccount(account: Account): Promise<boolean> {
    const apiKey = this.getApiKey(account);
    return apiKey.length > 0;
  }

  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    try {
      // Hit the quotas endpoint to get per-model limits.
      // The API is paginated (max page_size=100). We iterate until we have all pages.
      const existingTokens = this.parseQuotaTokens(account.tokens);
      const modelQuotas: AlibabaQuotaTokens["modelQuotas"] = {};
      let maxLimit = 0;
      let maxPeriod = 60;
      let pageNo = 1;
      const PAGE_SIZE = 100;
      let totalPages = 1;

      while (pageNo <= totalPages) {
        if (signal?.aborted) throw new Error("aborted");
        const url = `${QUOTAS_URL}?page_size=${PAGE_SIZE}&page_no=${pageNo}`;
        const response = await this.fetchWithTimeout(url, {
          method: "GET",
          headers: { "Authorization": `Bearer ${apiKey}` },
        }, config.providerQuotaTimeoutMs, signal);

        if (response.status === 401) return { success: false, error: "Invalid API key (401)" };
        if (!response.ok) {
          // If first page fails entirely, fall back.
          if (pageNo === 1) {
            return {
              success: true,
              quota: {
                limit: Number(account.quotaLimit || -1),
                remaining: Number(account.quotaRemaining || -1),
                used: Math.max(0, Number(account.quotaLimit || 0) - Number(account.quotaRemaining || 0)),
                resetAt: account.quotaResetAt,
              },
            };
          }
          // Later page failed — just use what we have.
          break;
        }

        const body = await response.json() as any;
        if (!body.success) {
          if (pageNo === 1) return { success: false, error: "Quota API rejected" };
          break;
        }

        // Determine total pages from first response
        if (pageNo === 1 && body.output?.total) {
          totalPages = Math.ceil(Number(body.output.total) / PAGE_SIZE);
        }

        const pageQuotas: Array<{
          model: string;
          model_limit: {
            usage_limit: number | null;
            usage_limit_field: string | null;
            usage_limit_period: number | null;
            request_limit: number | null;
            request_limit_period: number | null;
          } | null;
        }> = body.output?.quotas || [];

        for (const q of pageQuotas) {
          const ml = q.model_limit;
          if (ml?.usage_limit != null && typeof ml.usage_limit === "number" && ml.usage_limit > 0) {
            const limit = ml.usage_limit;
            const periodDays = ml.usage_limit_period ?? 60;

            // Preserve locally-tracked remaining (including 0 = drained).
            // Never re-inflate remaining from 0 → limit: that undoes
            // setModelQuotaToZero and re-dispatches dead free-tier packages.
            const existing = existingTokens[q.model];
            const remaining = existing
              ? Math.min(Math.max(0, Number(existing.remaining) || 0), limit)
              : limit;

            const resetAt = new Date();
            resetAt.setDate(resetAt.getDate() + periodDays);

            modelQuotas[q.model] = {
              limit,
              remaining,
              periodDays,
              resetAt: resetAt.toISOString(),
            };

            if (limit > maxLimit) maxLimit = limit;
            if (periodDays > maxPeriod) maxPeriod = periodDays;
          }
        }

        pageNo++;
      }

      if (maxLimit === 0) {
        // No usage limits found — key may be on a paid plan without caps.
        // Return undefined quota so the warmup preserves existing DB values.
        return { success: true, quota: undefined };
      }

      // Aggregate quota is meaningless for Alibaba since each model has its
      // own independent pool. Return undefined so warmup preserves existing
      // DB values instead of clobbering them with -1/-1.
      // Per-model quotas live in tokens.modelQuotas and are the source of truth.

      // Persist per-model quotas to account tokens for cross-session tracking.
      if (Object.keys(modelQuotas).length > 0) {
        // Preserve queryableModels — the probe writes it and pool selection
        // ranks on it; rebuilding the blob without it drops the probe state.
        const existingTokensBlob = account.tokens as AlibabaQuotaTokens | null;
        const tokens: AlibabaQuotaTokens = {
          modelQuotas,
          queryableModels: existingTokensBlob?.queryableModels,
          updatedAt: new Date().toISOString(),
        };
        // Fire-and-forget: save to DB, do NOT await (warmup already slow enough).
        db.update(accounts).set({ tokens: tokens as unknown }).where(eq(accounts.id, account.id)).run();
      }

      return { success: true, quota: undefined };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Override healthCheck to probe the DashScope API directly.
   *
   * Strategy:
   *   1. GET /v1/models — validates the API key is alive
   *   2. GET /api/v1/quotas — fetches per-model quota limits
   *   3. If quotas show all models as unpurchased, flag as auth error
   */
  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key" };
    }

    // Step 1: Probe /v1/models to validate key
    try {
      const modelsResp = await this.fetchWithTimeout(MODELS_URL, {
        method: "GET",
        headers: { "Authorization": `Bearer ${apiKey}` },
      }, config.providerQuotaTimeoutMs);

      if (modelsResp.status === 401) {
        return { kind: "session_expired", success: false, error: "API key rejected (HTTP 401)" };
      }
      if (!modelsResp.ok) {
        return { kind: "transient_error", success: false, retryable: true, error: `/v1/models returned HTTP ${modelsResp.status}` };
      }
    } catch (err) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Step 2: Fetch quota caps from /api/v1/quotas (gives us the limit per model)
    const quotaCaps = await this.fetchQuotaCaps(apiKey);

    // Step 3: Probe each tracked model with a minimal chat request.
    const tokens = this.parseQuotaTokens(account.tokens);
    const modelKeys = Object.keys(tokens);

    // Curated fallback used only when /api/v1/quotas returns nothing.
    const KEY_PROBE_MODELS = [
      "glm-5.2",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "kimi-k2.7-code",
    ];
    // Probe the full live catalog from /api/v1/quotas so newly-released models
    // (qwen3.8-max, deepseek-0731) get tracked; union keeps drained models.
    const capKeys = Object.keys(quotaCaps);
    const modelsToProbe = capKeys.length > 0
      ? Array.from(new Set([...capKeys, ...modelKeys]))
      : (modelKeys.length > 0 ? modelKeys : KEY_PROBE_MODELS);

    let anyAlive = false;

    // Probe ALL models in parallel with a global per-account timeout.
    // 457 accounts × 6 models = 2,742 probes. Sequential is way too slow.
    // why: stream:true + enable_thinking:false — thinking models reject
    // non-stream probes ("enable_thinking must be set to false for non-streaming"
    // / stream-only errors) and would never enter queryableModels.
    const probeResults = await Promise.allSettled(
      modelsToProbe.map(async (upstreamModel) => {
        const body = {
          model: upstreamModel,
          messages: [{ role: "user", content: "Just reply 1" }],
          stream: true,
          max_tokens: 1,
          enable_thinking: false,
        };

        const probeResp = await this.fetchWithTimeout(CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Accept": "text/event-stream",
          },
          body: JSON.stringify(body),
        }, 10_000);

        return { upstreamModel, probeResp };
      })
    );

    // Process all probe results and track queryable models
    const queryableModels: string[] = [];

    for (const result of probeResults) {
      if (result.status === "rejected") {
        // Network error — keep existing, assume alive if we already have data
        continue;
      }

      const { upstreamModel, probeResp } = result.value;

      if (probeResp.status === 401) {
        return { kind: "session_expired", success: false, error: "API key rejected (HTTP 401) during probe" };
      }

      if (probeResp.status === 403) {
        const errText = await probeResp.text().catch(() => "");
        if (this.isFreeQuotaExhaustedError(errText)) {
          const cap = quotaCaps[upstreamModel];
          tokens[upstreamModel] = {
            limit: cap || tokens[upstreamModel]?.limit || 1_000_000,
            remaining: 0,
            periodDays: tokens[upstreamModel]?.periodDays ?? 60,
            resetAt: null,
          };
          continue;
        }
        if (
          errText.includes("AccessDenied.Unpurchased") ||
          /not activated|not purchased|unpurchased/i.test(errText)
        ) {
          // Not usable on this key — keep out of queryableModels and zero remaining.
          const cap = quotaCaps[upstreamModel] || tokens[upstreamModel]?.limit || 1_000_000;
          tokens[upstreamModel] = {
            limit: cap,
            remaining: 0,
            periodDays: tokens[upstreamModel]?.periodDays ?? 60,
            resetAt: null,
          };
          continue;
        }
        anyAlive = true;
        continue;
      }

      // Stream probes return 200 with SSE body — drain so the socket is clean.
      if (probeResp.ok) {
        await probeResp.text().catch(() => {});
        anyAlive = true;
        queryableModels.push(upstreamModel);
        const cap = quotaCaps[upstreamModel];
        const existing = tokens[upstreamModel];
        // Successful probe proves the key can call the model. Reset remaining
        // to the free-package cap (or keep a positive local counter if lower).
        if (existing && existing.remaining > 0) {
          if (cap) existing.limit = cap;
        } else {
          tokens[upstreamModel] = {
            limit: cap || 1_000_000,
            remaining: cap || 1_000_000,
            periodDays: 60,
            resetAt: null,
          };
        }
      }
    }

    // Persist updated tokens with queryable models
    if (Object.keys(tokens).length > 0) {
      const quotaTokens: AlibabaQuotaTokens = {
        modelQuotas: tokens,
        queryableModels,
        updatedAt: new Date().toISOString(),
      };
      await db.update(accounts).set({ tokens: quotaTokens as unknown }).where(eq(accounts.id, account.id));
    }

    // Calculate aggregate quota across all models
    let totalLimit = 0;
    let totalRemaining = 0;
    let totalUsed = 0;
    
    for (const modelQuota of Object.values(tokens)) {
      if (modelQuota.limit > 0) {
        totalLimit += modelQuota.limit;
        totalRemaining += modelQuota.remaining;
        totalUsed += Math.max(0, modelQuota.limit - modelQuota.remaining);
      }
    }

    // Determine overall health
    const allExhausted = Object.keys(tokens).length > 0 &&
      Object.values(tokens).every((t) => t.remaining <= 0);

    if (allExhausted) {
      return {
        kind: "exhausted",
        success: true,
        quota: { 
          limit: totalLimit || -1, 
          remaining: 0, 
          used: totalUsed, 
          source: "alibaba.probe" 
        },
        message: "All models exhausted",
      };
    }

    return {
      kind: "healthy",
      success: true,
      quota: totalLimit > 0 ? {
        limit: totalLimit,
        remaining: totalRemaining,
        used: totalUsed,
        source: "alibaba.aggregate"
      } : undefined,
      metadata: { modelQuotas: tokens, queryableModels },
    };
  }

  /**
   * Fetch quota caps from /api/v1/quotas (returns usage_limit per model).
   * Used to get the ceiling limit for each model, not actual remaining.
   */
  private async fetchQuotaCaps(apiKey: string): Promise<Record<string, number>> {
    const caps: Record<string, number> = {};
    try {
      let pageNo = 1;
      const PAGE_SIZE = 100;
      let totalPages = 1;

      while (pageNo <= totalPages) {
        const url = `${QUOTAS_URL}?page_size=${PAGE_SIZE}&page_no=${pageNo}`;
        const response = await this.fetchWithTimeout(url, {
          method: "GET",
          headers: { "Authorization": `Bearer ${apiKey}` },
        }, config.providerQuotaTimeoutMs);

        if (!response.ok) break;
        const body = await response.json() as any;
        if (!body.success) break;

        if (pageNo === 1 && body.output?.total) {
          totalPages = Math.ceil(Number(body.output.total) / PAGE_SIZE);
        }

        for (const q of (body.output?.quotas || [])) {
          const ml = q.model_limit;
          if (ml?.usage_limit != null && typeof ml.usage_limit === "number" && ml.usage_limit > 0) {
            caps[q.model] = ml.usage_limit;
          }
        }
        pageNo++;
      }
    } catch {
      // Non-fatal — proceed without caps
    }
    return caps;
  }

  // ── Per-Model Quota Tracking ──────────────────────────────────────

  /**
   * Parse per-model quota data from the account's tokens JSON column.
   */
  private parseQuotaTokens(tokens: unknown): AlibabaQuotaTokens["modelQuotas"] {
    if (!tokens || typeof tokens !== "object") return {};
    const t = tokens as Record<string, unknown>;
    if (!t.modelQuotas || typeof t.modelQuotas !== "object") return {};
    return t.modelQuotas as AlibabaQuotaTokens["modelQuotas"];
  }

  /**
   * Decrement per-model quota after a successful completion.
   * Updates the account's tokens in the DB with the new remaining.
   *
   * ATOMICITY: re-reads the CURRENT tokens inside a transaction and writes
   * back, so two concurrent completions on the same account don't both
   * decrement from the same stale baseline (losing one decrement). The
   * passed-in `account` may be stale by the time this runs.
   */
  private async decrementModelQuota(
    account: Account,
    upstreamModel: string,
    creditsUsed: number,
  ): Promise<number> {
    return await db.transaction(async (tx) => {
      // Re-read the live tokens row under the transaction.
      const [row] = await tx.select({ tokens: accounts.tokens })
        .from(accounts)
        .where(eq(accounts.id, account.id))
        .limit(1);
      const tokens = this.parseQuotaTokens(row?.tokens);
      const entry = tokens[upstreamModel];
      if (!entry) {
        // Unknown model — nothing to decrement. The aggregate quotaRemaining
        // is handled by pool.decrementQuota() already.
        return -1;
      }

      const remaining = Math.max(0, entry.remaining - creditsUsed);
      entry.remaining = remaining;
      tokens[upstreamModel] = entry;

      // Preserve queryableModels from the live row — rebuilding without it
      // wipes probe results on every request, demoting the account to
      // "un-probed" in the ranked pool selection.
      const existing = (row?.tokens as AlibabaQuotaTokens | null) ?? null;
      const quotaTokens: AlibabaQuotaTokens = {
        modelQuotas: tokens,
        queryableModels: existing?.queryableModels,
        updatedAt: new Date().toISOString(),
      };

      await tx.update(accounts)
        .set({ tokens: quotaTokens as unknown })
        .where(eq(accounts.id, account.id));

      return remaining;
    });
  }

  /**
   * Remove a model from an account's queryableModels (the dispatch ledger).
   * Called when a live request proves the account does NOT have the model
   * activated (AccessDenied.Unpurchased). Dispatch then skips this account
   * for that model; a later warmup probe re-adds it if upstream activates it.
   *
   * Also zeros the modelQuotas remaining entry so the dashboard does not show
   * "1M left" for a key that just 403'd Unpurchased / free-quota-denied.
   */
  private async dropModelFromQueryable(account: Account, upstreamModel: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ tokens: accounts.tokens })
        .from(accounts)
        .where(eq(accounts.id, account.id))
        .limit(1);
      const existing = (row?.tokens as AlibabaQuotaTokens | null) ?? null;
      const modelQuotas = { ...(existing?.modelQuotas ?? {}) };
      const prev = modelQuotas[upstreamModel];
      if (prev) {
        modelQuotas[upstreamModel] = { ...prev, remaining: 0 };
      }
      const qm = existing?.queryableModels;
      const nextQm = Array.isArray(qm) ? qm.filter((m) => m !== upstreamModel) : qm;
      // No-op if neither field changes.
      if (
        (!prev || prev.remaining === 0) &&
        (!Array.isArray(qm) || !qm.includes(upstreamModel))
      ) {
        return;
      }
      const quotaTokens: AlibabaQuotaTokens = {
        modelQuotas,
        queryableModels: nextQm,
        updatedAt: new Date().toISOString(),
      };
      await tx.update(accounts)
        .set({ tokens: quotaTokens as unknown })
        .where(eq(accounts.id, account.id));
    });
  }

  /** True when a 403 body is free-quota / allocation exhaustion (not a ban). */
  private isFreeQuotaExhaustedError(errText: string): boolean {
    const t = (errText || "").toLowerCase();
    return (
      t.includes("quota has been exhausted") ||
      t.includes("free quota exhausted") ||
      t.includes("freetiersonly") ||
      t.includes("allocationquota") ||
      t.includes("throttling.allocation") ||
      // Alibaba docs: free-quota-done often surfaces as Access denied wording.
      (t.includes("access denied") && t.includes("free")) ||
      (t.includes("accessdenied") && t.includes("free"))
    );
  }

  /**
   * Zero a model's remaining quota after a quota-exhausted response.
   * Transactional (same pattern as decrementModelQuota): re-reads the live
   * tokens row so concurrent decrements aren't clobbered, and CREATES the
   * ledger entry when missing — otherwise the 403 is silently forgotten and
   * the account is re-picked for the very model that just drained.
   *
   * Returns allModelsDrained: true when no tracked model has quota left —
   * the router parks such accounts (status=exhausted) until warmup re-proves.
   */
  private async setModelQuotaToZero(
    account: Account,
    upstreamModel: string,
  ): Promise<{ allModelsDrained: boolean }> {
    const allModelsDrained = await db.transaction(async (tx) => {
      const [row] = await tx.select({ tokens: accounts.tokens })
        .from(accounts)
        .where(eq(accounts.id, account.id))
        .limit(1);
      const tokens = this.parseQuotaTokens(row?.tokens);
      // Evidence gate: an account with NO ledger data is never parked on a
      // single 403 — other models may still work, and the per-model gate in
      // getNextAccountForModel already keeps this model out of its dispatch.
      const hadLedgerData = Object.keys(tokens).length > 0;
      const entry = tokens[upstreamModel] ?? { limit: 0, remaining: 0, periodDays: 60, resetAt: null };
      entry.remaining = 0;
      tokens[upstreamModel] = entry;

      // Preserve queryableModels from the live row — rebuilding without it
      // wipes probe results (and would make the account look un-warmed).
      const existing = (row?.tokens as AlibabaQuotaTokens | null) ?? null;
      const quotaTokens: AlibabaQuotaTokens = {
        modelQuotas: tokens,
        queryableModels: existing?.queryableModels,
        updatedAt: new Date().toISOString(),
      };

      await tx.update(accounts)
        .set({ tokens: quotaTokens as unknown })
        .where(eq(accounts.id, account.id));

      return hadLedgerData && !Object.values(tokens).some((m) => m && m.remaining > 0);
    });
    return { allModelsDrained };
  }


  // ── Response Handling ─────────────────────────────────────────────

  /**
   * Handle OpenAI-compatible non-streaming response from DashScope.
   * Handles error codes like AccessDenied.Unpurchased.
   */
  private async handleOpenAIResponse(
    response: Response,
    upstreamModel: string,
    originalModel: string,
    messages: ChatCompletionRequest["messages"],
  ): Promise<ProviderResult> {
    if (response.status === 401) {
      return { success: false, error: "Invalid API key (401)" };
    }
    if (response.status === 403) {
      const errText = await response.text().catch(() => "");
      // Free-quota wording first — caller rewrites banned → quotaExhausted.
      if (this.isFreeQuotaExhaustedError(errText)) {
        return {
          success: false,
          error: `Forbidden (403): ${errText.slice(0, 200)}`,
          banned: true,
          metadata: { errorText: errText },
        };
      }
      if (
        errText.includes("AccessDenied.Unpurchased") ||
        /not activated|not purchased|unpurchased/i.test(errText)
      ) {
        // Caller drops queryable + zeros remaining; router free-hops peers.
        return {
          success: false,
          error: `Model "${upstreamModel}" not activated/purchased`,
          metadata: { modelUnavailable: true },
        };
      }
      return {
        success: false,
        error: `Forbidden (403): ${errText.slice(0, 200)}`,
        banned: true,
        metadata: { errorText: errText },
      };
    }
    if (response.status === 429) {
      return { success: false, error: "Rate limited", rateLimited: true };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Use 500 chars to ensure error codes like "data_inspection_failed"
      // aren't truncated (200 was too short for some DashScope error bodies).
      return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 500)}` };
    }

    // Check if response is SSE (some dashscope versions return SSE even with stream:false)
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return this.handleSSEAsNonStream(response, originalModel);
    }

    const data = (await response.json()) as ChatCompletionResponse & { error?: { code?: string; message?: string } };

    // Check for error in response body
    if (data.error) {
      if (data.error.code === "AccessDenied.Unpurchased") {
        return { success: false, error: `Model "${upstreamModel}" not activated/purchased`, metadata: { modelUnavailable: true } };
      }
      return { success: false, error: data.error.message || data.error.code || "Unknown upstream error" };
    }

    const choice = data.choices?.[0];
    if (!choice) return { success: false, error: "No choices in response" };

    const promptTokens = data.usage?.prompt_tokens || this.estimateMessagesTokens(messages);
    const completionTokens = data.usage?.completion_tokens || this.estimateTokens(
      typeof choice.message?.content === "string" ? choice.message.content : ""
    );

    // Return original prefixed model to the client
    data.model = originalModel;

    return {
      success: true,
      response: data,
      promptTokens,
      completionTokens,
      tokensUsed: promptTokens + completionTokens,
    };
  }

  /**
   * Handle unexpected SSE response from non-stream request.
   * Aggregates streaming chunks into a single completion response.
   */
  private async handleSSEAsNonStream(
    response: Response,
    originalModel: string,
  ): Promise<ProviderResult> {
    const text = await response.text();
    const lines = text.split("\n").filter((line) => line.startsWith("data: "));

    let aggregatedContent = "";
    let aggregatedReasoning = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
    let chunkId = "";
    let finishReason: string | null = null;

    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (payload === "[DONE]" || !payload || payload.startsWith(":")) continue;

      try {
        const chunk = JSON.parse(payload);

        if (chunk.error) {
          return {
            success: false,
            error: chunk.error.message || chunk.error.code || "Upstream error",
          };
        }

        if (!chunkId && chunk.id) chunkId = chunk.id;

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) aggregatedContent += delta.content;
        if (delta?.reasoning_content) aggregatedReasoning += delta.reasoning_content;

        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) usage = chunk.usage;
      } catch {
        // skip malformed
      }
    }

    if (!aggregatedContent && !usage.total_tokens) {
      return { success: false, error: "No valid data in SSE response" };
    }

    const message: any = { role: "assistant", content: aggregatedContent };
    if (aggregatedReasoning) {
      message.reasoning_content = aggregatedReasoning;
    }

    const completionResponse: ChatCompletionResponse = {
      id: chunkId || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{
        index: 0,
        message,
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

  /**
   * Create a pass-through stream for streaming responses.
   * Rewrites model id back to the original prefixed model name.
   */
  private createStreamResponse(
    response: Response,
    originalModel: string,
    upstreamModel: string,
    account?: Account,
  ): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();
    const upstream = response.body!;
    let captureError: string | null = null;
    let lastUsage: { total_tokens?: number } | null = null;
    const self = this; // capture for ReadableStream context

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader();
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
                // On stream done, decrement per-model quota if we have usage info.
                if (account && lastUsage?.total_tokens) {
                  self.decrementModelQuota(account, upstreamModel, lastUsage.total_tokens).catch(() => {});
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              try {
                const chunk = JSON.parse(payload);

                // Track final usage from the last chunk that has usage data.
                if (chunk.usage) {
                  lastUsage = chunk.usage;
                }

                // Check for errors in stream chunks
                if (chunk.error) {
                  captureError = chunk.error.message || chunk.error.code || "Stream error";
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ error: { message: captureError } })}\n\n`
                  ));
                  continue;
                }

                chunk.model = originalModel;
                chunk.id = id;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                // skip malformed
              }
            }
          }

          // Stream ended without [DONE] — still decrement if we have usage.
          if (account && lastUsage?.total_tokens) {
            self.decrementModelQuota(account, upstreamModel, lastUsage.total_tokens).catch(() => {});
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch { /* already errored */ }
        }
      },
    });

    return {
      success: true,
      stream,
      promptTokens: 0,
      completionTokens: 0,
      tokensUsed: 0,
      error: captureError || undefined,
    };
  }

  // ── Shared Utilities ─────────────────────────────────────────────

  private appendOptionalParams(body: Record<string, unknown>, request: ChatCompletionRequest): void {
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;

    // DashScope thinking config — uses enable_thinking + thinking_budget.
    // Docs: https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope
    //
    // CRITICAL: Explicitly set enable_thinking based on client request, AND only
    // when the model supports thinking (per the catalog). Enable signals:
    // -thinking suffix, non-"none" reasoning_effort, or any thinking.type
    // other than "disabled" (Claude Code defaults to "adaptive", which means
    // "model decides" — upstreams that support thinking should honor it).
    const actualModel = request.model.endsWith("-thinking") ? request.model.replace(/-thinking$/, "") : request.model;
    // resolveModelSpec is keyed by the canonical upstream name (no provider
    // prefix), so resolve the client-facing ali-* id first — otherwise the
    // lookup always misses and enable_thinking is force-disabled below even
    // when the client asked for thinking on a thinking-capable model.
    const spec = resolveModelSpec(this.resolveModel(actualModel));
    const effort = request.reasoning_effort;
    const thinkType = (request.thinking as any)?.type;
    const clientWantsThinking =
      request.model.endsWith("-thinking") ||
      (typeof effort === "string" && effort !== "" && effort !== "none") ||
      (thinkType && thinkType !== "disabled");
    if (spec?.thinking && clientWantsThinking) {
      body.enable_thinking = true;
      const budget = (request.thinking as any)?.budget_tokens;
      if (typeof budget === "number") body.thinking_budget = budget;
    } else {
      body.enable_thinking = false;
    }
  }
}
