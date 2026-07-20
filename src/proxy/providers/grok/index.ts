/**
 * Grok provider — grok.com web app-chat + console.x.ai API.
 *
 * Ported from grok2api (jiujiu532/grok2api) reverse-engineering of grok.com.
 *
 * Three upstream surfaces:
 *   1. grok.com web  — POST /rest/app-chat/conversations/new (SSE)
 *      Auth: SSO cookies (sso + sso-rw). Free web quota.
 *   2. console.x.ai  — POST /v1/chat/completions (OpenAI-compatible SSE)
 *      Auth: same SSO token as Bearer, OR an xAI API key.
 *      Separate console quota (free for basic accounts).
 *   3. cli-chat-proxy.grok.com — POST /v1/responses (OpenAI Responses API, SSE)
 *      Auth: OAuth2/OIDC access token from auth.x.ai (Bearer) + CLI headers.
 *      Official Grok CLI 0.2.106+ catalog sets api_backend:"responses" for
 *      grok-4.5. Auto-refreshed via refresh_token. Version header is dynamic.
 *
 * Model routing:
 *   - OAuth accounts (auth_method:"oauth")  → cli-chat-proxy /v1/responses
 *   - Models with modeId CONSOLE            → console.x.ai API
 *   - All other (SSO) models                → grok.com web app-chat
 */

import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
  type ProviderHealthResult,
} from "../base";
import type { Account } from "../../../db/schema";
import {
  GROK_ENDPOINTS,
  MODEL_TO_MODE,
  type GrokModeId,
  buildChatPayload,
  StreamAdapter,
  parseSseEvents,
  consoleChunkToEvents,
} from "./protocol";
import {
  GROK_OAUTH,
  isOAuthAccount,
  getOAuthTokens,
  ensureFreshAccessToken,
  exchangeRefreshToken,
  validateOAuthToken,
  probeOAuthModelsLiveness,
  classifyGrokOAuthFallbackFromModels,
  fetchOAuthBillingQuota,
  isAbsoluteGrokOAuthQuota,
  isTrustedGrokAbsoluteRemaining,
  normalizeGrokAbsoluteRemaining,
  isGrokWeeklyPercentQuotaLimit,
  shouldRunGrokChatLivenessProbe,
  mapGrokChatLivenessToHealthPatch,
  getGrokLastChatProbeAtMs,
  isGrokFreeTierQuotaShape,
  probeOAuthChatLiveness,
  withDeadlineSignal,
  GROK_CHAT_PROBE_DEADLINE_MS,
  type GrokOAuthTokens,
  type GrokOAuthQuota,
  type GrokChatLivenessResult,
} from "./oauth";

export {
  classifyGrokModelsLiveness,
  classifyGrokOAuthFallbackFromModels,
  probeOAuthModelsLiveness,
  shouldRunGrokChatLivenessProbe,
  classifyGrokChatLiveness,
  mapGrokChatLivenessToHealthPatch,
  getGrokLastChatProbeAtMs,
  isGrokFreeTierQuotaShape,
  GROK_CHAT_PROBE_THROTTLE_MS,
  GROK_CHAT_PROBE_FREE_TIER_THROTTLE_MS,
  GROK_CHAT_PROBE_EXHAUSTED_THROTTLE_MS,
} from "./oauth";
import {
  GROK_IMAGE_MODEL,
  grokGenerateImage,
  isGrokImageModel,
} from "./image";
import {
  buildCliProxyHeaders,
  chatToCliResponsesBody,
  responsesSseToChatCompletionStream,
} from "./cli-proxy-wire";

export { isGrokWeeklyPercentQuotaLimit } from "./oauth";
export { isGrokImageModel, GROK_IMAGE_MODEL } from "./image";
// ---------------------------------------------------------------------------
// Token structure
// ---------------------------------------------------------------------------

export interface GrokTokens {
  /** grok.com SSO cookie value (the `sso` cookie). */
  sso?: string;
  /** grok.com SSO-RW cookie value (the `sso-rw` cookie). */
  ssoRw?: string;
  /** console.x.ai API key (optional — if absent, SSO is reused as Bearer). */
  apiKey?: string;
  /** Account tier: basic / super / heavy — controls which models are available. */
  tier?: "basic" | "super" | "heavy";
  email?: string;
}

/**
 * True when an upstream Grok/xAI error means the account's free/paid credits
 * are gone (not a short transient throttle).
 *
 * Important: xAI often returns HTTP **429** with
 * `code: "subscription:free-usage-exhausted"` when free Build credits are
 * depleted. That is permanent for the billing window and must mark the
 * account `exhausted` — not a 60s rate-limit cooldown that re-selects it.
 */
export function isGrokCreditExhaustedError(msg: string): boolean {
  if (!msg) return false;
  const n = msg.toLowerCase();
  return (
    n.includes("free-usage-exhausted") ||
    n.includes("spending-limit") ||
    n.includes("spending_limit") ||
    n.includes("usage exhausted") ||
    n.includes("quota_exhausted") ||
    n.includes("quota exhausted") ||
    n.includes("quota has been exhausted") ||
    n.includes("insufficient credit") ||
    n.includes("credits exhausted") ||
    n.includes("credit exhausted") ||
    n.includes("no remaining credits") ||
    n.includes("out of credits") ||
    n.includes("you've used all") ||
    n.includes("you have used all") ||
    n.includes("payment required") ||
    /\b402\b/.test(n)
  );
}

/**
 * Parse xAI's free-usage usage detail from the 429 body:
 *   "… tokens (actual/limit): 2,012,345/2,000,000, requests (actual/limit): 101/100"
 * Returns the first (tokens) pair, falling back to requests. Null when absent.
 * Kept for diagnostics/classification — the numbers describe the free-Build
 * absolute budget, which must NOT be written into weekly-percent quota columns.
 */
export function parseGrokFreeUsageActualLimit(
  text: string,
): { kind: "tokens" | "requests"; actual: number; limit: number } | null {
  if (!text) return null;
  const toNum = (s: string) => {
    const n = Number(s.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const tokens = text.match(/tokens\s*\(actual\/limit\)\s*:\s*([\d,]+)\s*\/\s*([\d,]+)/i);
  if (tokens) {
    const actual = toNum(tokens[1]!);
    const limit = toNum(tokens[2]!);
    if (actual !== null && limit !== null) return { kind: "tokens", actual, limit };
  }
  const requests = text.match(/requests\s*\(actual\/limit\)\s*:\s*([\d,]+)\s*\/\s*([\d,]+)/i);
  if (requests) {
    const actual = toNum(requests[1]!);
    const limit = toNum(requests[2]!);
    if (actual !== null && limit !== null) return { kind: "requests", actual, limit };
  }
  return null;
}

/**
 * Classify a Grok upstream failure into a ProviderResult.
 * Exhaustion checks run **before** the generic 429/rate-limit branch so
 * free-usage-exhausted is never treated as a temporary throttle.
 */
export function classifyGrokUpstreamError(err: unknown): ProviderResult {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // Wrong / unsupported model is a CLIENT error — never ban or disable the account.
  // Router treats isInvalidModelError / isNonAccountRequestError as non-account.
  if (
    /invalid_model|model_not_found|no such model|unknown model|model not supported|model is not supported|unsupported model|does not support model|model does not exist|model is not available|model not available/i.test(
      msg,
    )
  ) {
    return { success: false, error: `invalid_model: ${msg}` };
  }
  // Credit declined / free usage exhausted — mark account exhausted (router
  // → pool.markExhausted). Must run before the bare "429" rate-limit match.
  if (isGrokCreditExhaustedError(msg)) {
    // Surface the parsed free-usage actual/limit pair for diagnostics (rides
    // ProviderResult.metadata into request_logs; never shown to clients).
    const freeUsage = parseGrokFreeUsageActualLimit(msg);
    return {
      success: false,
      error: `quota_exhausted: ${msg}`,
      quotaExhausted: true,
      ...(freeUsage ? { metadata: { freeUsage } } : {}),
    };
  }
  // xAI "permission-denied" / "Access denied" on chat is NOT an expired token —
  // the access JWT is often valid (billing/models may still work) but this
  // principal has no Build chat entitlement. Mark banned so the router removes
  // the credential immediately instead of rate-limit/hysteresis stalling the fleet.
  // Live body: cli-chat-proxy error 403: {"error":"Access denied"}
  if (
    /permission-denied|chat endpoint is denied|access\s*denied/i.test(msg) ||
    (/\b403\b/i.test(msg) && /access\s*denied|banned|suspended|restricted|disabled|revoked/i.test(msg))
  ) {
    return {
      success: false,
      error: `forbidden: ${msg}`,
      banned: true,
    };
  }
  if (/expired|unauthorized|\b401\b/i.test(msg)) {
    return { success: false, error: `expired: ${msg}` };
  }
  // Bare 403 without Access denied — entitlement lag / temporary; do not ban.
  if (/\b403\b/i.test(msg)) {
    return { success: false, error: `error: ${msg}` };
  }
  if (/rate_limit|429|too many/i.test(msg)) {
    return { success: false, error: `rate_limited: ${msg}`, rateLimited: true };
  }
  // Hard connect / envoy 503 — surface as error text; executor must NOT
  // multi-retry the same account (router fail-fasts after 1–2 accounts).
  return { success: false, error: `error: ${msg}` };
}

/**
 * Conservative prompt-token estimate when the upstream reports no usage
 * (i.e. the SSO web surface). Uses a char/4 heuristic summed across all
 * message content. Used only as a fallback — OAuth/Responses surface reports
 * real usage.
 */
function estimatePromptTokens(request: ChatCompletionRequest): number {
  let chars = 0;
  for (const msg of request.messages ?? []) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") chars += part.length;
        else if (part && typeof part.text === "string") chars += part.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

const GROK_CREATED = 1_718_000_000;

/**
 * Catalog for /v1/models + dashboard.
 * - grok-4.5           → chat (+ vision understand)
 * - grok-4.5-reasoning → chat alias
 * - composer-2.5            → Grok Build coding
 * - grok-composer-2.5-fast  → Composer 2.5 Fast (Grok Build / SuperGrok)
 * - grok-image              → image via /v1/responses + tools image_generation
 *
 * Per xAI: grok-4.5 always reasons; effort controls depth (cannot disable).
 * Image gen reuses OAuth cli-chat-proxy (not a separate Imagine host).
 */
// Free Build quota is absolute tokens (x-ratelimit-*-tokens, typically ~2e6).
// creditRate 1 → creditsUsed = totalTokens so pool.decrementQuota tracks the
// real remaining budget (the default 1/1000 left accounts almost full forever).
const GROK_MODELS: ModelInfo[] = [
  { id: "grok-4.5", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 500_000, max_output: 65_536, thinking: true, vision: true, creditUnit: "token", creditRate: 1, creditSource: "estimated" },
  { id: "grok-4.5-reasoning", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 500_000, max_output: 65_536, thinking: true, vision: true, creditUnit: "token", creditRate: 1, creditSource: "estimated" },
  // Context 200k from Cursor model docs; vision not advertised for this SKU.
  { id: "composer-2.5", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 200_000, max_output: 65_536, thinking: true, vision: false, creditUnit: "token", creditRate: 1, creditSource: "estimated" },
  // Composer 2.5 Fast — live probe: cli-chat-proxy accepts id "grok-composer-2.5-fast"
  // (not "composer-2.5-fast" / "groq-…"). Free-tier often 402 subscription; SuperGrok OK.
  { id: "grok-composer-2.5-fast", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 200_000, max_output: 65_536, thinking: true, vision: false, creditUnit: "token", creditRate: 1, creditSource: "estimated" },
  // Image Studio / Chat media — tool-based gen on grok-4.5 Responses surface.
  { id: GROK_IMAGE_MODEL, object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 1_024, max_output: 0, thinking: false, vision: false, creditUnit: "image", creditRate: 1, creditSource: "fixed" },
];

export type GrokReasoningEffort = "low" | "medium" | "high";

/** Map client request + model slug → xAI reasoning_effort (default high). */
export function resolveGrokReasoningEffort(request: ChatCompletionRequest): GrokReasoningEffort {
  const model = (request.model || "").toLowerCase();
  const raw =
    request.reasoning_effort ??
    (request as { reasoning?: { effort?: string } }).reasoning?.effort ??
    request.thinking?.effort ??
    (model === "grok-4.5-reasoning" ? "high" : "high");
  const s = String(raw).toLowerCase().trim();
  if (s === "low" || s === "medium" || s === "high") return s;
  if (s === "min" || s === "minimal") return "low";
  if (s === "max" || s === "xhigh" || s === "extra_high") return "high";
  return "high";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GrokProvider extends BaseProvider {
  name = "grok";
  supportedModels = GROK_MODELS;

  override ownsModel(model: string): boolean {
    const m = model.toLowerCase();
    if (m === "grok-4.5" || m === "grok-4.5-reasoning" || m === "composer-2.5") return true;
    // Canonical + common aliases (OpenCode uses grok-composer-2.5-fast).
    if (
      m === "grok-composer-2.5-fast" ||
      m === "composer-2.5-fast" ||
      m === "groq-composer-2.5-fast" // common typo (groq vs grok)
    ) {
      return true;
    }
    if (isGrokImageModel(m)) return true;
    return false;
  }

  private resolveMode(model: string): GrokModeId {
    const m = model.toLowerCase();
    return MODEL_TO_MODE[m] ?? "AUTO";
  }

  private isConsoleModel(model: string): boolean {
    return this.resolveMode(model) === "CONSOLE";
  }

  private getTokens(account: Account): GrokTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as GrokTokens;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Image generation (cli-chat-proxy /v1/responses + image_generation tool)
  // -------------------------------------------------------------------------

  /**
   * Image Studio / Chat route media models through chatCompletion with markdown
   * image URLs (incl. data:image/*;base64) so the existing URL extractors work.
   */
  private async imageCompletion(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const lastUser = [...(request.messages || [])].reverse().find((m) => m.role === "user");
    let prompt = "";
    if (typeof lastUser?.content === "string") {
      prompt = lastUser.content;
    } else if (Array.isArray(lastUser?.content)) {
      prompt = lastUser.content
        .map((p: any) => (typeof p === "string" ? p : p?.text || p?.input_text || ""))
        .filter(Boolean)
        .join("\n");
    }
    if (!prompt.trim()) {
      return { success: false, error: "Empty prompt for Grok image generation" };
    }

    const n = Math.min(4, Math.max(1, Number((request as any).n) || 1));
    const result = await grokGenerateImage(account, { prompt: prompt.trim(), n });
    if (!result.ok || result.urls.length === 0) {
      return this.classifyError(
        new Error(result.error || "Grok image generation returned no media"),
      );
    }

    const content = result.urls
      .map((u, i) => `![Image ${i + 1}](${u})`)
      .join("\n\n");

    const response: ChatCompletionResponse = {
      id: `chatcmpl-grok-image-${Date.now()}`,
      object: "chat.completion",
      created: now(),
      model: request.model || GROK_IMAGE_MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: result.urls.length,
      },
    };

    // Do not invent token debit on weekly % pool; live re-probe owns remaining.
    // Fixed image unit for request logs only.
    return {
      success: true,
      response,
      tokensUsed: result.urls.length,
      creditsUsed: result.urls.length,
      creditSource: "fixed",
    };
  }

  // -------------------------------------------------------------------------
  // Chat completion (non-streaming)
  // -------------------------------------------------------------------------

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    if (isGrokImageModel(request.model || "")) {
      return this.imageCompletion(account, request);
    }
    try {
      const oauthAccount = isOAuthAccount(account);
      const tokens = oauthAccount ? null : this.getTokens(account);
      if (!oauthAccount && !tokens) throw new Error("expired: no tokens");

      const id = `chatcmpl-grok-${Date.now()}`;
      const created = now();
      const model = request.model;
      const useConsole = this.isConsoleModel(model);

      // Collect the full stream into a single response.
      let text = "";
      let reasoning = "";
      /** Real upstream usage if reported (OAuth/Responses surface); null = estimate. */
      const usageHolder: { value: { prompt_tokens: number; completion_tokens: number } | null } = { value: null };
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const stream = oauthAccount
        ? await this.makeCliProxyStream(account, request, id, created, (u) => { usageHolder.value = u; })
        : useConsole
          ? await this.makeConsoleStream(account, tokens!, request, id, created)
          : await this.makeWebStream(account, tokens!, request, id, created);

      if (!stream) {
        return { success: false, error: "Failed to create upstream stream" };
      }

      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value, { stream: true });
        // Parse SSE chunks from our own stream output.
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) text += delta.content;
            if ((delta as any)?.reasoning_content) reasoning += (delta as any).reasoning_content;
          } catch { /* ignore */ }
        }
      }

      // Token accounting: prefer the upstream-reported usage (OAuth/Responses
      // surface returns a real usage object). Fall back to a conservative
      // estimate only when the upstream reports nothing (SSO web surface).
      const promptTokens = usageHolder.value?.prompt_tokens
        ?? estimatePromptTokens(request);
      const completionTokens = usageHolder.value?.completion_tokens
        ?? Math.ceil(text.length / 4);

      const response: ChatCompletionResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text || "",
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };

      return { success: true, response, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (err: any) {
      return this.classifyError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Chat completion (streaming)
  // -------------------------------------------------------------------------

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    // Image gen is non-streaming; return full completion (router wraps if needed).
    if (isGrokImageModel(request.model || "")) {
      return this.imageCompletion(account, request);
    }
    try {
      const oauthAccount = isOAuthAccount(account);
      const tokens = oauthAccount ? null : this.getTokens(account);
      if (!oauthAccount && !tokens) throw new Error("expired: no tokens");

      const id = `chatcmpl-grok-${Date.now()}`;
      const created = now();
      const model = request.model;
      const useConsole = this.isConsoleModel(model);

      const stream = oauthAccount
        ? await this.makeCliProxyStream(account, request, id, created)
        : useConsole
          ? await this.makeConsoleStream(account, tokens!, request, id, created)
          : await this.makeWebStream(account, tokens!, request, id, created);

      if (!stream) {
        return { success: false, error: "Failed to create upstream stream" };
      }

      return { success: true, stream };
    } catch (err: any) {
      return this.classifyError(err);
    }
  }

  // -------------------------------------------------------------------------
  // cli-chat-proxy.grok.com /v1/responses → chat.completion.chunk SSE
  // OAuth surface used by the official Grok CLI (api_backend: "responses").
  // -------------------------------------------------------------------------

  /**
   * Stream a chat completion from the cli-chat-proxy Responses endpoint.
   *
   * CLI 0.2.106+ catalog sets api_backend:"responses" for grok-4.5. We POST
   * /v1/responses with CLI-parity headers (X-XAI-Token-Auth, version, surface,
   * identifier, model-override) and adapt Responses SSE into OpenAI
   * chat.completion.chunk for the rest of the proxy pipeline.
   *
   * @param onUsage optional callback when response.completed carries usage
   */
  private async makeCliProxyStream(
    account: Account,
    request: ChatCompletionRequest,
    id: string,
    created: number,
    onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void
  ): Promise<ReadableStream<Uint8Array> | null> {
    const bearer = await ensureFreshAccessToken(account, async (fresh) => {
      // Persist the refreshed token bundle back to the account row.
      account.tokens = fresh as unknown as Account["tokens"];
      try {
        const { db } = await import("../../../db/index");
        const { accounts } = await import("../../../db/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(accounts).set({ tokens: fresh as unknown as Account["tokens"] }).where(eq(accounts.id, account.id));
      } catch { /* best-effort persist; in-memory token still refreshed */ }
    });
    if (!bearer) throw new Error("expired: OAuth access token could not be refreshed");

    // Map catalog slug → upstream Build model id (composer-2.5 vs grok-4.5).
    // "grok-build" alias 402s on free accounts; confirmed by CLI debug + probes.
    const upstreamModel = this.mapConsoleModel(request.model);
    const effort = resolveGrokReasoningEffort(request);
    const body = chatToCliResponsesBody(request, upstreamModel, {
      stream: true,
      reasoningEffort: effort,
    });

    const headers = await buildCliProxyHeaders(bearer, {
      modelOverride: upstreamModel,
      accept: "text/event-stream",
      surface: "grok-shell",
      identifier: "grok-build",
    });

    const upstream = await fetch(`${GROK_OAUTH.apiBaseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      // Keep the full body (bounded 2KB): free-usage-exhausted carries the
      // "tokens (actual/limit): X/Y" detail past the old 200-char cut, which
      // clipped exactly before the only machine-useful part.
      throw new Error(`cli-chat-proxy error ${upstream.status}: ${text.slice(0, 2000)}`);
    }

    return responsesSseToChatCompletionStream(upstream.body, {
      id,
      created,
      model: request.model,
      onUsage,
    });
  }

  // -------------------------------------------------------------------------
  // grok.com web app-chat → ReadableStream<Uint8Array> (SSE-encoded)
  // -------------------------------------------------------------------------

  private async makeWebStream(
    account: Account,
    tokens: GrokTokens,
    request: ChatCompletionRequest,
    id: string,
    created: number
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (!tokens.sso) throw new Error("expired: no SSO cookie");

    const model = request.model;
    const modeId = this.resolveMode(model);
    const systemPrompt = request.messages?.find((m) => m.role === "system")?.content;
    const systemText = typeof systemPrompt === "string" ? systemPrompt : "";
    const history = (request.messages ?? [])
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));
    const lastUser = history.filter((m) => m.role === "user").pop();
    const priorHistory = history.slice(0, -1);
    const userMessage = lastUser?.content ?? "";

    const wantReasoning = (request as any).reasoning === true ||
      (request as any).reasoning_effort != null ||
      model.includes("reasoning") ||
      modeId === "EXPERT" || modeId === "HEAVY";

    const payload = buildChatPayload({
      message: userMessage,
      modeId,
      systemPrompt: systemText,
      reasoning: wantReasoning,
      history: priorHistory,
    });

    const response = await fetch(GROK_ENDPOINTS.APP_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/event-stream",
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`expired: HTTP ${response.status}`);
    }
    if (response.status === 429) {
      // Include body so free-usage-exhausted can be classified as quotaExhausted.
      const body = await response.text().catch(() => "");
      throw new Error(`rate_limited: HTTP 429 ${body.slice(0, 2000)}`);
    }
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      throw new Error(`error: HTTP ${response.status} ${body.slice(0, 2000)}`);
    }

    const upstream = response.body;
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const adapter = new StreamAdapter({ showSearchSources: true });
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let started = false;
        let finished = false;

        const emit = (delta: Record<string, any>, finish_reason: string | null = null) => {
          const chunk = {
            id, object: "chat.completion.chunk" as const,
            created, model,
            choices: [{ index: 0, delta, finish_reason }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        const emitRole = () => {
          if (started) return;
          started = true;
          emit({ role: "assistant" });
        };

        try {
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE events (separated by double newlines).
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const rawEvent = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);

              const dataLines = parseSseEvents(rawEvent);
              for (const data of dataLines) {
                const events = adapter.feed(data);
                for (const evt of events) {
                  switch (evt.type) {
                    case "text":
                      emitRole();
                      emit({ content: evt.text });
                      break;
                    case "reasoning":
                      emitRole();
                      emit({ reasoning_content: evt.text });
                      break;
                    case "tool_use":
                      emitRole();
                      emit({
                        tool_calls: [{
                          index: 0,
                          id: `call_grok_${Date.now()}`,
                          type: "function",
                          function: { name: evt.toolName ?? "", arguments: evt.toolArgs ?? "" },
                        }],
                      });
                      break;
                    case "citation":
                      // Citations are already rendered inline in the text token.
                      break;
                    case "error":
                      // 402 = credit/quota exhausted (see protocol extractError);
                      // 429 = true rate limit. Preserve prefix so classifyError
                      // can distinguish without re-parsing the body.
                      throw new Error(
                        evt.errorStatus === 402
                          ? `quota_exhausted: ${evt.errorMessage}`
                          : evt.errorStatus === 429
                            ? `rate_limited: ${evt.errorMessage}`
                            : `error: ${evt.errorMessage}`
                      );
                    case "done":
                      finished = true;
                      break;
                  }
                }
              }
            }
          }
        } catch (err: any) {
          controller.error(err);
          return;
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }

        // Append sources footer if configured.
        const footer = adapter.getSourcesFooter();
        if (footer) {
          emitRole();
          emit({ content: footer });
        }

        // Final chunk with finish_reason.
        emit({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  // -------------------------------------------------------------------------
  // console.x.ai API → ReadableStream<Uint8Array> (SSE-encoded)
  // -------------------------------------------------------------------------

  private async makeConsoleStream(
    account: Account,
    tokens: GrokTokens,
    request: ChatCompletionRequest,
    id: string,
    created: number
  ): Promise<ReadableStream<Uint8Array> | null> {
    const auth = tokens.apiKey ?? tokens.sso;
    if (!auth) throw new Error("expired: no API key or SSO token for console");

    const consoleModel = this.mapConsoleModel(request.model);

    const body: Record<string, any> = {
      model: consoleModel,
      messages: request.messages,
      stream: true,
    };
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.max_tokens != null) body.max_tokens = request.max_tokens;
    if ((request as any).tools) body.tools = (request as any).tools;

    const response = await fetch(GROK_ENDPOINTS.CONSOLE_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth}`,
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`expired: HTTP ${response.status}`);
    }
    if (response.status === 429) {
      // Include body so free-usage-exhausted can be classified as quotaExhausted.
      const text = await response.text().catch(() => "");
      throw new Error(`rate_limited: HTTP 429 ${text.slice(0, 200)}`);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`error: HTTP ${response.status} ${text.slice(0, 200)}`);
    }

    const upstream = response.body;
    const encoder = new TextEncoder();
    const model = request.model;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let started = false;
        let finished = false;

        const emit = (delta: Record<string, any>, finish_reason: string | null = null) => {
          const chunk = {
            id, object: "chat.completion.chunk" as const,
            created, model,
            choices: [{ index: 0, delta, finish_reason }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        const emitRole = () => {
          if (started) return;
          started = true;
          emit({ role: "assistant" });
        };

        try {
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const rawEvent = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);

              const dataLines = parseSseEvents(rawEvent);
              for (const data of dataLines) {
                if (data === "[DONE]") {
                  finished = true;
                  continue;
                }

                let chunk: any;
                try {
                  chunk = JSON.parse(data);
                } catch {
                  continue;
                }

                const events = consoleChunkToEvents(chunk);
                for (const evt of events) {
                  switch (evt.type) {
                    case "text":
                      emitRole();
                      emit({ content: evt.text });
                      break;
                    case "reasoning":
                      emitRole();
                      emit({ reasoning_content: evt.text });
                      break;
                    case "tool_use":
                      emitRole();
                      emit({
                        tool_calls: [{
                          index: 0,
                          id: `call_grok_${Date.now()}`,
                          type: "function",
                          function: { name: evt.toolName ?? "", arguments: evt.toolArgs ?? "" },
                        }],
                      });
                      break;
                    case "done":
                      finished = true;
                      break;
                  }
                }
              }
            }
          }
        } catch (err: any) {
          controller.error(err);
          return;
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }

        emit({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Map an etteum grok model slug to the console.x.ai / cli-chat model name. */
  private mapConsoleModel(model: string): string {
    const m = (model || "").toLowerCase().trim();
    if (m === "composer-2.5" || m === "composer-2-5") return "composer-2.5";
    // Live probe 2026-07-15: only "grok-composer-2.5-fast" is accepted (not
    // bare "composer-2.5-fast"). Aliases map to that upstream id.
    if (
      m === "grok-composer-2.5-fast" ||
      m === "composer-2.5-fast" ||
      m === "groq-composer-2.5-fast"
    ) {
      return "grok-composer-2.5-fast";
    }
    // grok-4.5-reasoning and any other 4.5 alias → upstream grok-4.5
    return "grok-4.5";
  }

  /** Classify an error into a ProviderResult failure. */
  private classifyError(err: any): ProviderResult {
    return classifyGrokUpstreamError(err);
  }

  // -------------------------------------------------------------------------
  // Token refresh (SSO cookies are long-lived — no refresh needed)
  // -------------------------------------------------------------------------

  async refreshToken(account: Account): Promise<{
    success: boolean;
    tokens?: string;
    error?: string;
  }> {
    // OAuth path — exchange refresh token for a fresh access token.
    if (isOAuthAccount(account)) {
      const oauthTokens = getOAuthTokens(account);
      if (!oauthTokens?.refresh_token) {
        return { success: false, error: "No refresh token to renew OAuth access" };
      }
      try {
        const fresh = await exchangeRefreshToken(oauthTokens.refresh_token);
        // Merge so farm credits / email survive rotation (refresh response is thin).
        const merged: GrokOAuthTokens = {
          ...oauthTokens,
          ...fresh,
          auth_method: "oauth",
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token || oauthTokens.refresh_token,
          expires_at: fresh.expires_at,
          oidc_client_id: fresh.oidc_client_id || oauthTokens.oidc_client_id,
          sub: fresh.sub || oauthTokens.sub,
        };
        return { success: true, tokens: JSON.stringify(merged) };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // SSO path — cookies don't have a refresh-token flow. Validate as-is.
    const tokens = this.getTokens(account);
    if (!tokens?.sso) {
      return { success: false, error: "No SSO cookie to refresh" };
    }
    const valid = await this.validateAccount(account);
    if (!valid) {
      return { success: false, error: "expired: SSO cookie invalid" };
    }
    return {
      success: true,
      tokens: JSON.stringify({
        sso: tokens.sso,
        ssoRw: tokens.ssoRw ?? tokens.sso,
        ...(tokens.apiKey ? { apiKey: tokens.apiKey } : {}),
        ...(tokens.tier ? { tier: tokens.tier } : {}),
        ...(tokens.email ? { email: tokens.email } : {}),
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Quota fetching
  // -------------------------------------------------------------------------

  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{
    success: boolean;
    quota?: {
      limit: number;
      remaining: number;
      used: number;
      resetAt: Date | null;
      source: string;
      /** Present on OAuth live probes — absolute free Build / paid vs percent-scale. */
      percentScale?: boolean;
    };
    error?: string;
  }> {
    // OAuth path — real billing from cli-chat-proxy /v1/billing (paid monthly
    // pool) and/or grok.com GetGrokCreditsConfig (shared weekly pool %).
    // Never invent a fake 100/100 placeholder.
    if (isOAuthAccount(account)) {
      const bearer = await ensureFreshAccessToken(account);
      if (!bearer) {
        return { success: false, error: "expired: OAuth access token needs refresh" };
      }
      try {
        const quota = await fetchOAuthBillingQuota(bearer, signal);
        if (quota) {
          return {
            success: true,
            quota: {
              limit: quota.limit,
              remaining: quota.remaining,
              used: quota.used,
              resetAt: quota.resetAt,
              source: quota.source,
              percentScale: quota.percentScale,
            },
          };
        }
        return { success: false, error: "billing endpoints returned no usable quota" };
      } catch (err: any) {
        if (err?.name === "AbortError") return { success: false, error: "aborted" };
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    // SSO path — grok.com rate-limits endpoint.
    const tokens = this.getTokens(account);
    if (!tokens?.sso) {
      return { success: false, error: "No SSO cookie" };
    }

    try {
      const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
        method: "GET",
        headers: {
          "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Referer": "https://grok.com/",
        },
        signal,
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;

      // Normalize grok.com rate-limit response into the quota shape.
      const limit = data?.totalQueries ?? data?.total ?? 100;
      const remaining = data?.remainingQueries ?? data?.remaining ?? 0;
      const used = limit - remaining;
      const resetAt = data?.windowSeconds
        ? new Date(Date.now() + data.windowSeconds * 1000)
        : null;

      return {
        success: true,
        quota: { limit, remaining, used, resetAt, source: "grok.com-rate-limits" },
      };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { success: false, error: "aborted" };
      }
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Check if an account's tokens are still valid. Returns true if alive.
   *
   * - OAuth accounts: validated via GET /v1/models on cli-chat-proxy (no token
   *   cost), with proactive refresh if the access token is near expiry.
   * - SSO accounts: validated via the grok.com rate-limits endpoint.
   */
  /**
   * Throttled POST /v1/responses chat liveness (Alibaba-style).
   * Overridable in unit tests so credit/models cases stay isolated.
   */
  protected async runChatLivenessProbe(
    bearer: string,
    signal?: AbortSignal,
  ): Promise<GrokChatLivenessResult> {
    const hop = withDeadlineSignal(signal, GROK_CHAT_PROBE_DEADLINE_MS);
    return probeOAuthChatLiveness(bearer, hop);
  }

  /**
   * After credits already marked the row healthy, prove chat still works.
   * GetGrokCreditsConfig / billing alone miss free Build package drain
   * (`subscription:free-usage-exhausted` only on real /v1/responses). Free-tier
   * accounts re-probe every few minutes so warmup benches them before a user
   * request is interrupted. Transient chat blips keep healthy; access denied /
   * 401 / free-usage-exhausted remove the account from the dispatch pool.
   */
  private async withOptionalChatLiveness(
    account: Account,
    bearer: string,
    base: ProviderHealthResult,
    signal?: AbortSignal,
  ): Promise<ProviderHealthResult> {
    if (base.kind !== "healthy") return base;

    if (!shouldRunGrokChatLivenessProbe(account)) {
      const lastMs = getGrokLastChatProbeAtMs(account);
      return {
        ...base,
        metadata: {
          ...(base.metadata || {}),
          chatProbe: "throttled",
          freeTierShape: isGrokFreeTierQuotaShape(account),
          ...(lastMs != null
            ? { lastChatProbeAt: new Date(lastMs).toISOString() }
            : {}),
        },
      };
    }

    let live: GrokChatLivenessResult;
    try {
      live = await this.runChatLivenessProbe(bearer, signal);
    } catch (err: any) {
      if (err?.name === "AbortError" && signal?.aborted) throw err;
      live = {
        reason: "transient",
        error: err?.message || "chat probe failed",
      };
    }

    const patch = mapGrokChatLivenessToHealthPatch(live);
    const nowIso = new Date().toISOString();

    if (patch.kind === "healthy") {
      return {
        ...base,
        message: base.message
          ? `${base.message}; chat probe ok`
          : "chat probe ok",
        metadata: {
          ...(base.metadata || {}),
          chatProbe: "ok",
          lastChatProbeAt: nowIso,
        },
      };
    }

    if (patch.kind === "exhausted") {
      const q = patch.quota;
      // Prefer absolute free-Build package size when credits only had weekly %.
      const limit =
        q && q.limit > 0
          ? q.limit
          : base.quota && base.quota.limit > 100
            ? base.quota.limit
            : q?.limit || base.quota?.limit || 0;
      return {
        kind: "exhausted",
        success: true,
        message: patch.message || "chat probe: free usage exhausted",
        quota: {
          limit,
          remaining: 0,
          used: limit > 0 ? limit : (q?.used ?? base.quota?.used ?? 0),
          resetAt: q?.resetAt ?? base.quota?.resetAt ?? null,
          source: q?.source || "cli-chat-proxy/free-usage-exhausted",
        },
        ...(base.tokens ? { tokens: base.tokens } : {}),
        metadata: {
          ...(base.metadata || {}),
          chatProbe: "exhausted",
          // Align with Qoder-style probe tag (and future policy readers).
          inferenceProbe: "quota_exhausted",
          lastChatProbeAt: nowIso,
        },
      };
    }

    if (patch.kind === "banned") {
      return {
        kind: "banned",
        success: false,
        retryable: false,
        error: patch.error,
        ...(base.tokens ? { tokens: base.tokens } : {}),
        metadata: {
          ...(base.metadata || {}),
          chatProbe: "access_denied",
          lastChatProbeAt: nowIso,
        },
      };
    }

    if (patch.kind === "session_expired") {
      return {
        kind: "session_expired",
        success: false,
        retryable: true,
        error: patch.error,
        ...(base.tokens ? { tokens: base.tokens } : {}),
        metadata: {
          ...(base.metadata || {}),
          chatProbe: "unauthorized",
          lastChatProbeAt: nowIso,
        },
      };
    }

    // transient_keep — do NOT stamp lastChatProbeAt so the next tick retries
    return {
      ...base,
      message: base.message
        ? `${base.message}; chat probe transient: ${patch.error || "unknown"}`
        : `chat probe transient: ${patch.error || "unknown"}`,
      metadata: {
        ...(base.metadata || {}),
        chatProbe: "transient",
        chatProbeError: patch.error,
      },
    };
  }

  /**
   * When access JWT is expired/near-expiry, rotate via the refresh coordinator
   * (locked + persisted). Used by warmup healthCheck and validateAccount.
   *
   * ensureFreshAccessToken deliberately never rotates (avoids races on the
   * request path). Warmup/import must still refresh expired access tokens —
   * otherwise imported accounts with a valid refresh_token fail as
   * "OAuth access token invalid or refresh failed".
   */
  private async refreshOAuthIfNeeded(
    account: Account,
  ): Promise<{ account: Account; refreshedTokens?: unknown; error?: string; unrecoverable?: boolean }> {
    const bearer = await ensureFreshAccessToken(account);
    if (bearer) return { account };

    const oauth = getOAuthTokens(account);
    if (!oauth?.refresh_token) {
      return {
        account,
        error: "No refresh token to renew OAuth access",
        unrecoverable: true,
      };
    }

    const { coordinatedRefresh } = await import("../../../auth/refresh-coordinator");
    const { pool } = await import("../../pool");
    const refreshResult = await coordinatedRefresh(this, account);
    if (!refreshResult.success || !refreshResult.tokens) {
      return {
        account,
        error: refreshResult.error || "OAuth refresh failed",
        unrecoverable: refreshResult.unrecoverable,
      };
    }
    await pool.updateTokens(account.id, refreshResult.tokens);
    return {
      account: { ...account, tokens: refreshResult.tokens as Account["tokens"] },
      refreshedTokens: refreshResult.tokens,
    };
  }

  /**
   * Override healthCheck so the BASE class's unlocked refreshToken path cannot
   * race token rotation. We still refresh expired OAuth access tokens via
   * coordinatedRefresh (safe for warmup after import/export).
   *
   * Warmup MUST live-probe real free Build / billing credits. Never short-
   * circuit on stored farm `credits_remaining` (that produced dashboard
   * totals like 156 × 2M = 290M "full" remaining with zero exhausted accounts).
   */
  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    // OAuth path — refresh if access expired, then LIVE credit probe.
    if (isOAuthAccount(account)) {
      const ready = await this.refreshOAuthIfNeeded(account);
      if (ready.error) {
        // Permanent RT death only → hard auth_error (warmup may mark error).
        // Transient refresh failures must NOT mass-flip the fleet to
        // session_expired → error (network blip during WarmUp-all of 2k).
        if (ready.unrecoverable) {
          return {
            kind: "auth_error",
            success: false,
            retryable: false,
            error: ready.error,
          };
        }
        return {
          kind: "transient_error",
          success: false,
          retryable: true,
          error: ready.error,
        };
      }
      const working = ready.account;

      // 1) Always live-probe credits (billing → rate-limit headers → percent).
      //    This is the whole point of warmup for Grok — not just "key works".
      const live = await this.fetchQuota(working, signal);

      if (live.success && live.quota) {
        const q = live.quota;
        const oauth = getOAuthTokens(working);
        let asGrokQuota: GrokOAuthQuota = {
          limit: q.limit,
          remaining: q.remaining,
          used: q.used,
          resetAt: q.resetAt,
          source: q.source,
          percentScale: q.percentScale === true,
        };
        // Free Build headers often report remaining==limit (full 2M) even after
        // real use — mark untrusted so we don't overwrite local remaining.
        if (!asGrokQuota.percentScale && asGrokQuota.limit > 0) {
          asGrokQuota = normalizeGrokAbsoluteRemaining(asGrokQuota);
        }

        // CLI weekly pool (0–100) is the free-tier source of truth.
        const weeklyPercent =
          asGrokQuota.percentScale === true ||
          (asGrokQuota.limit === 100 &&
            String(asGrokQuota.source || "").includes("GetGrokCreditsConfig"));

        if (weeklyPercent) {
          // why: auth'd GetGrokCreditsConfig already proved the bearer. A
          // secondary GET /v1/models 403 "Access denied" must NOT mass-kill
          // the fleet as session_expired / "invalid after refresh" (RT still works).
          // Chat liveness (throttled) still runs below when remaining > 0.
          const limit = 100;
          const remaining = Math.min(
            limit,
            Math.max(0, Math.floor(Number(asGrokQuota.remaining))),
          );
          const used = Math.min(limit, Math.max(0, limit - remaining));
          const drained = remaining <= 0;
          const weeklyBase: ProviderHealthResult = {
            kind: drained ? "exhausted" : "healthy",
            success: true,
            message: drained
              ? "weekly Build pool exhausted (GetGrokCreditsConfig)"
              : `weekly Build pool ${remaining}/100 (GetGrokCreditsConfig)`,
            quota: {
              limit,
              remaining,
              used,
              resetAt: asGrokQuota.resetAt,
              source: asGrokQuota.source || "grok.com/GetGrokCreditsConfig",
            },
            ...(ready.refreshedTokens ? { tokens: ready.refreshedTokens } : {}),
          };
          if (drained) return weeklyBase;
          const bearer =
            (await ensureFreshAccessToken(working)) ||
            getOAuthTokens(working)?.access_token ||
            "";
          return this.withOptionalChatLiveness(working, bearer, weeklyBase, signal);
        }

        const absolute = isAbsoluteGrokOAuthQuota(asGrokQuota);
        const drained =
          asGrokQuota.remaining <= 0 &&
          (asGrokQuota.limit > 0 ||
            asGrokQuota.source.includes("free-usage-exhausted") ||
            asGrokQuota.source.includes("exhausted"));
        const remainingTrusted =
          drained ||
          isTrustedGrokAbsoluteRemaining(asGrokQuota.limit, asGrokQuota.remaining);

        const packageLimit =
          asGrokQuota.limit > 0
            ? Math.floor(asGrokQuota.limit)
            : Math.floor(Number(oauth?.credits_limit) || Number(working.quotaLimit) || 0);

        let tokensOut: unknown = ready.refreshedTokens;
        if (oauth && (absolute || drained)) {
          // Only pin credits_remaining when we have a trusted value (partial
          // header burn, or exhausted 0). Never force full package over local debit.
          const localRem = Number(
            oauth.credits_remaining ?? working.quotaRemaining ?? NaN,
          );
          let nextRemaining: number | undefined;
          if (drained) {
            nextRemaining = 0;
          } else if (remainingTrusted) {
            nextRemaining = Math.floor(Math.max(0, asGrokQuota.remaining));
            if (Number.isFinite(localRem) && localRem > 0) {
              nextRemaining = Math.min(Math.floor(localRem), nextRemaining);
            }
          } else if (Number.isFinite(localRem) && localRem > 0 && localRem < packageLimit) {
            nextRemaining = Math.floor(localRem);
          }
          tokensOut = {
            ...oauth,
            ...(packageLimit > 0 ? { credits_limit: packageLimit } : {}),
            ...(nextRemaining != null ? { credits_remaining: nextRemaining } : {}),
          };
        }

        // Untrusted full package (remaining==limit 2M) — do not write quota.
        // Live quota already returned with this bearer → trust auth, skip models gate.
        if (
          !drained &&
          !remainingTrusted &&
          String(asGrokQuota.source || "").includes("untrusted-full-remaining")
        ) {
          const untrustedBase: ProviderHealthResult = {
            kind: "healthy",
            success: true,
            message: "token alive; skipped untrusted full rate-limit package",
            ...(tokensOut ? { tokens: tokensOut } : ready.refreshedTokens ? { tokens: ready.refreshedTokens } : {}),
          };
          const bearer =
            (await ensureFreshAccessToken(working)) ||
            getOAuthTokens(working)?.access_token ||
            "";
          return this.withOptionalChatLiveness(working, bearer, untrustedBase, signal);
        }

        if (drained) {
          return {
            kind: "exhausted",
            success: true,
            quota: {
              limit: packageLimit,
              remaining: 0,
              used: packageLimit > 0 ? packageLimit : asGrokQuota.used,
              resetAt: asGrokQuota.resetAt,
              source: asGrokQuota.source,
            },
            ...(tokensOut ? { tokens: tokensOut } : {}),
          };
        }

        const absoluteHealthy: ProviderHealthResult = {
          kind: "healthy",
          success: true,
          quota: {
            limit: asGrokQuota.limit,
            remaining: asGrokQuota.remaining,
            used: asGrokQuota.used,
            resetAt: asGrokQuota.resetAt,
            source: asGrokQuota.source,
          },
          ...(tokensOut ? { tokens: tokensOut } : {}),
        };
        {
          const bearer =
            (await ensureFreshAccessToken(working)) ||
            getOAuthTokens(working)?.access_token ||
            "";
          return this.withOptionalChatLiveness(working, bearer, absoluteHealthy, signal);
        }
      }

      // 2) Credit probe failed — fall back to classified models liveness.
      //    Never report Build 403 as "invalid after refresh" (RT may still work).
      //    Transient models failures keep the account out of hard error.
      const models = await probeOAuthModelsLiveness(working);
      const fallback = classifyGrokOAuthFallbackFromModels(models);
      if (fallback.kind === "healthy") {
        const modelsHealthy: ProviderHealthResult = {
          kind: "healthy",
          success: true,
          // no quota → warmup will not overwrite remaining with a fake 2M
          message: live.error
            ? `token alive; live credit probe failed: ${live.error}`
            : "token alive; live credit probe returned no quota",
          ...(ready.refreshedTokens ? { tokens: ready.refreshedTokens } : {}),
        };
        const bearer =
          (await ensureFreshAccessToken(working)) ||
          getOAuthTokens(working)?.access_token ||
          "";
        return this.withOptionalChatLiveness(working, bearer, modelsHealthy, signal);
      }
      return {
        kind: fallback.kind,
        success: false,
        retryable: fallback.retryable,
        error: fallback.error || live.error || "OAuth liveness probe failed",
        ...(ready.refreshedTokens ? { tokens: ready.refreshedTokens } : {}),
        metadata: {
          modelsReason: models.reason,
          modelsStatus: models.status,
          liveQuotaError: live.error,
        },
      };
    }

    // SSO path — delegate to the base implementation.
    return super.healthCheck(account, signal);
  }

  async validateAccount(account: Account): Promise<boolean> {
    // OAuth path — refresh if needed (coordinator), then probe /v1/models (free).
    if (isOAuthAccount(account)) {
      const ready = await this.refreshOAuthIfNeeded(account);
      if (ready.error) return false;
      const { alive } = await validateOAuthToken(ready.account);
      return alive;
    }

    // SSO path.
    const tokens = this.getTokens(account);
    if (!tokens?.sso) return false;

    try {
      const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
        method: "GET",
        headers: {
          "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch the account's current rate-limit / quota status from grok.com.
   * Returns the raw quota object or null on failure.
   */
  async getQuota(account: Account): Promise<any | null> {
    const tokens = this.getTokens(account);
    if (!tokens?.sso) return null;

    try {
      const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
        method: "GET",
        headers: {
          "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }
}

/**
 * After a successful Grok request on a weekly-percent account (quotaLimit 0–100),
 * re-probe GetGrokCreditsConfig and write remaining so the dashboard pool bar
 * updates live. Token debit is intentionally skipped on the percent scale
 * (one request would wipe remaining); exhaustion still zeros via markExhausted.
 *
 * Fire-and-forget from the proxy edge. Failures are silent (next warmup heals).
 */
export async function refreshGrokWeeklyPoolAfterRequest(account: Account): Promise<void> {
  try {
    if (!account?.id || account.id <= 0) return;
    if (account.provider !== "grok") return;
    if (!isGrokWeeklyPercentQuotaLimit(account.quotaLimit)) return;
    // Only OAuth accounts have GetGrokCreditsConfig; SSO uses rate-limits JSON.
    if (!isOAuthAccount(account)) return;

    const provider = new GrokProvider();
    const live = await provider.fetchQuota(account);
    if (!live.success || !live.quota) return;

    const q = live.quota;
    const isWeekly =
      q.percentScale === true ||
      (Number(q.limit) === 100 && String(q.source || "").includes("GetGrokCreditsConfig"));
    if (!isWeekly) return;

    const limit = 100;
    const remaining = Math.min(limit, Math.max(0, Math.floor(Number(q.remaining))));
    let resetAt: Date | null | undefined = undefined;
    if (q.resetAt) {
      const d = q.resetAt instanceof Date ? q.resetAt : new Date(q.resetAt as any);
      if (!Number.isNaN(d.getTime())) resetAt = d;
    }

    const { pool } = await import("../../pool");
    await pool.applyQuotaSnapshot(account.id, {
      quotaRemaining: remaining,
      quotaLimit: limit,
      ...(resetAt !== undefined ? { quotaResetAt: resetAt } : {}),
    });
  } catch {
    // best-effort; do not fail the client response
  }
}