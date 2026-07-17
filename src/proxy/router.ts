import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, resolveProviderInstance, type ProviderName } from "./providers/registry";
import {
  isNonAccountRequestError,
  isTransientError,
  isHardConnectFailure,
  isAccessDeniedForbidden,
  isCloudflareChallenge,
} from "./errors";
import { applyPudidilFilters } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import { requestLogs } from "../db/schema";
import { db } from "../db/index";
import { eq } from "drizzle-orm";
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
  stream: boolean,
  options?: {
    /** Account ids to skip on every attempt (e.g. combo cross-model exclusion). */
    excludeAccountIds?: Set<number>;
    /** Prefer this account on the first attempt (combo sticky pinning). */
    preferredAccountId?: number;
    /** Internal re-entry guard: combo/fusion expansions must not re-expand. */
    _skipComboExpansion?: boolean;
  }
): Promise<RouteResult> {
  // ── Combo expansion ──────────────────────────────────────────────────────────
  // If the model string looks like "combo-name/model-alias", expand it to a
  // multi-model fallback chain before routing.
  const comboExpansion = options?._skipComboExpansion ? null : await expandComboRequest(request);
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
    // Headroom LLM whole-message compression (async, fail-open). Runs
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

  // Static providers map + dynamic compatible-node instances.
  const provider = resolveProviderInstance(providerName);
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Try up to 3 accounts before giving up
  const maxRetries = 3;
  let lastError = "";
  // Exclude every attempted account id (all providers) so exhaustion/rate-limit
  // retries never re-select the same dead credential for another full upstream hop.
  const attemptedAccountIds = new Set<number>();
  // Seed with caller-supplied exclusions (combo cross-model exclusion set) so a
  // credential that already failed on an earlier combo model is never re-picked
  // mid-request. The in-request set below still accumulates per-attempt ids.
  if (options?.excludeAccountIds) {
    for (const id of options.excludeAccountIds) attemptedAccountIds.add(id);
  }

  // Sticky response-id pinning: if the request carries a previous_response_id,
  // resolve which account created that response and prefer it on the first
  // attempt. Preserves Codex/OpenAI-Responses session continuity.
  let preferredAccountId: number | undefined = options?.preferredAccountId;
  const prevResponseId = (request as any)?.previous_response_id;
  if (prevResponseId) {
    try {
      const row = await db.select({ accountId: requestLogs.accountId })
        .from(requestLogs)
        .where(eq(requestLogs.responseId, String(prevResponseId)))
        .limit(1);
      if (row[0]?.accountId) preferredAccountId = row[0].accountId;
    } catch { /* lookup best-effort */ }
  }
  // Track rate-limit state across attempts so we can return a graceful 429
  // with Retry-After when EVERY account was rate-limited (vs. a 503 generic
  // failure). earliestReset lets us tell the client when to retry.
  let allRateLimited = true;
  let attemptsMade = 0;
  let earliestReset: Date | null = null;
  // Provider-host is dead (connection refused / upstream connect) — do not walk
  // the whole fleet with multi-second TCP timeouts on every account.
  let hardConnectFailures = 0;
  const MAX_HARD_CONNECT_ACCOUNT_ATTEMPTS = 2;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // BYOK uses prefix-based account lookup (not the generic pool),
    // so it can also find error-status accounts and retry them.
    // For other providers, use model-aware routing with the same exclude set
    // so depleted / just-failed accounts are not re-hit inside this request.
    let account = providerName === "byok"
      ? (await pool.getAccountForModel(compressedRequest.model, {
          excludeAccountIds: attemptedAccountIds,
          preferredAccountId: attempt === 0 ? preferredAccountId : undefined,
        }))?.account ?? null
      : await pool.getNextAccountForModel(providerName, compressedRequest.model, {
          excludeAccountIds: attemptedAccountIds,
          preferredAccountId: attempt === 0 ? preferredAccountId : undefined,
        });

    // Compatible-node static credentials: when no accounts.provider=<node.id>
    // row exists, fall back to the node-level apiKey bound on the provider.
    if (!account && typeof (provider as any).getStaticAccount === "function") {
      account = (provider as any).getStaticAccount() ?? null;
    }

    if (!account) {
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }
    if (account.id > 0) attemptedAccountIds.add(account.id);

    const startTime = Date.now();
    // For a successful STREAMING result we hand the live stream back to the
    // caller (index.ts), whose wrapStreamWithUsageFinalizer releases in-flight
    // tracking when the stream ends. We must NOT release here in that case —
    // doing so zeroed the count during streaming, making the load balancer
    // pile concurrent streams onto one account. `handedStreamToCaller` marks
    // that path so the finally skips the release.
    let handedStreamToCaller = false;

    // Synthetic static-node accounts use id=0 and must not touch pool state.
    const isStaticAccount = !account.id || account.id <= 0;

    try {
      if (!isStaticAccount) pool.trackRequestStart(account.id);
      // dispatch through the shared executor (per-status retry + Codex
      // SSE-peek for 200-OK overload errors + uniform reclassification).
      const result = await execute({ provider, providerName, account, request: compressedRequest, stream });

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // If provider refreshed tokens internally, persist them to database
        if (!isStaticAccount && result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        if (!isStaticAccount) await pool.markUsed(account.id, providerName);
        // Successful stream: the caller owns the in-flight tracking now.
        if (stream && result.stream) handedStreamToCaller = true;
        return { result, account, provider: providerName, durationMs, compressionStats, compressedRequest };
      }

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      // Credit/quota exhaustion outranks bare rateLimited. Grok/xAI often
      // returns HTTP 429 + free-usage-exhausted; providers should set
      // quotaExhausted, but re-check the error text so a mis-flagged
      // rateLimited never parks a dead account in a 60s cooldown loop.
      const errText = result.error || "";
      const looksExhausted =
        result.quotaExhausted === true ||
        /free-usage-exhausted|spending[-_]?limit|quota_exhausted|you've used all|you have used all|payment required|insufficient credit|out of credits|no remaining credits/i.test(
          errText,
        );

      if (looksExhausted) {
        allRateLimited = false;
        if (providerName === "alibaba") {
          // Alibaba: per-model exhaustion is already handled by the provider
          // (setModelQuotaToZero called in chatCompletion). Just invalidate
          // the pool cache so the next request picks a different account for
          // this model.
          pool.invalidate(providerName);
          lastError = errText || "Quota exhausted for this model";
          continue;
        }
        if (!isStaticAccount) await pool.markExhausted(account.id);
        lastError = errText || "Quota exhausted";
        continue; // Try next account — exhausted accounts are excluded from selection
      }

      // Handle rate limiting (429) — temporary, don't mark exhausted.
      // Honor the upstream reset time if the provider surfaced it (resetsAt /
      // retryAfterMs), so we cool the account for the real window instead of
      // immediately retrying and re-hitting the 429.
      if (result.rateLimited) {
        lastError = errText || "Rate limited";
        attemptsMade++;
        const resetHint = result.resetsAt
          ? { resetsAt: result.resetsAt }
          : result.retryAfterMs
            ? { retryAfterMs: result.retryAfterMs }
            : undefined;
        if (!isStaticAccount) await pool.markRateLimited(account.id, lastError, resetHint);
        if (result.resetsAt && (!earliestReset || result.resetsAt < earliestReset)) {
          earliestReset = result.resetsAt;
        }
        // Static-node providers (id<=0, single apiKey credential) can't be marked
        // in the pool and the exclusion set is ignored for them, so the next
        // attempt would re-hit the SAME node instantly — 3 immediate 429s with no
        // cooldown. Back off briefly before the final retry. Capped at 1.5s so the
        // request stays well inside the proxy's 10s frontend-timeout budget.
        if (isStaticAccount && attempt < maxRetries - 1) {
          const waitMs = Math.min(result.retryAfterMs ?? 1500, 1500);
          await new Promise((r) => setTimeout(r, waitMs));
        }
        continue; // Try next account
      }
      // A non-rate-limit failure means not ALL accounts were rate-limited.
      allRateLimited = false;

      // Handle banned / restricted / Access denied accounts.
      // These credentials are blocked for chat (not an auth-refresh issue).
      // Terminal mark so they leave the active pool immediately — hysteresis
      // would leave them selectable and stall every request for 3 full hops.
      // Cloudflare anti-bot challenge on the ChatGPT mirror: the credential is
      // fine, the IP is gated. Terminal-mark so the account leaves the pool
      // instead of being retried as a refreshable 401 / transient blip.
      if (result.banned || isAccessDeniedForbidden(errText) || isCloudflareChallenge(errText)) {
        if (!isStaticAccount) {
          await pool.markError(
            account.id,
            result.error || errText || "Account banned or restricted",
            { terminal: true },
          );
        }
        lastError = result.error || errText || "Account banned or restricted";
        allRateLimited = false;
        continue; // Try next account (excluded via attemptedAccountIds)
      }

      // Hard connect failure (503 connection refused / upstream connect) —
      // same host for all Grok OAuth accounts. One failover attempt, then stop.
      if (isHardConnectFailure(errText)) {
        allRateLimited = false;
        hardConnectFailures++;
        if (!isStaticAccount) {
          await pool.markTransientFailure(account.id, errText);
        }
        lastError = errText;
        if (hardConnectFailures >= MAX_HARD_CONNECT_ACCOUNT_ATTEMPTS) {
          break;
        }
        continue;
      }

      // Handle token refresh for expired/401 errors.
      // route through the refresh coordinator (dedup + per-account lock +
      // retry/backoff + unrecoverable-error classification) so concurrent 401s
      // on the same account coalesce instead of racing on token rotation.
      if (
        !isStaticAccount &&
        (result.error?.includes("expired") ||
        result.error?.includes("401"))
      ) {
        const refreshResult = await coordinatedRefresh(provider, account);
        if (refreshResult.success && refreshResult.tokens) {
          // tokens is already parsed (object) from the coordinator.
          await pool.updateTokens(account.id, refreshResult.tokens);
          invalidateRefreshDedup(account, providerName);
          // Retry with same account after refresh
          try {
            pool.trackRequestStart(account.id);
            const retryResult = await execute({ provider, providerName, account, request: compressedRequest, stream });

            if (retryResult.success) {
              await pool.markUsed(account.id, providerName);
              return {
                result: retryResult,
                account,
                provider: providerName,
                durationMs: Date.now() - startTime,
                compressionStats,
                compressedRequest,
              };
            }
          } finally {
            pool.trackRequestEnd(account.id);
          }
          // Refresh succeeded but retry failed — treat as transient (token
          // might work on next request after propagation).
          await pool.markTransientFailure(account.id, result.error || "Auth failed");
        } else {
          // unrecoverable refresh errors (invalid_grant / reused refresh
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
      if (!isStaticAccount) {
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
      }
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      if (!isStaticAccount && (errMsg.includes("expired") || errMsg.includes("401"))) {
        // route through the refresh coordinator (NOT direct
        // provider.refreshToken) so the per-account lock prevents concurrent
        // rotations, and the rotated token is persisted. Calling
        // provider.refreshToken directly here would (a) race the try-block's
        // coordinatedRefresh on the same account and (b) discard the rotated
        // refresh token (never persisted) → account permanently bricked for
        // providers with rotating refresh tokens (grok OAuth, kiro-pro, codex).
        const refreshResult = await coordinatedRefresh(provider, account);
        if (refreshResult.success && refreshResult.tokens) {
          await pool.updateTokens(account.id, refreshResult.tokens);
          invalidateRefreshDedup(account, providerName);
          // Token rotated successfully — account is healthy again. Mark
          // transient so it stays in the pool for the next request (the
          // try-block path handles the immediate retry for non-thrown errors).
          await pool.markTransientFailure(account.id, errMsg);
        } else {
          const refreshErrorMsg = refreshResult.error || "";
          const noRefresh = !refreshResult.success && (
            refreshErrorMsg.includes("re-login") ||
            refreshErrorMsg.includes("no refresh") ||
            refreshErrorMsg.includes("static") ||
            refreshErrorMsg.includes("browser")
          );
          // Unrecoverable (invalid_grant / revoked refresh token) OR
          // static-key providers whose credential is genuinely dead.
          if (noRefresh || refreshResult.unrecoverable) {
            await pool.markError(account.id, errMsg);
          } else {
            await pool.markTransientFailure(account.id, errMsg);
          }
        }
      } else if (!isStaticAccount && isTransientError(errMsg)) {
        await pool.markTransientFailure(account.id, errMsg);
      } else if (!isStaticAccount) {
        await pool.markError(account.id, errMsg);
      }
      lastError = errMsg;
    } finally {
      // Only release here when we did NOT hand the stream to the caller.
      // (Successful streams are released by the stream finalizer in index.ts.)
      // Static node accounts (id<=0) never entered trackRequestStart.
      if (!isStaticAccount && !handedStreamToCaller) pool.trackRequestEnd(account.id);
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
