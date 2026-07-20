import { Hono } from "hono";
import { routeRequest, getAllModels, providers } from "./router";
import { db } from "../db/index";
import { requestLogs, usageSummary, accounts, apiKeys, type NewRequestLog } from "../db/schema";
import { pool } from "./pool";
import { broadcast } from "../ws/index";
import type { ChatCompletionRequest, CreditSource, ProviderResult } from "./providers/base";
import { resolveProviderInstance } from "./providers/registry";
import {
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  normalizeRequestToOpenAI,
  type AnthropicMessagesRequest,
} from "./transforms/anthropic";
import {
  responsesRequestToChat,
  chatResponseToResponses,
  chatStreamToResponsesStream,
  newResponsesResponseMeta,
  type ResponsesApiRequest,
} from "./transforms/openai-responses";
import { forcedSseToJson } from "./transforms/forced-sse-to-json";
import { isBadUpstreamRequest, isInvalidModelError } from "./errors";
import { prepareLogBody } from "./logging";
import { resolveModelAlias } from "./model-mapping";
import { estimateRequestTokens } from "./compression";
import { calculateCost, type TokenBreakdown } from "./pricing";
import { and, desc, eq, gt, gte, isNotNull, sql } from "drizzle-orm";
import { providerList, refreshByokModels } from "./providers/registry";
import {
  extractWebSearchConfig,
  stripWebSearchTools,
  runWebSearchLoopNonStreaming,
  runWebSearchLoopStreaming,
} from "./built-in-tools/agent-loop";
import { config } from "../config";
import {
  isGrokWeeklyPercentQuotaLimit,
  refreshGrokWeeklyPoolAfterRequest,
} from "./providers/grok";
import { RateLimiter } from "../utils/security";
import {
  checkKeyAccess,
  parseAllowedModels,
  modelAllowed,
  recordKeyTokens,
} from "./friend-keys";
import { getActiveClientRequests, trackClientRequestStart } from "./live-clients";
import {
  averageSpeedMetrics,
  isContentfulStreamChunk,
  type SpeedSample,
} from "./share-metrics";
import type { ModelInfo } from "./providers/base";

export const proxyRouter = new Hono();

// ── Friend-key share / gating state ──────────────────────────────────────────
// Short-TTL cache of the merged model catalog so /v1/share and /v1/models never
// hammer the per-account pool lookup on every poll from the status page.
// Separate entries for active-only vs full catalog so one never shadows the other.
const MODELS_CACHE_TTL_MS = 60_000;
const modelsCache = new Map<"all" | "active", { data: ModelInfo[]; expiresAt: number }>();

async function getActiveModelsCached(activeOnly: boolean): Promise<ModelInfo[]> {
  const cacheKey = activeOnly ? "active" : "all";
  const hit = modelsCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.data;
  }
  await refreshByokModels();
  let models = getAllModels();
  if (activeOnly) {
    const filtered: ModelInfo[] = [];
    await Promise.all(models.map(async (m) => {
      const acct = await pool.getAccountForModel(m.id).catch(() => null);
      if (acct) filtered.push(m);
    }));
    models = filtered;
  }
  modelsCache.set(cacheKey, { data: models, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
  return models;
}

// Per-key request buckets + a brute-force limiter for the authless /v1/share.
const keyRequestLimiters = new Map<number, RateLimiter>();
const shareLimiter = new RateLimiter(30, 30);

function getClientIpFromHeaders(h: Headers): string {
  return (h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown");
}

function isLocalRequest(headers: Headers, hostname: string): boolean {
  const xf = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const xr = headers.get("x-real-ip");
  const ip = xf || xr || "";
  const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", ""]);
  const host = (hostname || "").toLowerCase();
  return LOCAL.has(ip) || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Structured friend-key gate rejection (OpenAI error envelope). */
type FriendKeyGateDenial = {
  status: number;
  body: { error: { message: string; type: string; code: string } };
  retryAfterSec?: number;
};

/**
 * Thrown when a managed friend key may not serve a completion (quota, allowlist,
 * expiry/inactive, or per-key rate cap). Thrown from handleChatCompletion so
 * every entrypoint (/v1/chat/completions, /v1/messages, /v1/responses, Codex
 * alias) is gated once — route handlers must not re-call the limiter or the
 * RPM bucket is double-debited.
 */
export class FriendKeyLimitError extends Error {
  readonly status: number;
  readonly body: FriendKeyGateDenial["body"];
  readonly retryAfterSec?: number;

  constructor(denial: FriendKeyGateDenial) {
    super(denial.body.error.message);
    this.name = "FriendKeyLimitError";
    this.status = denial.status;
    this.body = denial.body;
    this.retryAfterSec = denial.retryAfterSec;
  }
}

/**
 * Evaluate friend-key limits for a managed key. Returns null when the request
 * may proceed (no apiKeyId / unlimited legacy key, or within all limits).
 */
async function evaluateFriendKeyLimits(
  apiKeyId: number | null,
  model: string,
): Promise<FriendKeyGateDenial | null> {
  if (!apiKeyId) return null; // legacy single env/settings key is never limited
  const access = await checkKeyAccess(apiKeyId);
  if (!access.allowed) {
    const body =
      access.reason === "expired"
        ? { error: { message: "This API key has expired.", type: "auth_error", code: "key_expired" } }
        : access.reason === "quota_exhausted"
          ? {
              error: {
                message: "This API key's token quota is exhausted.",
                type: "insufficient_quota",
                code: "quota_exhausted",
              },
            }
          : { error: { message: "This API key is not active.", type: "auth_error", code: "key_inactive" } };
    return { status: 403, body };
  }
  const allowlist = parseAllowedModels(access.row.allowedModels);
  if (!modelAllowed(allowlist, model)) {
    return {
      status: 403,
      body: {
        error: {
          message: `Model '${model}' is not allowed for this API key.`,
          type: "invalid_request_error",
          code: "model_not_allowed",
        },
      },
    };
  }
  if (access.row.rateLimit && access.row.rateLimit > 0) {
    let limiter = keyRequestLimiters.get(apiKeyId);
    if (!limiter) {
      limiter = new RateLimiter(access.row.rateLimit, access.row.rateLimit);
      keyRequestLimiters.set(apiKeyId, limiter);
    }
    const rl = limiter.check(`key:${apiKeyId}`);
    if (!rl.allowed) {
      return {
        status: 429,
        body: {
          error: {
            message: "Rate limit exceeded for this API key.",
            type: "rate_limit_error",
            code: "rate_limited",
          },
        },
        retryAfterSec: Math.ceil((rl.retryAfterMs ?? 60_000) / 1000),
      };
    }
  }
  return null;
}

/** Fail closed for managed friend keys; no-op for pool/legacy keys. */
async function assertFriendKeyLimits(apiKeyId: number | null, model: string): Promise<void> {
  const denial = await evaluateFriendKeyLimits(apiKeyId, model);
  if (denial) throw new FriendKeyLimitError(denial);
}

/** Map FriendKeyLimitError to an HTTP response (OpenAI or Anthropic envelope). */
function friendKeyLimitResponse(
  c: { json: (body: unknown, status?: number, headers?: Record<string, string>) => Response },
  err: FriendKeyLimitError,
  format: "openai" | "anthropic" = "openai",
): Response {
  const headers =
    err.retryAfterSec != null ? { "Retry-After": String(err.retryAfterSec) } : undefined;
  if (format === "anthropic") {
    // Anthropic Messages clients expect { type: "error", error: { type, message } }.
    const t = err.body.error.type;
    const anthropicType =
      t === "insufficient_quota" || t === "rate_limit_error"
        ? "rate_limit_error"
        : t === "invalid_request_error"
          ? "invalid_request_error"
          : "authentication_error";
    const body = { type: "error", error: { type: anthropicType, message: err.body.error.message } };
    return headers ? c.json(body, err.status, headers) : c.json(body, err.status);
  }
  return headers ? c.json(err.body, err.status, headers) : c.json(err.body, err.status);
}

/**
 * Reject oversized request bodies before parsing JSON. Prevents a single
 * huge payload from OOMing the process. Default 32 MB (configurable via env);
 * generous enough for large multimodal/context-heavy requests.
 */
const MAX_BODY_BYTES =
  Number(process.env.POOLPROX_MAX_BODY_BYTES) || 32 * 1024 * 1024;

proxyRouter.use("/v1/*", async (c, next) => {
  const cl = Number(c.req.header("content-length") || "0");
  if (cl > MAX_BODY_BYTES) {
    return c.json(
      { error: { message: `Request body too large (${cl} > ${MAX_BODY_BYTES} bytes)`, type: "invalid_request_error" } },
      413,
    );
  }
  await next();
});

// Cap recent detail rows. History/analytics live in usage_summary (hourly).
const MAX_REQUEST_LOGS = Number(process.env.POOLPROX_MAX_REQUEST_LOGS) || 500;
// How often to reclaim free pages after prune (VACUUM is exclusive — keep rare).
const VACUUM_EVERY_MS =
  Number(process.env.POOLPROX_REQUEST_LOG_VACUUM_MS) || 6 * 60 * 60 * 1000; // 6h
let lastVacuumAt = 0;

/** Upsert a request's stats into the usage_summary table (hourly bucket) */
async function upsertUsageSummary(entry: {
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsUsed: number;
  cost: number;
  durationMs: number;
}) {
  try {
    const bucket = new Date();
    bucket.setMinutes(0, 0, 0); // truncate to hour

    await db.run(sql`
      INSERT INTO usage_summary (bucket, provider, model, total_requests, success_requests, error_requests, prompt_tokens, completion_tokens, total_tokens, credits_used, total_cost, total_duration_ms)
      VALUES (${bucket.toISOString()}, ${entry.provider || "unknown"}, ${entry.model || "unknown"}, 1,
        ${entry.status === "success" ? 1 : 0}, ${entry.status === "error" ? 1 : 0},
        ${entry.promptTokens || 0}, ${entry.completionTokens || 0}, ${entry.totalTokens || 0},
        ${entry.creditsUsed || 0}, ${entry.cost || 0}, ${entry.durationMs || 0})
      ON CONFLICT (bucket, provider, model) DO UPDATE SET
        total_requests = usage_summary.total_requests + excluded.total_requests,
        success_requests = usage_summary.success_requests + excluded.success_requests,
        error_requests = usage_summary.error_requests + excluded.error_requests,
        prompt_tokens = usage_summary.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = usage_summary.completion_tokens + excluded.completion_tokens,
        total_tokens = usage_summary.total_tokens + excluded.total_tokens,
        credits_used = usage_summary.credits_used + excluded.credits_used,
        total_cost = usage_summary.total_cost + excluded.total_cost,
        total_duration_ms = usage_summary.total_duration_ms + excluded.total_duration_ms
    `);
  } catch (err) {
    console.error("[Proxy] Failed to upsert usage_summary:", err);
  }
}

/**
 * Prune request_logs so the table (and file) cannot grow without bound.
 *
 * 1. Keep only the newest MAX_REQUEST_LOGS rows (detail UI / recent feed).
 * 2. Strip body blobs from any remaining rows that still have them (legacy
 *    installs that stored multi-MB full bodies while logBodyFull defaulted on).
 * 3. Periodically VACUUM so SQLite returns free pages to the OS — DELETE alone
 *    does not shrink the file (that is why a 2000-row table reached multi-GB).
 *
 * Long-term totals stay in usage_summary (aggregated per hour).
 */
async function pruneRequestLogs() {
  try {
    await db.run(sql`
      DELETE FROM request_logs WHERE id NOT IN (
        SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ${MAX_REQUEST_LOGS}
      )
    `);
    // When body logging is off (default), strip legacy multi-MB blobs left by
    // older builds that stored full prompts. If the operator opts into
    // POOLPROX_LOG_BODY_ENABLED=true, keep whatever is stored for debugging.
    if (!config.logBodyEnabled) {
      await db.run(sql`
        UPDATE request_logs
        SET request_body = NULL,
            response_body = NULL,
            compressed_request_body = NULL
        WHERE request_body IS NOT NULL
           OR response_body IS NOT NULL
           OR compressed_request_body IS NOT NULL
      `);
    }
  } catch (err) {
    console.error("[Proxy] Failed to prune request_logs:", err);
    return;
  }

  const now = Date.now();
  if (now - lastVacuumAt < VACUUM_EVERY_MS) return;
  lastVacuumAt = now;
  try {
    // Exclusive lock briefly; only every VACUUM_EVERY_MS.
    await db.run(sql`VACUUM`);
    console.log("[Proxy] request_logs prune + VACUUM complete");
  } catch (err) {
    console.error("[Proxy] VACUUM after prune failed:", err);
  }
}

/** Extract the upstream response id for sticky response-id pinning. */
function extractResponseId(result: ProviderResult | undefined): string | undefined {
  if (!result?.response) return undefined;
  const r = result.response as any;
  return r.id || r.response?.id || undefined;
}

export async function recordRequest(entry: NewRequestLog) {
  try {
    // Returning id so Requests / live feeds can match rows (they require numeric id).
    const [created] = await db.insert(requestLogs).values(entry).returning({
      id: requestLogs.id,
      createdAt: requestLogs.createdAt,
    });
    // Await summary write before WS so dashboard refetch cannot race an empty bucket.
    await upsertUsageSummary({
      provider: entry.provider || "unknown",
      model: entry.model || "unknown",
      status: entry.status,
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      totalTokens: entry.totalTokens || 0,
      creditsUsed: entry.creditsUsed || 0,
      cost: entry.cost || 0,
      durationMs: entry.durationMs || 0,
    });
    // Log pruning is background-only (setInterval below) to avoid SQLite write contention.
    broadcast({
      type: "request_log",
      data: {
        ...entry,
        id: created?.id,
        email: entry.accountEmail,
        createdAt: created?.createdAt?.toISOString?.() || new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[Proxy] Failed to record request:", err);
  }
}

function normalizeModelId(model: string): string {
  // Common typo seen from clients: "sonet" -> canonical Anthropic "sonnet".
  return model.replace(/claude-sonet/gi, "claude-sonnet");
}


function computeCredits(
  provider: string,
  model: string,
  totalTokens: number,
  resultCredits?: number,
  resultCreditSource?: CreditSource
) {
  if (resultCredits !== undefined && resultCredits > 0) {
    return {
      creditsUsed: Math.max(0.01, resultCredits),
      creditSource: resultCreditSource || "upstream" as CreditSource,
    };
  }

  if (totalTokens > 0) {
    const inst = resolveProviderInstance(provider);
    const rate = inst?.getProviderCreditRate(model) ?? 0;
    return {
      creditsUsed: Math.max(0.01, totalTokens * rate),
      creditSource: "estimated" as CreditSource,
    };
  }

  return {
    creditsUsed: 0,
    creditSource: resultCreditSource || "estimated" as CreditSource,
  };
}

/** Current managed API key id stashed by /v1 auth middleware (if any). */
function currentApiKeyId(req?: Request | null): number | null {
  try {
    const id = (req as any)?.apiKeyId;
    return typeof id === "number" && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function extractUsageFromSsePayload(payload: string) {
  if (!payload || payload === "[DONE]") return null;
  try {
    return extractUsageFromParsed(JSON.parse(payload));
  } catch {
    return null;
  }
}

/** Usage extraction from an ALREADY-parsed SSE chunk (no re-parse). */
function extractUsageFromParsed(parsed: any) {
  const usage = parsed?.usage;
  const content = extractStreamContentFromParsed(parsed);
  return {
    content,
    promptTokens: Number(usage?.prompt_tokens || usage?.input_tokens || 0),
    completionTokens: Number(usage?.completion_tokens || usage?.output_tokens || 0),
    totalTokens: Number(usage?.total_tokens || 0),
    creditsUsed: Number(usage?.credits_used || usage?.creditsUsed || usage?.credit || parsed?.credits_used || parsed?.creditsUsed || 0),
    cachedTokens: Number(usage?.cached_tokens || usage?.cache_read_input_tokens || 0),
    cacheCreationTokens: Number(usage?.cache_creation_input_tokens || 0),
    reasoningTokens: Number(usage?.reasoning_tokens || 0),
  };
}

/**
 * Extract a full TokenBreakdown (incl. cached/reasoning/cache-creation) from an
 * upstream `usage` object. Used on the non-stream path where the whole response
 * (with `usage`) is available at once. Falls back to 0 for any missing field.
 */
function extractBreakdown(usage: any): TokenBreakdown {
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
  }
  return {
    promptTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    completionTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    cachedTokens: Number(usage.cached_tokens || usage.cache_read_input_tokens || 0),
    cacheCreationTokens: Number(usage.cache_creation_input_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || 0),
  };
}

/** Accumulate streamed text content across SSE chunks for token estimation */
function extractStreamContent(payload: string): string {
  if (!payload || payload === "[DONE]") return "";
  try {
    return extractStreamContentFromParsed(JSON.parse(payload));
  } catch {
    return "";
  }
}

/** Content extraction from an ALREADY-parsed SSE chunk (no re-parse). */
function extractStreamContentFromParsed(parsed: any): string {
  const choice = parsed?.choices?.[0];
  // Include reasoning_content in the accumulated text so token estimates
  // account for thinking/reasoning output, not just visible text.
  const text = String(
    choice?.delta?.content ??
    choice?.message?.content ??
    choice?.text ??
    parsed?.delta?.content ??
    parsed?.content ??
    parsed?.text ??
    ""
  );
  const reasoning = String(
    choice?.delta?.reasoning_content ??
    choice?.message?.reasoning_content ??
    parsed?.delta?.reasoning_content ??
    ""
  );
  return text + (reasoning ? reasoning : "");
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessagesTokens(messages: ChatCompletionRequest["messages"]): number {
  return (messages || []).reduce((total, msg) => {
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as any[])
        .map((block) => {
          if (block?.type === "text" && typeof block.text === "string") return block.text;
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") return block.content;
            if (Array.isArray(block.content)) {
              return block.content.map((b: any) => b?.text || "").join("");
            }
          }
          return JSON.stringify(block || "");
        })
        .join("");
    } else {
      content = JSON.stringify(msg.content || "");
    }
    return total + estimateTokensFromText(content) + 4;
  }, 0);
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError ||
    (error instanceof Error && /json|parse|unexpected end|unexpected token/i.test(error.message));
}

function openAIErrorResponse(message: string, status: 400 | 503) {
  return {
    error: {
      message,
      type: status === 400 ? "invalid_request_error" : "server_error",
      code: status === 400 ? "invalid_json" : "proxy_error",
    },
  };
}

async function logProxyError(entry: NewRequestLog, label: string) {
  try {
    await db.insert(requestLogs).values(entry);
    // Also track errors in usage_summary (await so any WS error feed stays consistent).
    await upsertUsageSummary({
      provider: entry.provider || "unknown",
      model: entry.model || "unknown",
      status: "error",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      creditsUsed: 0,
      cost: 0,
      durationMs: entry.durationMs || 0,
    });
  } catch (logError) {
    console.error(`[Proxy] Failed to log ${label}:`, logError);
  }
}

// Prune request_logs periodically (every 5 min) instead of inline on the hot
// path. The DELETE-with-subquery pattern competes with other writes for
// SQLite's single-writer lock — moving it to a background timer avoids that.
// First run shortly after boot so legacy multi-GB body blobs get cleared soon.
setTimeout(() => { void pruneRequestLogs(); }, 15_000);
setInterval(() => { void pruneRequestLogs(); }, 5 * 60_000);

function wrapStreamWithUsageFinalizer(
  stream: ReadableStream<Uint8Array>,
  context: {
    logId?: number;
    accountId: number;
    accountEmail: string;
    provider: string;
    model: string;
    quotaBefore: number;
    /** Account package / weekly-percent limit — skip token debit when 1–100 (Grok weekly %). */
    quotaLimit?: number;
    startedAt: number;
    fallbackPromptTokens: number;
    fallbackCompletionTokens: number;
    fallbackTotalTokens: number;
    fallbackCreditsUsed: number;
    fallbackCreditSource: CreditSource;
    useFreeCounter: boolean;
    /** Synthetic node accounts (id<=0) — skip pool mutators / trackRequestEnd. */
    skipPoolMutations?: boolean;
    /** Friend-key id whose token budget should be debited when the stream's usage is known. */
    apiKeyId?: number | null;
    /** Optional client in-flight release (share board concurrent count). Idempotent. */
    onClientComplete?: () => void;
  }
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let reader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  // H3: only buffer streamed text when it will be consumed — as a completion-
  // token fallback (when the caller gave none) or for response-body logging.
  const keepStreamedContent = context.fallbackCompletionTokens <= 0 || config.logBodyEnabled;
  // Accumulate raw bytes in an array, join once per chunk. Avoids O(n²) string
  // concatenation where each += re-allocates and copies the growing string.
  const rawChunks: string[] = [];
  let buffer = "";
  let streamedContent = "";
  let streamedParts: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let upstreamCredits = 0;
  // token-breakdown accumulation for USD cost (cached/reasoning/cache-creation).
  let cachedTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  let finalized = false;
  let streamError = false;
  // First contentful SSE chunk clock (request-relative ms). Captured once.
  let firstContentAt: number | null = null;

  const observe = (chunk: Uint8Array) => {
    rawChunks.push(decoder.decode(chunk, { stream: true }));
    // Join accumulated chunks once per observe call, not on every +=.
    buffer += rawChunks.splice(0).join("");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

      // Parse each SSE payload ONCE and reuse the object for error detection,
      // content extraction, and usage extraction (was: 3 separate JSON.parse
      // calls per token). Non-JSON payloads are skipped.
      const trimmedPayload = payload.trim();
      if (!trimmedPayload || trimmedPayload === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmedPayload);
      } catch {
        continue; // not JSON (shouldn't happen for well-formed SSE), skip
      }

      // Detect upstream errors in SSE stream (Qoder 403 in body, OpenAI error format)
      if (parsed.type === "upstream_error") streamError = true;
      if (parsed.statusCodeValue && parsed.statusCodeValue >= 400) streamError = true;
      if (parsed.error && (typeof parsed.error === "object" || typeof parsed.error === "string")) streamError = true;

      if (firstContentAt == null && isContentfulStreamChunk(parsed)) {
        firstContentAt = Date.now();
      }

      const usage = extractUsageFromParsed(parsed);
      // Only retain content when it will actually be consumed (token-estimate
      // fallback and/or response-body logging). Skipping this avoids buffering
      // the entire stream for the common case where logging is off (H3).
      if (keepStreamedContent && usage.content) streamedParts.push(usage.content);
      promptTokens = usage.promptTokens || promptTokens;
      completionTokens = usage.completionTokens || completionTokens;
      totalTokens = usage.totalTokens || totalTokens;
      upstreamCredits = usage.creditsUsed || upstreamCredits;
      cachedTokens = usage.cachedTokens || cachedTokens;
      cacheCreationTokens = usage.cacheCreationTokens || cacheCreationTokens;
      reasoningTokens = usage.reasoningTokens || reasoningTokens;
    }
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;

    const finalPromptTokens = promptTokens || context.fallbackPromptTokens;
    const finalCompletionTokens = completionTokens || estimateTokensFromText(streamedParts.join("")) || context.fallbackCompletionTokens;
    const finalTotalTokens = totalTokens || finalPromptTokens + finalCompletionTokens || context.fallbackTotalTokens;
    const { creditsUsed, creditSource } = computeCredits(
      context.provider,
      context.model,
      finalTotalTokens,
      upstreamCredits || context.fallbackCreditsUsed,
      upstreamCredits > 0 ? "upstream" : context.fallbackCreditSource
    );
    const durationMs = Math.max(0, Date.now() - context.startedAt);
    const ttftMs =
      firstContentAt != null
        ? Math.max(0, firstContentAt - context.startedAt)
        : null;

    void (async () => {
      try {
        const isQoder = context.provider === "qoder";

        // If stream had upstream error (403 rate limit, empty stream, etc), don't decrement quota
        // and mark account exhausted for Qoder — but verify with a probe first.
        // Stream errors on Qoder are a noisy signal: rate-limit-per-second,
        // signature replay protection, transient auth all surface as 403.
        // The qd-Lite probe is the authoritative arbiter.
        if (streamError) {
          if (isQoder) {
            // Trust upstream: if Qoder returned a stream error (typically a
            // 403 due to genuine quota exhaustion or rate-limit), mark the
            // account exhausted immediately. Warmup will flip it back to
            // active once Qoder reports available quota again. No probe —
            // we'd rather pay the occasional false-exhaust (lifted on the
            // very next warmup tick) than serve a known-bad account.
            if (!context.skipPoolMutations && context.accountId > 0) {
              await pool.markExhausted(context.accountId);
            }
          }
          // Still update request log with error status
          if (context.logId) {
            await db
              .update(requestLogs)
              .set({
                status: "error",
                errorMessage: "Upstream rate limit or quota exceeded",
                durationMs,
                ttftMs,
              })
              .where(eq(requestLogs.id, context.logId));
          }
          return;
        }

        // Decrement at stream finalization. Qoder free-bucket (qmodel_latest)
        // charges 1 request per call; other Qoder buckets stay unchanged
        // (no local counter — server is sole truth). Non-Qoder providers
        // keep existing token-based decrement.
        let quotaAfter = context.quotaBefore;
        if (!context.skipPoolMutations && context.accountId > 0) {
          if (isQoder && context.useFreeCounter && context.quotaBefore > 0) {
            quotaAfter = await pool.decrementFreeQuota(context.accountId, 1);
          } else if (!isQoder && context.quotaBefore > 0) {
            // Grok weekly % (CLI GetGrokCreditsConfig, limit 0–100): server is
            // source of truth — do not debit tokens onto a percent scale.
            const skipGrokWeeklyDebit =
              context.provider === "grok" &&
              Number(context.quotaLimit ?? 0) > 0 &&
              Number(context.quotaLimit) <= 100;
            if (!skipGrokWeeklyDebit) {
              quotaAfter = await pool.decrementQuota(context.accountId, creditsUsed);
              // Absolute budgets (e.g. Grok free Build ~2M tokens): exclude when spent.
              if (quotaAfter <= 0) {
                await pool.markExhaustedIfQuotaDepleted(context.accountId);
              }
            }
          }
        }

        // USD cost from per-model pricing + the accumulated token breakdown.
        // Never throws (calculateCost catches internally); 0 when unpriced/unknown.
        const breakdown: TokenBreakdown = {
          promptTokens: finalPromptTokens,
          completionTokens: finalCompletionTokens,
          totalTokens: finalTotalTokens,
          cachedTokens,
          cacheCreationTokens,
          reasoningTokens,
        };
        const cost = await calculateCost(context.model, breakdown).catch(() => 0);

        // Streaming providers (Grok cli-chat-proxy always SSE) insert the log
        // row before the stream finishes — responseBody was always null at insert.
        // Assemble a chat.completion-shaped body from observed SSE tokens so the
        // Requests detail drawer can show something when body logging is on.
        const assistantText = streamedParts.join("");
        const streamResponseBody = prepareLogBody({
          id: `chatcmpl-stream-${context.logId ?? "x"}`,
          object: "chat.completion",
          model: context.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: assistantText,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: finalPromptTokens,
            completion_tokens: finalCompletionTokens,
            total_tokens: finalTotalTokens,
          },
          _poolprox: { stream: true, creditSource },
        });

        if (context.logId) {
          await db
            .update(requestLogs)
            .set({
              promptTokens: finalPromptTokens,
              completionTokens: finalCompletionTokens,
              totalTokens: finalTotalTokens,
              creditsUsed,
              cost,
              durationMs,
              ttftMs,
              accountQuotaAfter: quotaAfter,
              ...(streamResponseBody != null ? { responseBody: streamResponseBody } : {}),
            })
            .where(eq(requestLogs.id, context.logId));
        }

        // Persist usage_summary BEFORE request_log so dashboard WS revalidate
        // cannot read a pre-upsert snapshot (stream path previously raced this).
        await upsertUsageSummary({
          provider: context.provider,
          model: context.model,
          status: "success",
          promptTokens: finalPromptTokens,
          completionTokens: finalCompletionTokens,
          totalTokens: finalTotalTokens,
          creditsUsed,
          cost,
          durationMs,
        });

        // Friend-key token quota: debit the stream's actual tokens against the key's budget.
        await recordKeyTokens(context.apiKeyId, finalTotalTokens);

        broadcast({
          type: "request_log",
          data: {
            id: context.logId,
            accountId: context.accountId,
            accountEmail: context.accountEmail,
            email: context.accountEmail,
            provider: context.provider,
            model: context.model,
            promptTokens: finalPromptTokens,
            completionTokens: finalCompletionTokens,
            totalTokens: finalTotalTokens,
            creditsUsed,
            cost,
            status: "success",
            durationMs,
            ttftMs,
            accountQuotaBefore: context.quotaBefore,
            accountQuotaAfter: quotaAfter,
            createdAt: new Date(context.startedAt).toISOString(),
            // Light WS payload — full request body already stored at insert.
            // Do not re-send multi-KB bodies on every stream end.
          },
        });

        // Grok weekly pool: re-probe after stream completes (token debit skipped).
        if (
          context.provider === "grok" &&
          context.accountId > 0 &&
          isGrokWeeklyPercentQuotaLimit(context.quotaLimit)
        ) {
          void db
            .select()
            .from(accounts)
            .where(eq(accounts.id, context.accountId))
            .limit(1)
            .then((rows) => {
              const a = rows[0];
              if (a) void refreshGrokWeeklyPoolAfterRequest(a);
            })
            .catch(() => {});
        }
      } catch (error) {
        console.error("[Proxy] Failed to finalize stream usage:", error);
      } finally {
        if (!context.skipPoolMutations && context.accountId > 0) {
          pool.trackRequestEnd(context.accountId);
        }
        // Release share-board concurrent client count with the same lifetime as the stream.
        try {
          context.onClientComplete?.();
        } catch {
          /* ignore */
        }
      }
    })();
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamReader = stream.getReader();
      reader = streamReader;
      try {
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) break;
          observe(value);
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        return;
      } finally {
        try {
          controller.close();
        } catch {
          // The stream may already be closed/cancelled by the client.
        }
        finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        finalize();
      }
    },
  });
}

export async function handleChatCompletion(
  body: ChatCompletionRequest,
  opts?: { apiKeyId?: number | null; request?: Request | null },
) {
  // Share-board concurrent clients: count every in-flight completion (stream + non-stream).
  // Streams release in wrapStream finalize; non-streams release in the outer finally.
  const endClient = trackClientRequestStart();
  let shouldReleaseClient = true;

  // Rewrite the incoming model id to its mapped target (CLI integration, e.g.
  // Claude Code's hardcoded haiku/sonnet/opus ids -> a model in the pool).
  body = { ...body, model: resolveModelAlias(normalizeModelId(body.model)) };

  // Friend-key gating (quota / allowlist / expiry / RPM) — single owner for all
  // completion entrypoints so /v1/messages and /v1/responses cannot bypass the
  // chat-only check that previously left exhausted keys queryable.
  const gateApiKeyId = opts?.apiKeyId ?? currentApiKeyId(opts?.request ?? null);
  try {
    await assertFriendKeyLimits(gateApiKeyId, body.model);
  } catch (err) {
    endClient();
    throw err;
  }

  const isStream = body.stream === true;
  // if the client wants non-stream but the provider is streaming-only,
  // fetch the stream upstream and assemble it into a single JSON response.
  // Resolve the provider name from the model to check forceStream before the
  // routeRequest call (which is where `provider` is normally assigned).
  const preProviderName = pool.getProviderForModel(body.model);
  const preInst = preProviderName ? resolveProviderInstance(preProviderName) : null;
  const providerForceStream = !!(preInst as any)?.forceStream;
  const effectiveStream = isStream || providerForceStream;

  try {
  const { result, account, provider, durationMs, compressionStats, compressedRequest } = await routeRequest(body, effectiveStream);
  const resolvedApiKeyId =
    opts?.apiKeyId ??
    currentApiKeyId(opts?.request ?? null);
  let shouldReleaseTracking = true;

  try {
    // forced SSE→JSON — assemble the stream into a single response object
    // for a non-streaming client that hit a streaming-only provider.
    if (!isStream && providerForceStream && result.success && result.stream) {
      try {
        result.response = await forcedSseToJson(result.stream, body.model);
        result.stream = undefined;
      } catch {
        return {
          result: { success: false, error: "Invalid SSE response from streaming-only provider" } as any,
          account, provider, durationMs, compressionStats, compressedRequest,
        };
      }
    }
    const promptTokens = result.promptTokens || result.response?.usage?.prompt_tokens || estimateMessagesTokens(body.messages);
    const completionTokens = result.completionTokens || result.response?.usage?.completion_tokens || 0;
    const totalTokens = result.tokensUsed || result.response?.usage?.total_tokens || promptTokens + completionTokens;
    // Full token breakdown (cached/reasoning/cache-creation) for USD cost.
    const breakdown = extractBreakdown(result.response?.usage);
    breakdown.promptTokens = promptTokens;
    breakdown.completionTokens = completionTokens;
    breakdown.totalTokens = totalTokens;

  const { creditsUsed, creditSource } = computeCredits(
    provider,
    body.model,
    totalTokens,
    result.creditsUsed,
    result.creditSource
  );
  // USD cost from per-model pricing. Never throws; 0 when unpriced/unknown.
  const cost = await calculateCost(body.model, breakdown).catch(() => 0);

    // Qoder: server IS the source of truth, but we now also decrement the
    // local `freeRemaining` counter optimistically for free-bucket models
    // (qmodel_latest). This gives the dashboard real-time numbers instead of
    // waiting for the next warmup mirror. The warmup runner still overrides
    // both columns from /activity each cycle, so any local drift is
    // self-correcting.
    const isStaticLogAccount = !account.id || account.id <= 0;
    const isQoder = provider === "qoder";
    const qoderProvider = providers["qoder"] as { isFreeModel?: (m: string) => boolean } | undefined;
    const useFreeCounter = isQoder && qoderProvider?.isFreeModel?.(body.model) === true;

    const quotaBefore = isQoder
      ? useFreeCounter
        ? Number(account.freeRemaining ?? 0)
        : Number(account.quotaRemaining || 0)
      : Number(account.quotaRemaining || 0);

    // For non-stream paths, decrement immediately. Stream paths and the
    // Qoder paid bucket (where we don't track usage locally) stay unchanged.
    // Static node accounts (id<=0) have no DB row — skip pool mutators.
    let quotaAfter = quotaBefore;
    if (!isStream && !isStaticLogAccount) {
      if (isQoder && useFreeCounter && quotaBefore > 0) {
        // Qoder /activity bucket charges 1 request per call regardless of token count.
        quotaAfter = await pool.decrementFreeQuota(account.id, 1);
      } else if (!isQoder && quotaBefore > 0) {
        const skipGrokWeeklyDebit =
          provider === "grok" &&
          Number(account.quotaLimit ?? 0) > 0 &&
          Number(account.quotaLimit) <= 100;
        if (!skipGrokWeeklyDebit) {
          quotaAfter = await pool.decrementQuota(account.id, creditsUsed);
          // Absolute budgets (e.g. Grok free Build ~2M tokens): exclude when spent.
          if (quotaAfter <= 0) {
            await pool.markExhaustedIfQuotaDepleted(account.id);
          }
        }
      }
    }

  const providerInst = resolveProviderInstance(provider);
  const logEntry = {
    accountId: account.id > 0 ? account.id : null,
    accountEmail: account.email,
    provider,
    model: body.model,
    promptTokens,
    completionTokens,
    totalTokens,
    creditsUsed,
    cost,
    status: "success" as const,
    durationMs,
    // Record the upstream response id for sticky response-id pinning.
    responseId: extractResponseId(result) ?? null,
    // Multi-key attribution (stashed by /v1 auth middleware).
    apiKeyId: resolvedApiKeyId,
    requestBody: prepareLogBody({
      ...body,
      _poolprox: {
        creditSource,
        creditUnit: providerInst?.getProviderCreditUnit(body.model) ?? "token",
        creditRate: providerInst?.getProviderCreditRate(body.model) ?? 0,
      },
    }),
    responseBody: prepareLogBody(result.response),
    accountQuotaBefore: quotaBefore,
    accountQuotaAfter: quotaAfter,
    compressionStats: compressionStats ?? null,
    compressedRequestBody: compressedRequest ? prepareLogBody(compressedRequest) : null,
    savingsByTechnique: compressionStats?.byTechnique
      ? JSON.stringify(compressionStats.byTechnique)
      : null,
  };

    if (isStream && result.stream) {
      const [created] = await db.insert(requestLogs).values(logEntry).returning();
      const createdAt = created?.createdAt?.toISOString?.() || new Date().toISOString();

    broadcast({
      type: "request_started",
      data: { ...logEntry, id: created?.id, email: account.email, createdAt },
    });

    result.stream = wrapStreamWithUsageFinalizer(result.stream, {
      logId: created?.id,
      accountId: account.id > 0 ? account.id : 0,
      accountEmail: account.email,
      provider,
      model: body.model,
      quotaBefore,
      quotaLimit: Number(account.quotaLimit ?? 0),
      startedAt: Date.now() - durationMs,
      fallbackPromptTokens: promptTokens,
      fallbackCompletionTokens: completionTokens,
      fallbackTotalTokens: totalTokens,
      fallbackCreditsUsed: creditsUsed,
      fallbackCreditSource: creditSource,
      useFreeCounter,
      skipPoolMutations: isStaticLogAccount,
      apiKeyId: resolvedApiKeyId,
      onClientComplete: endClient,
    });

      // Stream owns both pool tracking and share-board client count until finalize.
      shouldReleaseTracking = false;
      shouldReleaseClient = false;
      return { result, isStream };
    }

  // Returning id so live Requests list can prepend the row (needs numeric id).
  const [created] = await db.insert(requestLogs).values(logEntry).returning({
    id: requestLogs.id,
    createdAt: requestLogs.createdAt,
  });

  // Await usage_summary so WS-triggered dashboard refetch sees this request.
  await upsertUsageSummary({
    provider,
    model: body.model,
    status: "success",
    promptTokens,
    completionTokens,
    totalTokens,
    creditsUsed,
    cost,
    durationMs,
  });

  // Friend-key token quota: debit the consumed tokens against the key's budget.
  await recordKeyTokens(resolvedApiKeyId, totalTokens);

  // Broadcast lightweight event — strip heavy fields (requestBody/responseBody)
  // that can be 10s of KB each. Clients fetch detail on demand via /api/stats/requests/:id.
  const { requestBody: _rb, responseBody: _rsb, ...lightweightLog } = logEntry;
  broadcast({
    type: "request_log",
    data: {
      ...lightweightLog,
      id: created?.id,
      email: account.email,
      createdAt: created?.createdAt?.toISOString?.() || new Date().toISOString(),
    },
  });

    // Grok weekly pool (0–100): token debit is skipped, so re-probe after success
    // and push account_status so the fleet Credits bar updates live.
    if (
      !isStaticLogAccount &&
      provider === "grok" &&
      isGrokWeeklyPercentQuotaLimit(account.quotaLimit)
    ) {
      void refreshGrokWeeklyPoolAfterRequest(account);
    }

    return { result, isStream };
  } finally {
    if (shouldReleaseTracking && account.id > 0) pool.trackRequestEnd(account.id);
  }
  } finally {
    if (shouldReleaseClient) endClient();
  }
}

/**
 * GET /v1/models - List available models
 * ?active=1 — return ONLY models backed by an active+enabled account (so the
 *   caller doesn't fetch the entire catalog including models no account can
 *   serve). Useful for clients that want a lean, usable model list.
 *
 * Pool/install key (env/settings, no apiKeyId): full catalog (or active subset).
 * Managed key with allowlist: only those model ids (same rule as chat).
 * Managed key without allowlist: same as pool key.
 */
proxyRouter.get("/v1/models", async (c) => {
  // Ensure BYOK cache is fresh before listing models.
  // Without this, the sync getModels() returns stale/empty supportedModels.
  let models = await getActiveModelsCached(c.req.query("active") === "1");

  // Allowlist applies ONLY to managed multi-keys. The install/pool key never
  // sets apiKeyId (see resolveApiKey scope "pool"), so it always sees everything.
  const apiKeyId = (c.req.raw as { apiKeyId?: number }).apiKeyId;
  if (typeof apiKeyId === "number" && apiKeyId > 0) {
    const [row] = await db
      .select({ allowedModels: apiKeys.allowedModels })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1);
    const allowlist = parseAllowedModels(row?.allowedModels);
    if (allowlist && allowlist.length > 0) {
      models = models.filter((m) => modelAllowed(allowlist, m.id));
    }
  }

  return c.json({
    object: "list",
    data: models,
  });
});

type ShareKeyRow = typeof apiKeys.$inferSelect;

/**
 * Friend share-board payload for one managed key.
 * Includes the full key so friends can copy it from the share page — treat
 * SHARE_PORT as a trusted surface (not the public internet without a firewall).
 */
function shareKeyPublic(
  row: ShareKeyRow,
  activeModelIds: string[],
  speed?: { ttftMs: number | null; tokensPerSecond: number | null; sampleSize: number },
): {
  id: number;
  name: string | null;
  key: string;
  keyPreview: string;
  status: string;
  isActive: boolean;
  createdAt: Date | null;
  lastUsedAt: Date | null;
  tokenQuota: number | null;
  tokensUsed: number;
  tokensLeft: number | null;
  rateLimit: number | null;
  expiresAt: Date | null;
  models: string[];
  baseUrl: string;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  sampleSize: number;
} {
  const allowlist = parseAllowedModels(row.allowedModels);
  const usable = activeModelIds.filter((id) => modelAllowed(allowlist, id));
  const tokenQuota = row.tokenQuota ?? null;
  const tokensUsed = row.tokensUsed ?? 0;
  const tokensLeft = tokenQuota != null ? Math.max(0, tokenQuota - tokensUsed) : null;
  const status = !row.isActive
    ? "inactive"
    : (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      ? "expired"
      : (tokenQuota != null && tokensLeft === 0)
        ? "exhausted"
        : "active";
  return {
    id: row.id,
    name: row.name || null,
    key: row.key,
    keyPreview: row.key.slice(0, 12) + "…",
    status,
    isActive: row.isActive,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    tokenQuota,
    tokensUsed,
    tokensLeft,
    rateLimit: row.rateLimit ?? null,
    expiresAt: row.expiresAt,
    models: usable,
    baseUrl: "/v1",
    ttftMs: speed?.ttftMs ?? null,
    tokensPerSecond: speed?.tokensPerSecond ?? null,
    sampleSize: speed?.sampleSize ?? 0,
  };
}

/** Recent successful request samples used for share-board TTFT / tok/s. */
async function loadShareSpeedSamples(windowMs = 15 * 60 * 1000, limit = 200): Promise<
  Array<{ apiKeyId: number | null; completionTokens: number; durationMs: number; ttftMs: number | null }>
> {
  // created_at is integer epoch-ms. Bind a number (not Date/ISO string) so
  // SQLite never hits "datatype mismatch" on integer comparison.
  const sinceMs = Date.now() - windowMs;
  const mapRows = (
    rows: Array<{
      apiKeyId: number | null;
      completionTokens: number | null;
      durationMs: number | null;
      ttftMs?: number | null;
    }>,
  ) =>
    rows.map((r) => ({
      apiKeyId: r.apiKeyId ?? null,
      completionTokens: Number(r.completionTokens) || 0,
      durationMs: Number(r.durationMs) || 0,
      ttftMs:
        r.ttftMs == null || Number.isNaN(Number(r.ttftMs)) ? null : Number(r.ttftMs),
    }));

  try {
    const rows = await db
      .select({
        apiKeyId: requestLogs.apiKeyId,
        completionTokens: requestLogs.completionTokens,
        durationMs: requestLogs.durationMs,
        ttftMs: requestLogs.ttftMs,
      })
      .from(requestLogs)
      .where(
        and(
          eq(requestLogs.status, "success"),
          // Compare against epoch-ms Date so drizzle's timestamp mode encodes an integer.
          gte(requestLogs.createdAt, new Date(sinceMs)),
          isNotNull(requestLogs.durationMs),
          gt(requestLogs.durationMs, 0),
        ),
      )
      .orderBy(desc(requestLogs.createdAt))
      .limit(limit);
    return mapRows(rows);
  } catch (err) {
    // Pre-migrate DBs may lack ttft_ms; retry without it so the board still works.
    const msg = String((err as Error)?.message || err);
    if (/no such column|ttft_ms|datatype mismatch/i.test(msg)) {
      try {
        const rows = await db
          .select({
            apiKeyId: requestLogs.apiKeyId,
            completionTokens: requestLogs.completionTokens,
            durationMs: requestLogs.durationMs,
          })
          .from(requestLogs)
          .where(
            sql`status = 'success'
              AND created_at >= ${sinceMs}
              AND duration_ms IS NOT NULL
              AND duration_ms > 0`,
          )
          .orderBy(sql`created_at DESC`)
          .limit(limit);
        return mapRows(rows.map((r) => ({ ...r, ttftMs: null })));
      } catch (err2) {
        console.error("[Share] Failed to load speed samples (fallback):", err2);
        return [];
      }
    }
    console.error("[Share] Failed to load speed samples:", err);
    return [];
  }
}

function shareRateLimited(c: { req: { raw: { headers: Headers }; url: string } }): Response | null {
  const ip = getClientIpFromHeaders(c.req.raw.headers);
  if (!isLocalRequest(c.req.raw.headers, new URL(c.req.url).hostname)) {
    const rl = shareLimiter.check(`share:${ip}`);
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({ error: { message: "Too many attempts. Try again later.", type: "rate_limit_error" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
  }
  return null;
}

/**
 * GET /v1/share/board — friend status board for ALL managed keys.
 *
 * Powers the bare share page (open :SHARE_PORT). Returns status + full key for
 * copy (friends need the secret for their client). No accounts / admin settings.
 * Rate-limited per IP. Keep SHARE_PORT off the open internet if keys are sensitive.
 */
proxyRouter.get("/v1/share/board", async (c) => {
  const blocked = shareRateLimited(c);
  if (blocked) return blocked;
  c.header("Cache-Control", "no-store");

  const rows = await db.select().from(apiKeys);
  const activeModels = await getActiveModelsCached(true);
  const activeIds = activeModels.map((m) => m.id);
  const samples = await loadShareSpeedSamples();
  const byKey = new Map<number, SpeedSample[]>();
  const allSamples: SpeedSample[] = [];
  for (const s of samples) {
    const sample: SpeedSample = {
      completionTokens: s.completionTokens,
      durationMs: s.durationMs,
      ttftMs: s.ttftMs,
    };
    allSamples.push(sample);
    if (s.apiKeyId != null) {
      const list = byKey.get(s.apiKeyId) || [];
      list.push(sample);
      byKey.set(s.apiKeyId, list);
    }
  }
  const boardSpeed = averageSpeedMetrics(allSamples);
  const keys = rows.map((row) =>
    shareKeyPublic(row, activeIds, averageSpeedMetrics(byKey.get(row.id) || [])),
  );
  return c.json({
    keys,
    baseUrl: "/v1",
    count: keys.length,
    // Concurrent in-flight chat completions (stream + non-stream), not "people".
    activeClients: getActiveClientRequests(),
    ttftMs: boardSpeed.ttftMs,
    tokensPerSecond: boardSpeed.tokensPerSecond,
    sampleSize: boardSpeed.sampleSize,
  });
});

/**
 * GET /v1/share — single friend-key status (optional deep link with Bearer/?key=).
 *
 * Authless-by-design for one presented managed key. Prefer /v1/share/board for
 * the public multi-key status page.
 */
proxyRouter.get("/v1/share", async (c) => {
  const blocked = shareRateLimited(c);
  if (blocked) return blocked;
  c.header("Cache-Control", "no-store");

  const token = c.req.query("key") || c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token) {
    return c.json({ error: { message: "Missing key", type: "auth_error" } }, 401);
  }
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.key, token)).limit(1);
  if (!row) {
    return c.json({ error: { message: "Invalid key", type: "auth_error" } }, 401);
  }

  const activeModels = await getActiveModelsCached(true);
  const samples = await loadShareSpeedSamples();
  const keySamples: SpeedSample[] = samples
    .filter((s) => s.apiKeyId === row.id)
    .map((s) => ({
      completionTokens: s.completionTokens,
      durationMs: s.durationMs,
      ttftMs: s.ttftMs,
    }));
  return c.json({
    ...shareKeyPublic(row, activeModels.map((m) => m.id), averageSpeedMetrics(keySamples)),
    activeClients: getActiveClientRequests(),
  });
});

/**
 * POST /v1/chat/completions - Chat completion (streaming + non-streaming)
 */
proxyRouter.post("/v1/chat/completions", async (c) => {
  let body: ChatCompletionRequest;
  try {
    body = await c.req.json<ChatCompletionRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json(openAIErrorResponse("Invalid JSON request body", 400), 400);
    }
    throw error;
  }

  // Validate request
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json(
      {
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      },
      400
    );
  }

  if (!body.model) {
    return c.json(
      {
        error: {
          message: "model is required",
          type: "invalid_request_error",
          code: "invalid_model",
        },
      },
      400
    );
  }

  body.model = normalizeModelId(body.model);
  // Normalize messages: convert any Anthropic-style content blocks
  // (tool_result, tool_use, image, thinking) into canonical OpenAI format.
  // This handles clients (Cline, Cursor, etc.) that send mixed-format
  // messages to the /v1/chat/completions endpoint.
  body = normalizeRequestToOpenAI(body);
  const isStream = body.stream === true;

  // Friend-key limits (quota/allowlist/rate) are enforced inside handleChatCompletion
  // so every completion route shares one gate.

  try {
    const { result } = await handleChatCompletion(body, {
      apiKeyId: currentApiKeyId(c.req.raw),
      request: c.req.raw,
    });

    if (isStream && result.stream) {
      // Return SSE stream
      return new Response(result.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Return JSON response
    return c.json(result.response);
  } catch (error) {
    if (error instanceof FriendKeyLimitError) {
      return friendKeyLimitResponse(c, error, "openai");
    }
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const mappedModel = resolveModelAlias(normalizeModelId(body.model));

    // Graceful 429: when every account was rate-limited, the router throws a
    // typed error carrying retryAfterMs. Map it to a real 429 + Retry-After so
    // well-behaved clients back off correctly instead of getting a 503.
    if (error && typeof error === "object" && (error as any).rateLimited === true) {
      const retryMs = (error as any).retryAfterMs ?? 60_000;
      return c.json(
        { error: { message: errorMessage, type: "rate_limit_error" } },
        429,
        { "Retry-After": String(Math.ceil(retryMs / 1000)) }
      );
    }

    // Log the error without masking the original proxy failure.
    const provider = pool.getProviderForModel(mappedModel) || "unknown";
    await logProxyError({
      provider,
      model: mappedModel,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody({ ...body, model: mappedModel, _poolprox: { originalModel: body.model } }),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    }, "chat completion error");

    broadcast({
      type: "request_error",
      data: { model: mappedModel, error: errorMessage },
    });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);

    // no provider owns this model (strict routing, no kiro catch-all).
    // Surface a clean 404 model_not_found so the client sees the
    // misconfiguration instead of a 503 proxy_error.
    if (errorMessage.startsWith("No provider found for model:")) {
      return c.json(
        {
          error: {
            message: `Model not found: ${mappedModel}. No provider owns this model id. Add it via the dashboard Models page or check the id.`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        404
      );
    }

    return c.json(
      {
        error: {
          message: errorMessage,
          type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "server_error",
          code: invalidModel ? "invalid_model" : badUpstreamRequest ? "invalid_request" : "proxy_error",
        },
      },
      invalidModel || badUpstreamRequest ? 400 : 503
    );
  }
});

/**
 * POST /v1/messages/count_tokens - Anthropic token-counting endpoint.
 *
 * Claude Code (and other Anthropic-compatible clients) call this before sending
 * a request to estimate input token usage. The body is the same shape as
 * /v1/messages (model, messages, system, tools, …). We convert it to the
 * internal Chat Completions shape and run the same token estimator the
 * compression pipeline uses, then return `{ input_tokens }`.
 *
 * The estimate is approximate (chars/4 heuristic) — it does NOT need to match
 * upstream exactly; clients use it for budgeting/UI only. Returning 404 makes
 * Claude Code log a noisy error on every turn, so we implement it even though
 * the proxy is otherwise stateless.
 */
proxyRouter.post("/v1/messages/count_tokens", async (c) => {
  let body: AnthropicMessagesRequest;
  try {
    body = await c.req.json<AnthropicMessagesRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON request body" } }, 400);
    }
    throw error;
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "messages is required and must be a non-empty array" } }, 400);
  }

  // Strip built-in server tools (e.g. web_search) the same way /v1/messages
  // does, so anthropicToOpenAI doesn't throw on them.
  const strippedBody: AnthropicMessagesRequest = { ...body, tools: stripWebSearchTools(body.tools) };

  let openAIRequest: ChatCompletionRequest;
  try {
    openAIRequest = anthropicToOpenAI(strippedBody);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ type: "error", error: { type: "invalid_request_error", message: msg } }, 400);
  }

  const inputTokens = estimateRequestTokens(openAIRequest);
  return c.json({ input_tokens: inputTokens });
});

/**
 * POST /v1/messages - Anthropic Messages-compatible endpoint
 */
proxyRouter.post("/v1/messages", async (c) => {
  let body: AnthropicMessagesRequest;
  try {
    body = await c.req.json<AnthropicMessagesRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON request body" } }, 400);
    }
    throw error;
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "messages is required and must be a non-empty array" } }, 400);
  }

  if (!body.model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  body.model = normalizeModelId(body.model);

  // Built-in web_search server tool — shim it locally via the agent loop
  // (open-source search backend) instead of rejecting. Other built-in tools
  // (code_execution, computer_use, …) still fail fast below.
  const webSearchConfig = extractWebSearchConfig(body.tools);
  if (webSearchConfig.present && config.webSearchEnabled) {
    // Strip the server tool so anthropicToOpenAI doesn't throw on it.
    const strippedBody: AnthropicMessagesRequest = { ...body, tools: stripWebSearchTools(body.tools) };
    let openAIRequest: ChatCompletionRequest;
    try {
      openAIRequest = anthropicToOpenAI(strippedBody);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ type: "error", error: { type: "invalid_request_error", message: msg } }, 400);
    }

    const hcOpts = { apiKeyId: currentApiKeyId(c.req.raw), request: c.req.raw };
    const runners = {
      runCompletion: async (req: ChatCompletionRequest) => {
        const { result } = await handleChatCompletion({ ...req, stream: false }, hcOpts);
        return { response: result.response };
      },
      runStream: async (req: ChatCompletionRequest) => {
        const { result } = await handleChatCompletion({ ...req, stream: true }, hcOpts);
        return { stream: result.stream! };
      },
    };

    try {
      if (body.stream === true) {
        const stream = runWebSearchLoopStreaming(body, openAIRequest, runners);
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }
      const response = await runWebSearchLoopNonStreaming(body, openAIRequest, runners);
      return c.json(response);
    } catch (error) {
      if (error instanceof FriendKeyLimitError) {
        return friendKeyLimitResponse(c, error, "anthropic");
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const mappedModel = resolveModelAlias(normalizeModelId(body.model));
      const provider = pool.getProviderForModel(mappedModel) || "unknown";
      await logProxyError({
        provider, model: mappedModel, status: "error", errorMessage,
        requestBody: prepareLogBody(body), responseBody: prepareLogBody({ error: errorMessage }),
        durationMs: 0,
      }, "messages web_search error");
      return c.json({
        type: "error",
        error: { type: "api_error", message: errorMessage },
      }, 503);
    }
  }

  let openAIRequest: ChatCompletionRequest;
  try {
    openAIRequest = anthropicToOpenAI(body);
  } catch (e) {
    // Other built-in Anthropic tools (code_execution, computer use, ...)
    // have no OpenAI equivalent and no local shim — fail fast with a clear
    // client error.
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({
      type: "error",
      error: { type: "invalid_request_error", message: msg },
    }, 400);
  }

  try {
    const { result } = await handleChatCompletion(openAIRequest, {
      apiKeyId: currentApiKeyId(c.req.raw),
      request: c.req.raw,
    });

    if (body.stream === true && result.stream) {
      return new Response(openAIStreamToAnthropic(result.stream, body), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return c.json(openAIToAnthropic(result.response, body));
  } catch (error) {
    if (error instanceof FriendKeyLimitError) {
      return friendKeyLimitResponse(c, error, "anthropic");
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const mappedModel = resolveModelAlias(normalizeModelId(body.model));
    const provider = pool.getProviderForModel(mappedModel) || "unknown";
    await logProxyError({
      provider,
      model: mappedModel,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody({ ...body, model: mappedModel, _poolprox: { originalModel: body.model } }),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    }, "messages error");

    broadcast({ type: "request_error", data: { model: mappedModel, error: errorMessage } });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);

    // no provider owns this model → 404 model_not_found (strict routing).
    if (errorMessage.startsWith("No provider found for model:")) {
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Model not found: ${mappedModel}. No provider owns this model id.`,
        },
      }, 404);
    }

    return c.json({
      type: "error",
      error: {
        type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "api_error",
        message: errorMessage,
      },
    }, invalidModel || badUpstreamRequest ? 400 : 503);
  }
});

/**
 * POST /v1/responses - OpenAI Responses API (streaming + non-streaming)
 *
 * Translates Responses-API requests to the internal Chat Completions pipeline
 * (same routeRequest/handleChatCompletion path used by /v1/chat/completions and
 * /v1/messages), then translates the result back to the Responses shape.
 *
 * Stateless: previous_response_id is accepted for compatibility but the proxy
 * keeps no server-side response store (store:false semantics). Multi-turn
 * clients replay prior output items in `input`.
 */
async function handleResponsesHttp(c: any) {
  let body: ResponsesApiRequest;
  try {
    body = await c.req.json<ResponsesApiRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON request body" } }, 400);
    }
    throw error;
  }

  if (body.input === undefined || body.input === null) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "input is required" } }, 400);
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "input must be a string or an array of input items" } }, 400);
  }
  if (!body.model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  body.model = normalizeModelId(body.model);

  let chatRequest: ChatCompletionRequest;
  try {
    chatRequest = responsesRequestToChat(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ type: "error", error: { type: "invalid_request_error", message: msg } }, 400);
  }

  const isStream = body.stream === true;

  const hcOpts = { apiKeyId: currentApiKeyId(c.req.raw), request: c.req.raw };
  try {
    if (isStream) {
      const { result } = await handleChatCompletion({ ...chatRequest, stream: true }, hcOpts);
      const meta = newResponsesResponseMeta();
      const stream = chatStreamToResponsesStream(result.stream!, chatRequest.model, meta.id, meta.createdAt);
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const { result } = await handleChatCompletion({ ...chatRequest, stream: false }, hcOpts);
    const response = chatResponseToResponses(result.response, chatRequest.model);
    return c.json(response);
  } catch (error) {
    if (error instanceof FriendKeyLimitError) {
      return friendKeyLimitResponse(c, error, "openai");
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const mappedModel = resolveModelAlias(normalizeModelId(body.model));
    const provider = pool.getProviderForModel(mappedModel) || "unknown";
    await logProxyError({
      provider,
      model: mappedModel,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody({ ...body, model: mappedModel, _poolprox: { originalModel: body.model } }),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    }, "responses error");

    broadcast({ type: "request_error", data: { model: mappedModel, error: errorMessage } });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);

    // no provider owns this model → 404 model_not_found (strict routing).
    if (errorMessage.startsWith("No provider found for model:")) {
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Model not found: ${mappedModel}. No provider owns this model id.`,
        },
      }, 404);
    }

    return c.json({
      type: "error",
      error: {
        type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "api_error",
        message: errorMessage,
      },
    }, invalidModel || badUpstreamRequest ? 400 : 503);
  }
}

/**
 * POST /v1/responses - OpenAI Responses API (streaming + non-streaming)
 * Also mounted at /backend-api/codex/responses for Codex CLI HTTP (non-WS).
 */
proxyRouter.post("/v1/responses", handleResponsesHttp);
proxyRouter.post("/backend-api/codex/responses", handleResponsesHttp);
