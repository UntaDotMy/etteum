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
import { config } from "../../../config";
import { resolveModelSpec } from "../../model-specs";
import { getUpstreamNameOverride } from "../custom-models";

interface CodeBuddyChinaTokens {
  api_key?: string;
  access_token?: string;
  session_token?: string;
}

/** Map cbc- prefixed model IDs to actual CodeBuddy China API model names. */
const CBC_MODEL_MAP: Record<string, string> = {
  // Claude
  "cbc-haiku-4.5": "claude-haiku-4.5",
  // DeepSeek
  "cbc-deepseek-r1": "deepseek-r1",
  "cbc-deepseek-v3": "deepseek-v3",
  "cbc-deepseek-v3-2-volc": "deepseek-v3-2-volc",
  "cbc-deepseek-v4-flash": "deepseek-v4-flash",
  "cbc-deepseek-v4-pro": "deepseek-v4-pro",
  // Kimi (Moonshot)
  "cbc-kimi-k2.5": "kimi-k2.5",
  "cbc-kimi-k2.6": "kimi-k2.6",
  "cbc-kimi-k2.7": "kimi-k2.7",
  "cbc-kimi-k3": "kimi-k3",
  // GLM (Zhipu)
  "cbc-glm-5.1": "glm-5.1",
  "cbc-glm-5.2": "glm-5.2",
  "cbc-glm-5v-turbo": "glm-5v-turbo",
  // MiniMax
  "cbc-minimax-m3": "minimax-m3",
  // Hunyuan (Tencent)
  "cbc-hy3-preview": "hy3-preview",
};

/**
 * Tencent billing "package" identifiers (ProductCode p_tcaca). The
 * get-user-resource response returns one Accounts[] row per *active* package;
 * asking for all known codes ensures gift / activity rows are included.
 * Source: 9router CODEBUDDY_CONFIG.packageCodes / Kiro-Go codebuddy_quota.go.
 */
const CBC_PACKAGE_CODES: Array<{ code: string; label: string }> = [
  { code: "TCACA_code_001_PqouKr6QWV", label: "free" },
  { code: "TCACA_code_002_AkiJS3ZHF5", label: "pro monthly" },
  { code: "TCACA_code_003_FAnt7lcmRT", label: "pro yearly" },
  { code: "TCACA_code_006_DbXS0lrypC", label: "gift" },
  { code: "TCACA_code_007_nzdH5h4Nl0", label: "activity" },
  { code: "TCACA_code_008_cfWoLwvjU4", label: "free monthly" },
  { code: "TCACA_code_009_0XmEQc2xOf", label: "extra" },
];
const CBC_PACKAGE_LABELS: Record<string, string> = Object.fromEntries(
  CBC_PACKAGE_CODES.map((p) => [p.code, p.label])
);

/** One credit package owned by the account (refill allowance or one-shot bonus). */
interface CbcPackage {
  name: string;
  packageCode: string;
  kind: "refill" | "bonus";
  used: number;
  total: number;
  remaining: number;
  resetAt: string | null;
}

/** Result of a daily-checkin claim. `already` means it was claimed earlier today. */
interface CbcDailyClaim {
  attempted: boolean;
  claimed: boolean;
  already: boolean;
  credit: number;
  streakDays: number;
  error?: string;
}

/**
 * Default CodeBuddy-CN growth invite code (9router enow CN_DEFAULT_INVITE_CODE).
 * Only used for the one-time first-activation gift.
 */
const CBC_DEFAULT_INVITE_CODE = "yro4ic1m1pc";

/**
 * One-time first-activation outcome, persisted at metadata.activation. The
 * presence of `status` is the once-per-account guard: warmup only attempts
 * activation when no prior status exists, so it fires at most once per account.
 * `unverified` = the raw API shape could not be confirmed (best-effort, matches
 * 9router's activation_skipped) — still terminal, never retried.
 */
interface CbcActivation {
  status: "activated" | "already_active" | "unverified";
  method: "api" | null;
  attemptedAt: string;
  error?: string;
}

/**
 * CodeBuddy China Provider — codebuddy.cn region
 *
 * Same API format as CodeBuddy global (codebuddy.ai) but:
 * - Base URL: https://www.codebuddy.cn
 * - Auth: Bearer API key (ck_* prefix)
 * - Streaming only (non-stream returns error 11101)
 * - China-specific models (GLM, Kimi, DeepSeek V4, Hunyuan, MiniMax)
 * - Credit tracking via usage.credit in stream chunks
 */
export class CodeBuddyChinaProvider extends BaseProvider {
  name = "codebuddy-china";

  override ownsModel(model: string): boolean {
    const m = model.toLowerCase();
    if (m.startsWith("cbc-")) return true;
    // Live-discovered catalog ids (auto-fetched from GET {base}/v2/models).
    if (this.liveModelIds.has(m)) return true;
    return false;
  }

  /**
   * Live-discovered catalog from GET {baseUrl}/v2/models, refreshed at boot
   * (refreshCodebuddyChinaModels) and on a TTL. Curated models always win on id
   * collision; discovery is additive so new upstream models appear without
   * manual additions. Never throws — on failure the curated list stays served.
   */
  private liveModels: ModelInfo[] = [];
  private liveModelIds = new Set<string>();
  private catalogFetchedAt = 0;
  private static readonly CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h

  /**
   * Refresh the live model catalog from the first active+enabled codebuddy-china
   * account's API key (ck_*). Never throws.
   */
  async refreshModelsCache(force = false): Promise<void> {
    if (!force && Date.now() - this.catalogFetchedAt < CodeBuddyChinaProvider.CATALOG_TTL_MS && this.liveModels.length > 0) {
      return; // fresh enough
    }
    try {
      const rows = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.provider, "codebuddy-china"), eq(accounts.enabled, true), eq(accounts.status, "active")))
        .limit(1);
      const account = rows[0];
      if (!account) return; // no active account → keep curated fallback

      const tokens = this.getTokens(account);
      const apiKey = tokens ? this.getApiKey(tokens) : null;
      if (!apiKey) return;

      const res = await fetch(`${this.baseUrl}/v2/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return;
      const data: any = await res.json().catch(() => ({}));
      const upstreamModels: any[] = Array.isArray(data?.data) ? data.data : [];
      if (upstreamModels.length === 0) return;

      // Curated wins: index by id so a discovered id never overrides a curated spec.
      const curated = new Map(this.supportedModels.map((m) => [m.id, m]));
      const merged = new Map<string, ModelInfo>(curated);
      const liveIds = new Set<string>([...curated.keys()].map((s) => s.toLowerCase()));
      for (const m of upstreamModels) {
        const upstream = typeof m?.id === "string" ? m.id : null;
        if (!upstream) continue;
        const id = upstream.toLowerCase().startsWith("cbc-") ? upstream : `cbc-${upstream}`;
        if (merged.has(id)) continue; // curated already covers it (with verified spec)
        // Strip the cbc- prefix and re-map to the upstream name so specs resolve
        // from the central registry (cbc-deepseek-v4-flash -> deepseek-v4-flash).
        const canonical = id.replace(/^cbc-/, "");
        const spec = resolveModelSpec(canonical);
        merged.set(id, {
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "codebuddy-china",
          context_window: spec?.contextWindow ?? 0,
          max_output: spec?.maxOutput ?? 0,
          thinking: spec?.thinking ?? false,
          vision: spec?.vision ?? false,
          creditUnit: "credit" as const,
          creditRate: 0.01, // fallback rate; curated models keep their real rate
          creditSource: "estimated" as const,
        });
        liveIds.add(id.toLowerCase());
      }
      this.liveModels = [...merged.values()];
      this.liveModelIds = liveIds;
      this.catalogFetchedAt = Date.now();
    } catch (e) {
      console.error("[codebuddy-china] refreshModelsCache failed:", e instanceof Error ? e.message : e);
    }
  }

  override getModels(): ModelInfo[] {
    return this.liveModels.length > 0 ? this.liveModels : this.supportedModels;
  }

  /**
   * Resolve a proxy-facing model id to the upstream API model name.
   * Handles the `-thinking` suffix the same way CodeBuddy global does:
   * strip it for lookup, re-apply it after resolution so the upstream
   * knows to enable extended thinking.
   */
  private resolveModel(model: string): string {
    // Operator-set upstream-name override (catalog rename) wins.
    const override = getUpstreamNameOverride(model);
    if (override) return override;
    const isThinking = model.endsWith("-thinking");
    const base = isThinking ? model.replace(/-thinking$/, "") : model;
    const resolved = CBC_MODEL_MAP[base.toLowerCase()] || base;
    return isThinking ? `${resolved}-thinking` : resolved;
  }

  private baseUrl = "https://www.codebuddy.cn";

  /**
   * Model used for the chat-endpoint ban probe. Must be a model that is actually
   * enabled on CodeBuddy-CN accounts, otherwise the endpoint returns 403 for a
   * *model-availability* reason and the probe false-positives every account as
   * banned. `hy3-preview` (Tencent Hunyuan) is the safest choice — deprecated
   * models like the old `deepseek-v3` can 403 on healthy accounts.
   */
  private probeModel = "hy3-preview";

  supportedModels: ModelInfo[] = [
    // Claude
    { id: "cbc-haiku-4.5", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.11, creditSource: "upstream" },
    // DeepSeek — r1 / v3 are text-only; v3-2-volc / v4-flash / v4-pro support vision
    { id: "cbc-deepseek-r1", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: true, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v3-2-volc", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v4-flash", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 8192, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v4-pro", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 8192, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.03, creditSource: "upstream" },
    // Kimi — k2.5 / k2.6 support vision; k2.7 is flaky (sometimes works with all-fields format)
    { id: "cbc-kimi-k2.5", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 164000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.05, creditSource: "upstream" },
    { id: "cbc-kimi-k2.6", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 256000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.09, creditSource: "upstream" },
    { id: "cbc-kimi-k2.7", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 256000, max_output: 8192, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.07, creditSource: "upstream" },
    // Kimi K3 flagship (July 2026) — 1M combined context; max_completion_tokens up to 1_048_576.
    // creditRate estimated from k2.7 ratio × OpenRouter $3/$15
    { id: "cbc-kimi-k3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1048576, max_output: 1048576, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.20, creditSource: "estimated" },
    // GLM — 5.1 / 5.2 / 5v-turbo all support vision (5v-turbo is the dedicated vision model)
    { id: "cbc-glm-5.1", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 8192, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5.2", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 8192, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5v-turbo", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.03, creditSource: "upstream" },
    // MiniMax — vision support is flaky upstream (model often replies "I don't see"), kept enabled for parity
    { id: "cbc-minimax-m3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 512000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.10, creditSource: "upstream" },
    // Hunyuan — model itself always replies "I can't see the image" even with payload accepted; vision disabled
    { id: "cbc-hy3-preview", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 192000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
  ];

  /** Cache for resolved tool schemas — the assistant sends the same tools every request */
  private schemaCache = new Map<string, any>();
  private static readonly SCHEMA_CACHE_MAX = 200;

  private getTokens(account: Account): CodeBuddyChinaTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string"
        ? JSON.parse(account.tokens)
        : account.tokens;
      return t as CodeBuddyChinaTokens;
    } catch {
      return null;
    }
  }

  private getApiKey(tokens: CodeBuddyChinaTokens): string | null {
    return tokens.api_key || tokens.access_token || tokens.session_token || null;
  }

  /**
   * Read a previously-persisted activation result from account.metadata.activation.
   * Returns null when absent or malformed — which is exactly what triggers the
   * one-time attempt. Any well-formed prior result (even `unverified`) is returned
   * so warmup never re-fires activation for that account.
   */
  private getPriorActivation(account: Account): CbcActivation | null {
    try {
      const meta = typeof account.metadata === "string" ? JSON.parse(account.metadata) : account.metadata;
      const a = (meta as Record<string, unknown> | null)?.activation as CbcActivation | undefined;
      if (a && typeof a === "object" && typeof a.status === "string" && a.status.length > 0) {
        return a;
      }
      return null;
    } catch {
      return null;
    }
  }

  private buildHeaders(apiKey: string, stream = false): Record<string, string> {
    return {
      "Accept": stream ? "text/event-stream, application/json, */*" : "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Conversation-ID": crypto.randomUUID(),
      "X-Request-ID": crypto.randomUUID().replace(/-/g, ""),
      "X-Domain": "www.codebuddy.cn",
      "X-Product": "SaaS",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
  }

  /**
   * Clean messages: convert Anthropic-format content blocks (tool_use, tool_result)
   * to OpenAI-format (tool_calls, tool messages). Also handle agent system prompt
   * detection and replacement.
   *
   * CodeBuddy China vision: images in content blocks are extracted and sent as
  /**
   * Convert request messages from Anthropic format to OpenAI format compatible with
   * CodeBuddy China's `/v2/chat/completions` upstream.
   *
   * Vision images use the STANDARD OpenAI format: `image_url` blocks INSIDE the
   * `content` array (NOT hoisted to top-level fields). This was confirmed by
   * reverse-engineering zxyblzcat/uniview-codebuddy-proxy and verified by direct
   * upstream testing — models glm-4.6v, glm-5v-turbo, and deepseek-v3-2-volc
   * return accurate, non-hallucinated descriptions with this format.
   *
   * The PREVIOUS approach (top-level `files` + `image_url` + `images` + `vision: true`
   * flag with text-flattened content) produced 100% hallucinated/blind responses
   * because the upstream silently dropped the image data — see commit history.
   */
  private cleanMessages(request: ChatCompletionRequest): { messages: any[]; hasVision: boolean } {
    // Messages are already normalized to canonical OpenAI format by the
    // proxy entry points (normalizeRequestToOpenAI / anthropicToOpenAI).
    // We only need provider-specific post-processing here.
    const cleanedMessages: any[] = [];
    let hasVision = false;

    for (const msg of request.messages) {
      // Detect and replace agent system prompts
      if (msg.role === "system" && typeof msg.content === "string" && this.isAgentSystemPrompt(msg.content)) {
        cleanedMessages.push({
          role: "system",
          content: "You are a helpful AI assistant that helps with software engineering tasks.",
        });
        continue;
      }

      // Detect vision content in multimodal arrays
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block?.type === "image_url" || block?.type === "image") {
            hasVision = true;
            break;
          }
        }
      }

      cleanedMessages.push(msg);
    }

    return { messages: cleanedMessages, hasVision };
  }

  private isAgentSystemPrompt(content: string): boolean {
    if (content.length > 2000) return true;
    // Broad detection for AI agent/CLI tool system prompts
    const patterns = [
      /claude.*official.*cli/i,
      /code.*official.*cli/i,
      /you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)/i,
      /you are an? (?:ai )?(?:coding |code )?agent/i,
      /cc_entrypoint/i,
      /OhMyOpenCode/i,
      /<agent-identity>/i,
    ];
    return patterns.some((p) => p.test(content));
  }

  /**
   * Normalize tools from Anthropic/Claude format to OpenAI function-calling format.
   * Also sanitize schemas (resolve $ref, strip unsupported fields).
   */
  private normalizeTools(tools: any[] | undefined): any[] {
    if (!tools || tools.length === 0) return [];

    return tools.map((tool) => {
      if (tool.type === "function" && tool.function) {
        return {
          type: "function",
          function: {
            name: tool.function.name,
            description: tool.function.description || "",
            parameters: this.sanitizeToolSchema(tool.function.parameters),
          },
        };
      }

      // Convert Anthropic/Claude format to OpenAI format
      const fn = tool.function || tool;
      const name = fn?.name || tool?.name;
      const description = fn?.description || tool?.description || "";
      const parameters = fn?.parameters || fn?.input_schema || { type: "object", properties: {} };

      return {
        type: "function",
        function: {
          name,
          description,
          parameters: this.sanitizeToolSchema(parameters),
        },
      };
    }).filter((t: any) => t.function?.name);
  }

  private sanitizeToolSchema(schema: any): any {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return { type: "object", properties: {} };
    }

    const cacheKey = JSON.stringify(schema);
    const cached = this.schemaCache.get(cacheKey);
    if (cached) return cached;

    const defs = { ...(schema.$defs || {}), ...(schema.definitions || {}) };
    let resolved = Object.keys(defs).length > 0 || this.hasRefs(schema)
      ? this.resolveSchemaRefs(schema, defs)
      : { ...schema };

    for (const key of ["$schema", "$id", "$comment", "$defs", "definitions"]) {
      delete resolved[key];
    }

    if (!resolved.type) resolved.type = "object";
    if (resolved.type === "object" && !resolved.properties) {
      resolved.properties = {};
    }
    if (resolved.required && !Array.isArray(resolved.required)) {
      delete resolved.required;
    }

    if (this.schemaCache.size >= CodeBuddyChinaProvider.SCHEMA_CACHE_MAX) {
      this.schemaCache.clear();
    }
    this.schemaCache.set(cacheKey, resolved);

    return resolved;
  }

  private resolveSchemaRefs(schema: any, defs: Record<string, any>, seen = new Set<string>()): any {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map((item: any) => this.resolveSchemaRefs(item, defs, seen));

    if (schema.$ref && typeof schema.$ref === "string") {
      const refPath = schema.$ref.replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
      if (seen.has(refPath)) return { type: "object", description: `(circular ref: ${refPath})` };
      const resolved = defs[refPath];
      if (resolved) {
        seen.add(refPath);
        const result = this.resolveSchemaRefs({ ...resolved }, defs, seen);
        seen.delete(refPath);
        return result;
      }
      return { type: "object" };
    }

    const clone: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$defs" || key === "definitions") continue;
      clone[key] = this.resolveSchemaRefs(value, defs, seen);
    }
    return clone;
  }

  private hasRefs(obj: any): boolean {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj)) return obj.some((item: any) => this.hasRefs(item));
    if ("$ref" in obj) return true;
    return Object.values(obj).some((value: any) => this.hasRefs(value));
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key available" };

    try {
      // Always stream — CodeBuddy China doesn't support non-stream
      const response = await this.makeRequest(apiKey, request, true);

      if (response.status === 401) {
        return { success: false, error: "Session expired (401)" };
      }
      if (response.status === 403) {
        // 403 can mean banned/restricted (code 11140 "request illegal") or
        // content moderation. Read the body to distinguish.
        const errBody = await response.text().catch(() => "");
        try {
          const parsed = JSON.parse(errBody);
          if (parsed.code === 11140 || parsed.msg?.includes("illegal")) {
            return { success: false, error: `Account banned or restricted (403): ${errBody}`, banned: true };
          }
        } catch { /* not JSON */ }
        return { success: false, error: `Forbidden (403): ${errBody.slice(0, 200)}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Rate limited / quota exhausted", quotaExhausted: true };
      }
      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `CodeBuddy China API error (${response.status}): ${errText}` };
      }

      const data = await this.aggregateStreamResponse(response, request.model);
      const totalTokens = data.usage.total_tokens || 0;
      const realCredit = (data as any)._realCredit;
      const creditsUsed = realCredit != null ? realCredit : (totalTokens > 0 ? totalTokens * this.getProviderCreditRate(request.model) : 0);
      const creditSource: "upstream" | "estimated" = realCredit != null ? "upstream" : "estimated";
      delete (data as any)._realCredit;

      return {
        success: true,
        response: data,
        tokensUsed: totalTokens,
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        creditsUsed,
        creditSource,
      };
    } catch (error) {
      return { success: false, error: `CodeBuddy China request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key available" };

    try {
      const response = await this.makeRequest(apiKey, request, true);

      if (response.status === 401) {
        return { success: false, error: "Session expired (401)" };
      }
      if (response.status === 403) {
        const errBody = await response.text().catch(() => "");
        try {
          const parsed = JSON.parse(errBody);
          if (parsed.code === 11140 || parsed.msg?.includes("illegal")) {
            return { success: false, error: `Account banned or restricted (403): ${errBody}`, banned: true };
          }
        } catch { /* not JSON */ }
        return { success: false, error: `Forbidden (403): ${errBody.slice(0, 200)}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Rate limited", quotaExhausted: true };
      }
      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `CodeBuddy China API error (${response.status}): ${errText}` };
      }

      return this.createStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `CodeBuddy China stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(
    _account: Account
  ): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "CodeBuddy China uses static API keys — no refresh" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!this.getApiKey(tokens || {} as CodeBuddyChinaTokens);
  }

  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null; packages?: CbcPackage[] };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key" };

    try {
      const response = await this.fetchUserResource(tokens, signal);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      if (data.code !== 0) {
        return { success: false, error: `API error code ${data.code}` };
      }

      return { success: true, quota: this.parseResourceQuota(data) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    const apiKey = this.getApiKey(tokens || {} as CodeBuddyChinaTokens);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key available" };
    }

    // Primary check: fetch real billing data via /v2/billing/meter/get-user-resource
    // This endpoint works with API key and gives us both auth validation AND real credit data.
    let quota = await this.fetchQuota(account, signal);
    let dailyClaim: CbcDailyClaim | null = null;
    let activation: CbcActivation | null = null;
    if (quota.success && quota.quota) {
      // Warmup hook: claim the daily-checkin gift for this account. Already-claimed
      // is a normal no-op (never an error). On a fresh claim we re-read quota once
      // so the new credits are reflected. A failed claim must never poison the account.
      dailyClaim = await this.claimDailyGift(apiKey, signal);
      if (dailyClaim.claimed && !dailyClaim.already) {
        quota = (await this.fetchQuota(account, signal)) ?? quota;
      }

      // One-time first-activation gift. Once-per-account guard: only attempt when
      // metadata.activation has no prior status. Whatever we get back (activated /
      // already_active / unverified) is persisted, so it never fires twice. A newly
      // activated account re-reads quota once to surface the granted credits.
      const priorActivation = this.getPriorActivation(account);
      if (priorActivation) {
        activation = priorActivation;
      } else {
        activation = await this.claimActivation(apiKey, CBC_DEFAULT_INVITE_CODE, signal);
        if (activation.status === "activated") {
          quota = (await this.fetchQuota(account, signal)) ?? quota;
        }
      }
    }
    if (quota.success && quota.quota) {
      // Billing API succeeded — but billing success does NOT mean the chat API works.
      // CodeBuddy China can return 403 {"code":11140,"msg":"request illegal"} on the
      // chat endpoint while billing works fine (account is banned/restricted from chat
      // but still has credits). We MUST probe the chat endpoint to verify.
      //
      // Always probe — catches bans early instead of letting the first real request
      // hit a 403 and poison the account.
      //
      // validateApiKey() checks billing first, which would return "ok" for banned
      // accounts (billing works even when chat is blocked). So we call the
      // dedicated chat probe directly.
      const chatStatus = await this.probeChatEndpoint(apiKey);
      if (chatStatus === "banned") {
        return {
          kind: "banned",
          success: false,
          error: "Account banned or restricted from chat (code 11140). Billing works but chat API returns 403.",
          quota: { ...quota.quota, source: "codebuddy-china.get-user-resource" },
          metadata: {
            credit_total_dosage: quota.quota.limit,
            credit_capacity_remain: quota.quota.remaining,
            credit_capacity_used: quota.quota.used,
            lastRealBillingSync: new Date().toISOString(),
            chatBanned: true,
            packages: quota.quota.packages,
            dailyClaim,
            activation,
          },
        };
      }
      // If chat probe failed transiently (network error, etc.), still report healthy
      // — billing confirmed the key is valid, chat might just be temporarily down.
      return {
        kind: quota.quota.remaining <= 0 ? "exhausted" : "healthy",
        success: true,
        quota: { ...quota.quota, source: "codebuddy-china.get-user-resource" },
        metadata: {
          credit_total_dosage: quota.quota.limit,
          credit_capacity_remain: quota.quota.remaining,
          credit_capacity_used: quota.quota.used,
          credit_capacity_size: quota.quota.limit,
          lastRealBillingSync: new Date().toISOString(),
          chatProbe: chatStatus,
          packages: quota.quota.packages,
          dailyClaim,
          activation,
        },
      };
    }

    // Billing API auth failure — distinguish 401 (expired key) from 403 (revoked/banned)
    if (quota.error?.includes("401")) {
      return {
        kind: "session_expired",
        success: false,
        error: "CodeBuddy China API key expired (billing returned 401)",
      };
    }
    if (quota.error?.includes("403")) {
      return {
        kind: "banned",
        success: false,
        error: "CodeBuddy China API key revoked or banned (billing returned 403)",
      };
    }

    // Fallback: validate via chat completions endpoint
    const apiStatus = await this.validateApiKey(tokens || {} as CodeBuddyChinaTokens);

    if (apiStatus === "ok") {
      // API works but billing failed (transient) — report as healthy with stored quota
      const storedQuota = Number(account.quotaRemaining || 0);
      const storedLimit = Number(account.quotaLimit || 0);
      return {
        kind: "healthy",
        success: true,
        quota: storedLimit > 0
          ? { limit: storedLimit, remaining: storedQuota, used: storedLimit - storedQuota, source: "tracked" }
          : undefined,
        message: `Billing API transient error (${quota.error}). Using tracked credit: ${storedQuota.toFixed(1)}/${storedLimit.toFixed(1)}`,
      };
    }

    if (apiStatus === "quota_exhausted") {
      return { kind: "exhausted", success: true, error: "Provider returned 429 - quota exhausted" };
    }

    if (apiStatus === "banned") {
      return {
        kind: "banned",
        success: false,
        error: "CodeBuddy China API returned 403 (code 11140) — account banned or restricted from chat",
      };
    }

    // API returned 401 - truly expired
    return {
      kind: "session_expired",
      success: false,
      error: "CodeBuddy China API returned 401 - session expired, re-login required",
    };
  }

  /**
   * Check if the api_key can make actual requests to the provider.
   * Uses the billing API endpoint which validates the API key without consuming credits.
   * Falls back to chat completions endpoint if billing check fails.
   * Returns: "ok" | "quota_exhausted" | "expired" | "banned"
   *
   * Key distinction:
   * - 401 = auth failure (expired/invalid key) → needs re-login
   * - 403 = forbidden (banned/restricted) → key is valid but account blocked from chat.
   *   CodeBuddy China returns {"code":11140,"msg":"request illegal"} for banned accounts.
   *   The billing API still works for banned accounts, so we MUST probe the chat endpoint
   *   to detect this condition.
   */
  /**
   * Dedicated chat endpoint probe — does NOT check billing.
   * Sends a minimal streaming request and aborts immediately after receiving
   * the HTTP status code. This is the ONLY reliable way to detect bans because
   * CodeBuddy China's billing API works even for banned accounts.
   *
   * Returns: "ok" | "quota_exhausted" | "expired" | "banned"
   */
  private async probeChatEndpoint(apiKey: string): Promise<"ok" | "quota_exhausted" | "expired" | "banned"> {
    const controller = new AbortController();
    try {
      const response = await fetch(`${this.baseUrl}/v2/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: this.buildHeaders(apiKey, true),
        body: JSON.stringify({
          model: this.probeModel,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
          stream: true,
        }),
      });

      // Got HTTP status - abort immediately to avoid consuming tokens
      controller.abort();

      if (response.status === 401) return "expired";
      if (response.status === 403) {
        // Read the body to check for code 11140 (banned) vs other 403s
        // We already aborted, so text() may throw — clone first
        try {
          const cloned = response.clone();
          const errBody = await cloned.text().catch(() => "");
          const parsed = JSON.parse(errBody);
          if (parsed.code === 11140 || parsed.msg?.includes("illegal")) {
            return "banned";
          }
        } catch { /* not JSON or already aborted */ }
        return "banned"; // Treat all 403s from chat endpoint as banned
      }
      if (response.status === 429) return "quota_exhausted";
      return "ok";
    } catch (err: any) {
      // AbortError is expected (we aborted on purpose after getting status)
      if (err?.name === "AbortError") return "ok";
      // Network error - assume ok to avoid false negatives
      return "ok";
    }
  }

  private async validateApiKey(tokens: CodeBuddyChinaTokens): Promise<"ok" | "quota_exhausted" | "expired" | "banned"> {
    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return "expired";

    // Primary: use billing API to validate — doesn't consume credits and gives definitive auth status
    try {
      const response = await this.fetchUserResource(tokens);
      if (response.status === 401) return "expired";
      if (response.status === 403) return "banned";
      if (response.status === 429) return "quota_exhausted";
      if (response.ok) {
        const data = await response.json() as any;
        if (data.code === 0) return "ok";
        // Non-zero code but HTTP 200 — API key is valid, just a business logic error
        return "ok";
      }
      // Other HTTP errors — fall through to chat endpoint check
    } catch {
      // Network error on billing — fall through to chat endpoint check
    }

    // Fallback: use chat completions endpoint (abort immediately after status)
    return this.probeChatEndpoint(apiKey);
  }

  private async fetchUserResource(tokens: CodeBuddyChinaTokens, signal?: AbortSignal): Promise<Response> {
    const now = new Date();
    const endDate = new Date(now.getTime() + 365 * 20 * 24 * 60 * 60 * 1000);
    const payload = {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageCodes: CBC_PACKAGE_CODES.map((p) => p.code),
      PackageEndTimeRangeBegin: now.toISOString().replace("T", " ").slice(0, 19),
      PackageEndTimeRangeEnd: endDate.toISOString().replace("T", " ").slice(0, 19),
    };

    // Use /v2/billing/meter/get-user-resource which works with API key (Bearer token).
    const apiKey = this.getApiKey(tokens);
    const headers: Record<string, string> = {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    return this.fetchWithTimeout(`${this.baseUrl}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, config.providerQuotaTimeoutMs, signal);
  }

  private parseResourceQuota(data: any): { limit: number; remaining: number; used: number; resetAt?: Date | string | null; packages?: CbcPackage[] } {
    return this.parseResourcePackages(data);
  }

  /**
   * Parse the get-user-resource response into the aggregated quota PLUS the
   * per-package breakdown.
   *
   * The response mixes two credit types that must NOT be merged (9router
   * codebuddy-cn usage):
   *  - Refill / base ("基础体验包"): a recurring allowance. Live numbers live in the
   *    *Cycle* fields and it resets at CycleEndTime (monthly), long before the
   *    resource itself expires (DeductionEndTime).
   *  - Bonus ("活动赠送包"): one-shot credits that run a single cycle then expire for
   *    good. Numbers live in the plain Capacity* fields; resetAt is the expiry.
   *
   * A pack is a refill when its cycle ends well before its validity (>2d gap),
   * per the 9router heuristic. The aggregated limit/remaining/used still come
   * from the plain Capacity* totals so existing columns keep their meaning.
   */
  private parseResourcePackages(data: any): {
    limit: number;
    remaining: number;
    used: number;
    resetAt?: Date | string | null;
    packages?: CbcPackage[];
  } {
    const responseData = data.data?.Response?.Data || {};
    const totalDosage = Number(responseData.TotalDosage || 0);
    const resourceAccounts: any[] = Array.isArray(responseData.Accounts) ? responseData.Accounts : [];
    let totalRemain = 0;
    let totalUsed = 0;
    let totalSize = 0;

    for (const acct of resourceAccounts) {
      totalRemain += Number(acct.CapacityRemain || 0);
      totalUsed += Number(acct.CapacityUsed || 0);
      totalSize += Number(acct.CapacitySize || 0);
    }

    const limit = totalSize || totalDosage || totalRemain + totalUsed;
    const remaining = totalRemain;
    const used = totalUsed || Math.max(0, limit - remaining);

    const packages = this.splitPackages(resourceAccounts);
    return { limit, remaining, used, resetAt: this.nearestReset(packages), packages };
  }

  /** Split raw Accounts[] rows into labeled refill / bonus package rows. */
  private splitPackages(accounts: any[]): CbcPackage[] {
    const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
    const ts = (v: any): number => {
      if (!v) return NaN;
      const t = new Date(typeof v === "string" ? v.replace(" ", "T") : v).getTime();
      return Number.isFinite(t) ? t : NaN;
    };
    const num = (...vals: any[]): number => {
      for (const v of vals) {
        if (v === undefined || v === null || v === "") continue;
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return 0;
    };
    const iso = (v: any): string | null => {
      const t = ts(v);
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    };
    const isRefill = (acc: any): boolean => {
      const ce = ts(acc.CycleEndTime);
      const de = ts(acc.DeductionEndTime || acc.ExpiredTime);
      return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
    };
    const byExpiry = (a: any, b: any): number =>
      ts(a.CycleEndTime || a.DeductionEndTime || a.ExpiredTime) -
      ts(b.CycleEndTime || b.DeductionEndTime || b.ExpiredTime);

    const refills = accounts.filter(isRefill).sort(byExpiry);
    const bonuses = accounts.filter((a) => !isRefill(a)).sort(byExpiry);

    const rows: CbcPackage[] = [];
    const labelFor = (acc: any, kind: "refill" | "bonus", idx: number): string => {
      const code = String(acc.PackageCode || "");
      const known = CBC_PACKAGE_LABELS[code];
      const name = String(acc.PackageName || acc.SubProductName || "").trim();
      if (name) return name;
      if (known) return `${known} pack`;
      return kind === "refill" ? `Monthly${idx > 0 ? ` ${idx + 1}` : ""}` : `Bonus Pack ${idx + 1}`;
    };

    refills.forEach((acc, i) => {
      rows.push({
        name: labelFor(acc, "refill", i),
        packageCode: String(acc.PackageCode || ""),
        kind: "refill",
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        remaining: num(acc.CycleCapacityRemainPrecise, acc.CycleCapacityRemain),
        resetAt: iso(acc.CycleEndTime),
      });
    });
    bonuses.forEach((acc, i) => {
      rows.push({
        name: labelFor(acc, "bonus", i),
        packageCode: String(acc.PackageCode || ""),
        kind: "bonus",
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        remaining: num(acc.CapacityRemainPrecise, acc.CapacityRemain),
        resetAt: iso(acc.DeductionEndTime || acc.ExpiredTime || acc.CycleEndTime),
      });
    });
    return rows;
  }

  /** Earliest upcoming reset/expiry across packages (drives the account's resetAt). */
  private nearestReset(packages: CbcPackage[]): string | null {
    const future = packages
      .map((p) => (p.resetAt ? new Date(p.resetAt).getTime() : NaN))
      .filter((t) => Number.isFinite(t) && t > Date.now())
      .sort((a, b) => a - b);
    const first = future[0];
    return first !== undefined ? new Date(first).toISOString() : null;
  }

  /**
   * Claim the daily-checkin gift for this account (Kiro-Go daily-checkin port).
   * POST /v2/billing/meter/daily-checkin {} with the account's ck_ Bearer key.
   *
   * "Already claimed" is a NORMAL no-op, never an error: the gateway returns
   * HTTP 400 with a JSON business code (10001) or a message containing
   * already / 已签 / 已领 / 重复签到 / 今日已. The 400 body must be read to see it.
   */
  private async claimDailyGift(apiKey: string, signal?: AbortSignal): Promise<CbcDailyClaim> {
    try {
      const headers: Record<string, string> = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Authorization": `Bearer ${apiKey}`,
      };
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v2/billing/meter/daily-checkin`,
        { method: "POST", headers, body: JSON.stringify({}) },
        config.providerQuotaTimeoutMs,
        signal
      );
      const text = await response.text().catch(() => "");
      let env: any = null;
      try { env = text ? JSON.parse(text) : null; } catch { env = null; }
      const code = Number(env?.code);
      const msg = String(env?.msg || env?.message || text || "");

      if (response.ok && code === 0) {
        return {
          attempted: true,
          claimed: true,
          already: false,
          credit: Number(env?.data?.credit ?? env?.data?.Credit ?? 0),
          streakDays: Number(env?.data?.streakDays ?? env?.data?.StreakDays ?? 0),
        };
      }
      if (code === 10001 || this.isAlreadyCheckedIn(msg)) {
        return { attempted: true, claimed: false, already: true, credit: 0, streakDays: 0 };
      }
      return { attempted: true, claimed: false, already: false, credit: 0, streakDays: 0, error: msg || `HTTP ${response.status}` };
    } catch (error) {
      return { attempted: true, claimed: false, already: false, credit: 0, streakDays: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Report whether a checkin message is the documented "already signed" marker. */
  private isAlreadyCheckedIn(msg: string): boolean {
    const lower = msg.toLowerCase();
    return ["already", "已签", "已领", "重复签到", "今日已"].some((m) => lower.includes(m.toLowerCase()));
  }

  /**
   * One-time first-activation gift (9router enow API-fallback port).
   * POST {baseUrl}/activity/growth/buddy/first/v1/user/buy/activation with the
   * account's ck_ Bearer key, body { invite_code, plan: "free", platform: "IDE" }.
   *
   * This fires ONCE per account — the caller gates it on metadata.activation.status
   * being absent, so a persisted terminal result (activated / already_active /
   * unverified) is never re-attempted. Best-effort: any failure is data, never a
   * throw, and never affects account status.
   */
  private async claimActivation(apiKey: string, inviteCode: string, signal?: AbortSignal): Promise<CbcActivation> {
    try {
      const headers: Record<string, string> = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Authorization": `Bearer ${apiKey}`,
      };
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/activity/growth/buddy/first/v1/user/buy/activation`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ invite_code: inviteCode, plan: "free", platform: "IDE" }),
        },
        config.providerQuotaTimeoutMs,
        signal
      );
      const text = await response.text().catch(() => "");
      let env: any = null;
      try { env = text ? JSON.parse(text) : null; } catch { env = null; }
      const code = Number(env?.code);
      const msg = String(env?.msg || env?.message || text || "");

      if (response.ok && code === 0) {
        return { status: "activated", method: "api", attemptedAt: new Date().toISOString() };
      }
      // Already activated / already claimed is a terminal success-state, not an error.
      const lower = msg.toLowerCase();
      if (["already", "已激活", "已领取", "activated"].some((m) => lower.includes(m))) {
        return { status: "already_active", method: "api", attemptedAt: new Date().toISOString() };
      }
      return { status: "unverified", method: "api", attemptedAt: new Date().toISOString(), error: msg || `HTTP ${response.status}` };
    } catch (error) {
      return { status: "unverified", method: "api", attemptedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async makeRequest(
    apiKey: string,
    request: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const resolved = this.resolveModel(request.model);
    const headers = this.buildHeaders(apiKey, stream);

    // Clean messages: convert Anthropic-format (tool_use, tool_result, array content)
    // to OpenAI format (tool_calls, tool messages). Vision images stay INLINE in
    // content array (standard OpenAI format) — NOT hoisted to top-level fields.
    const { messages, hasVision } = this.cleanMessages(request);

    // Resolve the canonical model spec to check native thinking/vision support.
    // The catalog (model-specs.ts) is the source of truth: a model only gets
    // thinking params if its spec.thinking is true. This stops us from forcing
    // reasoning on models that don't support it (e.g. minimax-m2.7, deepseek-v3.2)
    // just because the client sent `thinking: {type:"adaptive"}` (Claude Code's
    // default, which is always present regardless of model).
    const actualModel = resolved.endsWith("-thinking") ? resolved.replace(/-thinking$/, "") : resolved;
    const spec = resolveModelSpec(actualModel);
    const modelSupportsThinking = !!spec?.thinking;

    // Client intent: did the caller ask for thinking? Sources, in priority:
    //   1. `-thinking` suffix on the model name (explicit opt-in)
    //   2. `reasoning_effort` set to a non-"none" value
    //   3. Any `thinking.type` other than "disabled" (Claude Code defaults to
    //      "adaptive" which means "model decides" — upstreams that support
    //      thinking should honor it).
    const hasThinkingSuffix = resolved.endsWith("-thinking");
    const effort = request.reasoning_effort;
    const thinkType = (request.thinking as any)?.type;
    const clientWantsThinking =
      hasThinkingSuffix ||
      (typeof effort === "string" && effort !== "" && effort !== "none") ||
      (thinkType && thinkType !== "disabled");

    const enableThinking = modelSupportsThinking && clientWantsThinking;

    const body: Record<string, unknown> = {
      model: actualModel,
      messages,
      stream: true, // Always stream for China version
    };

    if (hasVision) {
      // Vision images are passed inline via the messages array (OpenAI standard format).
      // CodeBuddy China upstream auto-detects and routes them — no top-level flag needed.
      // Verified accurate with glm-4.6v, glm-5v-turbo, deepseek-v3-2-volc via direct
      // upstream testing on real screenshots.
    }

    // Kimi K3: default max_completion/max_tokens to 1_048_576 when omitted
    // (Moonshot platform default is only 131_072). Cap at the combined 1M window.
    const isKimiK3 =
      /^kimi-k3$/i.test(actualModel.replace(/-thinking$/i, "")) ||
      /^cbc-kimi-k3$/i.test(String(request.model || "").replace(/-thinking$/i, ""));
    if (isKimiK3) {
      const requested = Number(request.max_tokens);
      body.max_tokens =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.floor(requested), 1_048_576)
          : 1_048_576;
      // Kimi K3 locks sampling (temperature=1.0, top_p=0.95) — do not forward.
    } else {
      if (request.max_tokens && request.max_tokens > 0) {
        body.max_tokens = request.max_tokens;
      }
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }
    }

    // Forward reasoning/thinking config to upstream using each model family's
    // NATIVE field, so the upstream actually enables thinking and returns
    // reasoning_content. The old code always sent `reasoning:{effort:"high"}`
    // which (a) forced high on every model including non-thinking ones, (b)
    // ignored the client's effort, and (c) didn't send GLM's `enable_thinking`
    // toggle so GLM never actually turned reasoning on for plain (non -thinking)
    // models — which is why Claude Code's `thinking:{type:"adaptive"}` produced
    // zero reasoning on GLM-5.2.
    //
    // Per upstream docs:
    //   - GLM (zai/codebuddy):  `enable_thinking: true` (toggle) +
    //                           `reasoning_effort: "high"|"max"` (GLM-5.2 only)
    //   - DeepSeek:             `thinking: { type: "enabled" }`
    //   - Kimi:                 `reasoning_effort` field
    //   - MiniMax M3:           thinking on by default; send nothing extra
    if (enableThinking) {
      const resolvedEffort =
        (typeof effort === "string" && effort !== "" && effort !== "none") ? effort : "high";
      const fam = actualModel.toLowerCase();
      if (fam.startsWith("glm-")) {
        // GLM native: enable_thinking toggle + reasoning_effort budget.
        body.enable_thinking = true;
        // reasoning_effort is GLM-5.2-only; older GLM ignores it. "max" is the
        // deepest; map "high" through, and treat any explicit effort as-is.
        body.reasoning_effort = resolvedEffort === "max" ? "max" : "high";
      } else if (fam.startsWith("deepseek-")) {
        // DeepSeek native thinking field.
        body.thinking = { type: "enabled" };
      } else if (fam.startsWith("kimi-")) {
        body.reasoning_effort = resolvedEffort;
      } else {
        // MiniMax / generic: codebuddy-china accepts the `reasoning` envelope.
        body.reasoning = { effort: resolvedEffort };
      }
    } else if (modelSupportsThinking) {
      // Model supports thinking but the client didn't ask (adaptive/off).
      // Explicitly disable so an upstream default doesn't burn the output
      // budget on reasoning the client didn't request.
      const fam = actualModel.toLowerCase();
      if (fam.startsWith("glm-")) {
        body.enable_thinking = false;
      } else if (fam.startsWith("deepseek-")) {
        body.thinking = { type: "disabled" };
      }
    }

    // Normalize tools to OpenAI function-calling format
    const tools = this.normalizeTools(request.tools);
    if (tools.length > 0) {
      body.tools = tools;
    }
    // why: CodeBuddy China's subset chat API rejects a restrictive tool_choice
    // ({type:"function",function:{name}} / "required") with HTTP 400
    // "Invalid request parameters" (invalid_parameter_value, param:"") — and it
    // does not reliably honor a forced call either. Normalize to "auto" when
    // tools are present, drop it entirely when they are not, so a Claude-Code /
    // CLI "must-call-a-tool" directive never produces a 400. This is the
    // low-risk fix: the provider already converts tool_calls/tool_responses to
    // plain text via stripToolReferences, so forcing a specific tool was never
    // meaningful here anyway.
    if (request.tool_choice && tools.length > 0) {
      body.tool_choice = "auto";
    }

    const timeoutMs = stream ? 300_000 : config.providerRequestTimeoutMs;

    if (config.codebuddyCnDebugLog) {
      // why: code 11133 / invalid_parameter_value with param:"" gives no hint —
      // capture the exact upstream body so the offending field is visible.
      console.log(`[CodeBuddy China][debug] POST /v2/chat/completions model=${actualModel} body=${JSON.stringify(body)}`);
    }

    return this.fetchWithTimeout(`${this.baseUrl}/v2/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  private async aggregateStreamResponse(response: Response, model: string): Promise<ChatCompletionResponse & { _realCredit?: number }> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let id = this.generateId();
    let finishReason: string | null = "stop";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let realCredit: number | null = null;
    let reasoningContent = "";

    if (!reader) {
      return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
        usage,
      };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          id = chunk.id || id;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};

          if (delta.content) content += delta.content;
          if (delta.reasoning_content) reasoningContent += delta.reasoning_content;

          if (choice?.finish_reason) finishReason = choice.finish_reason || "stop";

          if (chunk.usage) {
            usage = {
              prompt_tokens: Number(chunk.usage.prompt_tokens || 0),
              completion_tokens: Number(chunk.usage.completion_tokens || 0),
              total_tokens: Number(chunk.usage.total_tokens || 0),
            };
            if (chunk.usage.credit != null && Number(chunk.usage.credit) > 0) {
              realCredit = Number(chunk.usage.credit);
            }
          }
        } catch {
          // skip malformed chunk
        }
      }
    }

    if (!usage.completion_tokens) usage.completion_tokens = this.estimateTokens(content);
    if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    const message: any = { role: "assistant", content };
    if (reasoningContent) message.reasoning_content = reasoningContent;

    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
      usage,
      ...(realCredit != null ? { _realCredit: realCredit } : {}),
    };
  }

  private createStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();
    let capturedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let capturedRealCredit: number | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }

        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const data = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

              if (data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta || {};

                const chunk: StreamChunk = {
                  id: parsed.id || id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: choice?.index ?? 0,
                    delta,
                    finish_reason: choice?.finish_reason || null,
                  }],
                };

                if (parsed.usage) {
                  chunk.usage = parsed.usage;
                  capturedUsage = {
                    prompt_tokens: Number(parsed.usage.prompt_tokens || 0),
                    completion_tokens: Number(parsed.usage.completion_tokens || 0),
                    total_tokens: Number(parsed.usage.total_tokens || 0),
                  };
                  if (parsed.usage.credit != null && Number(parsed.usage.credit) > 0) {
                    capturedRealCredit = Number(parsed.usage.credit);
                  }
                }

                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                // skip malformed chunk
              }
            }
          }
        } catch (error) {
          console.error("[CodeBuddy China] Stream error:", error instanceof Error ? error.message : String(error));
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return {
      success: true,
      stream,
      tokensUsed: capturedUsage.total_tokens,
      promptTokens: capturedUsage.prompt_tokens,
      completionTokens: capturedUsage.completion_tokens,
      creditsUsed: 0,
      creditSource: "estimated" as const,
    };
  }
}
