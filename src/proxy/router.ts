import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, type ProviderName } from "./providers/registry";
import { isNonAccountRequestError, isTransientError } from "./errors";
import { applyPudidilFilters } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import {
  compressRequest,
  getCompressionConfig,
  estimateRequestTokens,
  type CompressionStats,
} from "./compression";
import { applyHeadroom } from "./compression/headroom";
import { expandComboRequest, routeCombo } from "./combo";
import { detectRequiredCapabilities, stripUnsupportedCapabilities } from "./capabilities";
import { coordinatedRefresh, invalidateRefreshDedup } from "../auth/refresh-coordinator";
import { execute } from "./executor";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
  /** The request that was actually sent upstream (post-compression pipeline). */
  compressedRequest?: ChatCompletionRequest;
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 * Strips Claude Code identity, billing headers, and other patterns
 * that trigger content moderation on upstream providers.
 */
function sanitizeRequest(request: ChatCompletionRequest, providerName?: string): ChatCompletionRequest {
  void providerName;
  const sanitized = { ...request };

  sanitized.messages = request.messages.map((msg) => {
    // Normalize "developer" role → "system" (OpenAI's newer alias that
    // upstream providers like CodeWhisperer/CodeBuddy reject with HTTP 400).
    const role = (msg.role as string) === "developer" ? "system" : msg.role;
    if (typeof msg.content === "string") {
      return { ...msg, role, content: applyPudidilFilters(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        role,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text) }
                    : inner
                ),
              };
            }
          }
          return block;
        }),
      };
    }
    return { ...msg, role };
  });

  if (sanitized.tools) {
    sanitized.tools = request.tools!.map((tool: any) => {
      if (tool?.function?.description) {
        return {
          ...tool,
          function: {
            ...tool.function,
            description: applyPudidilFilters(tool.function.description),
          },
        };
      }
      return tool;
    });
  }

  return sanitized;
}

/**
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  // ── Combo expansion ──────────────────────────────────────────────────────────
  // If the model string looks like "combo-name/model-alias", expand it to a
  // multi-model fallback chain before routing.
  const comboExpansion = await expandComboRequest(request);
  if (comboExpansion?.expanded) {
    return routeCombo({
      request: comboExpansion.request,
      comboName: comboExpansion.comboName!,
      models: comboExpansion.models!,
    });
  }

  // Apply content filters to strip Claude Code identity, billing headers, etc.
  const providerName = pool.getProviderForModel(request.model);
  const sanitizedRequest = sanitizeRequest(request, providerName ?? undefined);

  // ── Capability detection & stripping ───────────────────────────────────────
  if (!providerName) {
    throw new Error(`No provider found for model: ${sanitizedRequest.model}`);
  }
  // If the request contains vision/pdf/audio content, strip it from models
  // that don't support it and add a placeholder note instead of letting the
  // provider reject it with a 400.
  const requiredCaps = detectRequiredCapabilities(sanitizedRequest.messages, sanitizedRequest.tools);
  if (requiredCaps.size > 0) {
    const stripped = stripUnsupportedCapabilities(sanitizedRequest.messages, providerName, sanitizedRequest.model);
    if (stripped.visionStripped || stripped.pdfStripped || stripped.audioStripped) {
      console.log(`[Capabilities] Stripped unsupported modalities for ${providerName}/${sanitizedRequest.model}:`, stripped);
    }
  }

  // Apply compression pipeline (RTK + DCP + Caveman + image dedupe + cache markers).
  // Failures here are non-fatal — fall back to the sanitized request and move on.
  let compressedRequest = sanitizedRequest;
  let compressionStats: CompressionStats | undefined;
  try {
    const cfg = await getCompressionConfig();
    // F11: Headroom LLM whole-message compression (async, fail-open). Runs
    // BEFORE the synchronous pipeline so the sync stages compress an already-
    // smaller conversation. Never blocks — on any error the original request
    // passes through to compressRequest unchanged.
    let headroomRequest = sanitizedRequest;
    let headroomSaved = 0;
    if (cfg.headroom.enabled) {
      const hr = await applyHeadroom(sanitizedRequest, cfg.headroom, estimateRequestTokens).catch(() => ({
        request: sanitizedRequest, saved: 0, applied: false,
      }));
      headroomRequest = hr.request;
      headroomSaved = hr.saved;
    }
    const out = compressRequest(headroomRequest, cfg, providerName);
    compressedRequest = out.request;
    compressionStats = out.stats;
    if (headroomSaved > 0) {
      compressionStats.byTechnique.headroom = headroomSaved;
      compressionStats.saved += headroomSaved;
      compressionStats.tokensAfter = Math.max(0, compressionStats.tokensAfter - headroomSaved);
      const before = compressionStats.tokensBefore;
      compressionStats.savedPct = before > 0 ? Math.round(((compressionStats.saved / before) * 10000)) / 100 : 0;
    }
  } catch (err) {
    console.error("[Compression] Failed, passing request through unchanged:", err);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Try up to 3 accounts before giving up
  const maxRetries = 3;
  let lastError = "";
  const attemptedByokAccountIds = new Set<number>();
  // Track rate-limit state across attempts so we can return a graceful 429
  // with Retry-After when EVERY account was rate-limited (vs. a 503 generic
  // failure). earliestReset lets us tell the client when to retry.
  let allRateLimited = true;
  let attemptsMade = 0;
  let earliestReset: Date | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // BYOK uses prefix-based account lookup (not the generic pool),
    // so it can also find error-status accounts and retry them.
    // For other providers, use model-aware routing to ensure account can query the model.
    const account = providerName === "byok"
      ? (await pool.getAccountForModel(compressedRequest.model, {
          excludeAccountIds: attemptedByokAccountIds,
        }))?.account ?? null
      : await pool.getNextAccountForModel(providerName, compressedRequest.model);
    if (!account) {
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }
    if (providerName === "byok") attemptedByokAccountIds.add(account.id);

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;
      // F12: dispatch through the shared executor (per-status retry + Codex
      // SSE-peek for 200-OK overload errors + uniform reclassification).
      const result = await execute({ provider, providerName, account, request: compressedRequest, stream });

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // If provider refreshed tokens internally, persist them to database
        if (result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        await pool.markUsed(account.id);
        return { result, account, provider: providerName, durationMs, compressionStats, compressedRequest };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      // Handle rate limiting (429) — temporary, don't mark exhausted.
      // Honor the upstream reset time if the provider surfaced it (resetsAt /
      // retryAfterMs), so we cool the account for the real window instead of
      // immediately retrying and re-hitting the 429.
      if (result.rateLimited) {
        lastError = result.error || "Rate limited";
        attemptsMade++;
        const resetHint = result.resetsAt
          ? { resetsAt: result.resetsAt }
          : result.retryAfterMs
            ? { retryAfterMs: result.retryAfterMs }
            : undefined;
        await pool.markRateLimited(account.id, lastError, resetHint);
        if (result.resetsAt && (!earliestReset || result.resetsAt < earliestReset)) {
          earliestReset = result.resetsAt;
        }
        continue; // Try next account
      }
      // A non-rate-limit failure means not ALL accounts were rate-limited.
      allRateLimited = false;

      // Handle quota exhaustion (402 / 403 without PAYG).
      //
      // For Alibaba: mark the specific model as exhausted (remove from queryableModels)
      // but keep the account active so other models can still be queried.
      // For other providers: mark the entire account as exhausted.
      if (result.quotaExhausted) {
        if (providerName === "alibaba") {
          // Alibaba: per-model exhaustion is already handled by the provider
          // (setModelQuotaToZero called in chatCompletion). Just invalidate
          // the pool cache so the next request picks a different account for
          // this model.
          pool.invalidate(providerName);
          lastError = result.error || "Quota exhausted for this model";
          continue;
        } else {
          await pool.markExhausted(account.id);
        }
        lastError = result.error || "Quota exhausted";
        continue; // Try next account
      }

      // Handle banned / restricted accounts (403 with code 11140 etc).
      // These accounts have valid credentials but are blocked by the upstream
      // from making chat requests. Mark as error immediately — no retry.
      if (result.banned) {
        await pool.markError(account.id, result.error || "Account banned or restricted");
        lastError = result.error || "Account banned or restricted";
        continue; // Try next account
      }

      // Handle token refresh for expired/401 errors.
      // F8: route through the refresh coordinator (dedup + per-account lock +
      // retry/backoff + unrecoverable-error classification) so concurrent 401s
      // on the same account coalesce instead of racing on token rotation.
      if (
        result.error?.includes("expired") ||
        result.error?.includes("401")
      ) {
        const refreshResult = await coordinatedRefresh(provider, account);
        if (refreshResult.success && refreshResult.tokens) {
          // tokens is already parsed (object) from the coordinator.
          await pool.updateTokens(account.id, refreshResult.tokens);
          invalidateRefreshDedup(account, providerName);
          // Retry with same account after refresh
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = await execute({ provider, providerName, account, request: compressedRequest, stream });

          if (retryResult.success) {
            await pool.markUsed(account.id);
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
              compressionStats,
              compressedRequest,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
          // Refresh succeeded but retry failed — treat as transient (token
          // might work on next request after propagation).
          await pool.markTransientFailure(account.id, result.error || "Auth failed");
        } else {
          // F8: unrecoverable refresh errors (invalid_grant / reused refresh
          // token) mean the credential is permanently dead → disable account.
          if (refreshResult.unrecoverable) {
            await pool.markError(account.id, refreshResult.error || "Token unrecoverable — re-login required");
          } else {
            // Provider doesn't support token refresh (e.g. codebuddy,
            // codebuddy-china, canva use static keys / browser cookies).
            // "Session expired" means the credential is genuinely dead —
            // mark as error so the account is excluded from the pool and
            // only reinstated after a manual re-login or warmup confirms
            // it's healthy again. Keeping it "active" would cause every
            // subsequent request to hit the same dead account.
            const refreshErrorMsg = refreshResult.error || "";
            const noRefresh = refreshErrorMsg.includes("re-login") ||
              refreshErrorMsg.includes("no refresh") ||
              refreshErrorMsg.includes("static") ||
              refreshErrorMsg.includes("browser");
            if (noRefresh) {
              await pool.markError(account.id, result.error || "Session expired — re-login required");
            } else {
              await pool.markTransientFailure(account.id, result.error || "Auth failed");
            }
          }
        }
        lastError = result.error || "Auth failed";
        continue;
      }

      // Generic error - check if transient (network/timeout) or permanent
      // For Alibaba: model-specific errors (quota, unpurchased) should not
      // mark the entire account as error - just skip this model.
      if (isTransientError(result.error || "")) {
        await pool.markTransientFailure(account.id, result.error || "Transient error");
      } else if (providerName === "alibaba" && (
        result.error?.includes("not activated") ||
        result.error?.includes("not purchased") ||
        result.error?.includes("Free quota exhausted") ||
        result.error?.includes("quota has been exhausted")
      )) {
        // Alibaba model-specific error: invalidate pool but don't mark account as error
        pool.invalidate(providerName);
      } else {
        await pool.markError(account.id, result.error || "Unknown error");
      }
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      if (errMsg.includes("expired") || errMsg.includes("401")) {
        // Check if this provider supports token refresh. If not, mark as
        // error so the dead account is excluded from the pool.
        const refreshCheck = await provider.refreshToken(account);
        const noRefresh = !refreshCheck.success && (
          refreshCheck.error?.includes("re-login") ||
          refreshCheck.error?.includes("no refresh") ||
          refreshCheck.error?.includes("static") ||
          refreshCheck.error?.includes("browser")
        );
        if (noRefresh) {
          await pool.markError(account.id, errMsg);
        } else {
          await pool.markTransientFailure(account.id, errMsg);
        }
      } else if (isTransientError(errMsg)) {
        await pool.markTransientFailure(account.id, errMsg);
      } else {
        await pool.markError(account.id, errMsg);
      }
      lastError = errMsg;
    }
  }

  // Graceful "all rate-limited" path: if every attempt was a 429 (and at least
  // one attempt was made), surface a rate-limit error carrying the earliest
  // reset time so the proxy layer can return 429 + Retry-After instead of a
  // generic 503. This lets well-behaved clients back off correctly.
  if (allRateLimited && attemptsMade > 0) {
    const resetMs = earliestReset ? Math.max(0, earliestReset.getTime() - Date.now()) : 60_000;
    const err = new Error(
      `All ${providerName} accounts rate-limited. Retry in ${Math.ceil(resetMs / 1000)}s.`
    ) as Error & { rateLimited?: true; retryAfterMs?: number };
    err.rateLimited = true;
    err.retryAfterMs = resetMs;
    throw err;
  }

  throw new Error(
    `All accounts failed for ${providerName}. Last error: ${lastError}`
  );
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
