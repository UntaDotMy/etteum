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
import { getRetryBudget } from "./retry-config";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
  /** The request that was actually sent upstream (post-compression pipeline). */
  compressedRequest?: ChatCompletionRequest;
}

// ── Pool-exhaustion (typed 429) ─────────────────────────────────────────────
/**
 * Quota-exhaustion walk budget. Exhaustion hops are "free" — they do not
 * consume the account-attempt budget — because a quota 429 comes back fast
 * and the alternative is failing the request while healthy accounts sit
 * untried. Still bounded by hop count AND wall-clock so a whole fleet of
 * dead accounts cannot stall the client past the frontend timeout.
 */
const MAX_EXHAUSTION_HOPS = Math.max(
  1,
  Number(process.env.POOLPROX_MAX_EXHAUSTION_HOPS) || 25,
);
const EXHAUSTION_WALK_MS = Math.max(
  1_000,
  Number(process.env.POOLPROX_EXHAUSTION_WALK_MS) || 6_000,
);
/** xAI free usage resets over a rolling 24-hour window (per the 429 body). */
const GROK_FREE_USAGE_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default Retry-After when no reset hint exists: matches the exhausted-probe
 * re-check cadence so a retry lands after the pool had a chance to revive. */
const DEFAULT_EXHAUSTED_RETRY_AFTER_MS = 15 * 60_000;

export interface PoolExhaustedError extends Error {
  quotaExhausted: true;
  retryAfterMs: number;
  /** Raw upstream detail — written to request_logs, NEVER sent to the client. */
  rawDetail?: string;
}

function formatRetryAfter(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m}m`;
  return `${Math.ceil(m / 60)}h`;
}

/**
 * Build the typed "all accounts quota-exhausted" error. The client-facing
 * message carries provider + count + retry hint ONLY — upstream JSON blobs
 * go to rawDetail for request_logs.
 */
export function buildPoolExhaustedError(args: {
  providerName: string;
  exhaustedCount?: number | null;
  resetAt?: Date | null;
  rawDetail?: string;
}): PoolExhaustedError {
  const nowMs = Date.now();
  const retryAfterMs =
    args.resetAt && args.resetAt.getTime() > nowMs
      ? args.resetAt.getTime() - nowMs
      : DEFAULT_EXHAUSTED_RETRY_AFTER_MS;
  const count =
    args.exhaustedCount && args.exhaustedCount > 0 ? `${args.exhaustedCount} ` : "";
  const err = new Error(
    `All ${count}${args.providerName} accounts are quota-exhausted. Retry in ~${formatRetryAfter(retryAfterMs)}.`,
  ) as PoolExhaustedError;
  err.quotaExhausted = true;
  err.retryAfterMs = retryAfterMs;
  if (args.rawDetail) err.rawDetail = args.rawDetail;
  return err;
}

/**
 * Tool/tool_choice consistency for every client family. Anthropic clients
 * (Claude Code), OpenAI clients (OpenCode/Cline), and Responses clients
 * (Codex) can all send `tool_choice` with no tools attached — tolerant
 * upstreams ignore it, strict ones (xAI cli-chat-proxy) reject the whole
 * request: "A tool_choice was set on the request but no tools were specified."
 * The web_search server-tool strip (agent-loop) can also empty the tools list
 * while tool_choice survives the Anthropic→OpenAI conversion. Normalize once
 * here so every provider benefits:
 *   - no tools → drop tool_choice + parallel_tool_calls (nothing to choose);
 *   - tool_choice naming a tool that isn't in the list → degrade to "auto"
 *     (a specific-but-missing choice 400s the same way on strict upstreams).
 */
export function normalizeToolChoiceConsistency(
  request: ChatCompletionRequest,
): ChatCompletionRequest {
  const tools = Array.isArray(request.tools) ? request.tools.filter(Boolean) : [];
  if (tools.length === 0) {
    if (
      (request as any).tool_choice === undefined &&
      (request as any).parallel_tool_calls === undefined
    ) {
      return request;
    }
    const { tool_choice: _tc, parallel_tool_calls: _ptc, ...rest } = request as any;
    return rest;
  }
  const tc = (request as any).tool_choice;
  if (tc && typeof tc === "object") {
    const named = tc.type === "function" ? tc.function?.name : undefined;
    if (typeof named === "string" && named) {
      const names = new Set(
        tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean),
      );
      if (!names.has(named)) {
        return { ...request, tool_choice: "auto" };
      }
    }
  }
  return request;
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

  // Tool/tool_choice consistency last — after every text mutation above.
  return normalizeToolChoiceConsistency(sanitized);
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
    /**
     * Optional out-param: every account id actually attempted is added to this
     * set (in addition to the internal copy). Lets combo exclude the account
     * that genuinely failed — not the liveness probe — on the next model.
     */
    attemptedAccountIdsOut?: Set<number>;
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
    // The routed model's own ModelInfo (model-specs.ts) is the precise source of
    // truth; the provider table is only the fallback for models that declare none.
    const modelInfo = resolveProviderInstance(providerName)?.getModelInfo(sanitizedRequest.model);
    const stripped = stripUnsupportedCapabilities(
      sanitizedRequest.messages,
      providerName,
      sanitizedRequest.model,
      { vision: modelInfo?.vision },
    );
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

  // Try up to N accounts before giving up. N is the retry budget's
  // accountAttempts (dashboard-tunable, default 3).
  const retryBudget = await getRetryBudget();
  const maxRetries = retryBudget.accountAttempts;
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
  // Exhaustion walk state: quota-exhausted accounts are rotated through as
  // FREE hops (attempt is not incremented) so a request never fails while an
  // untried account exists — bounded by hop count + wall-clock deadline.
  let exhaustionHops = 0;
  let sawExhaustion = false;
  let earliestExhaustedReset: Date | null = null;
  const exhaustionWalkDeadline = Date.now() + EXHAUSTION_WALK_MS;
  // Anything that is neither rate-limit nor quota-exhaustion (banned, auth,
  // transient, unknown) — keeps the typed-429 responses pure.
  let sawOtherFailure = false;
  // Provider-host is dead (connection refused / upstream connect) — do not walk
  // the whole fleet with multi-second TCP timeouts on every account.
  let hardConnectFailures = 0;
  const MAX_HARD_CONNECT_ACCOUNT_ATTEMPTS = 2;

  // `attempt` counts hops that consume the retry budget; quota-exhaustion
  // hops are free (see above) so the loop is manual-increment, not a for.
  let attempt = 0;
  while (attempt < maxRetries) {
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
      // Distinguish "pool empty because everything is exhausted" (typed 429 +
      // Retry-After) from "nothing configured/active" (actionable 503).
      const dep = await pool.getPoolDepletion(providerName).catch(() => null);
      if (dep && dep.enabled > 0 && (dep.exhausted > 0 || sawExhaustion)) {
        throw buildPoolExhaustedError({
          providerName,
          exhaustedCount: Math.max(dep.exhausted, exhaustionHops) || null,
          resetAt: earliestExhaustedReset ?? dep.earliestResetAt,
          rawDetail: lastError || undefined,
        });
      }
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }
    if (account.id > 0) {
      attemptedAccountIds.add(account.id);
      options?.attemptedAccountIdsOut?.add(account.id);
    }

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
      // Smarter retry (H5): when ANOTHER account is available for this model,
      // don't burn same-account retries re-hitting a degraded credential —
      // rotate to the fresh account instead (maxRetries: 0 → single hop here).
      // When this is the last account left, keep the full same-account budget.
      const moreAccountsAvailable = attempt < maxRetries - 1;
      const innerRetries = moreAccountsAvailable ? 0 : retryBudget.innerRetries;
      // dispatch through the shared executor (per-status retry + Codex
      // SSE-peek for 200-OK overload errors + uniform reclassification).
      const result = await execute({
        provider, providerName, account, request: compressedRequest, stream,
        maxRetries: innerRetries,
      });

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // If provider refreshed tokens internally, persist them to database
        if (!isStaticAccount && result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        if (!isStaticAccount) await pool.markUsed(account.id, providerName);
        // Self-heal: an `error`-status row served via the error fallback
        // succeeded — clear the error so it returns to the active pool
        // immediately (no waiting for the next warmup tick).
        if (!isStaticAccount && account.status === "error") {
          await pool.clearError(account.id);
        }
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
        sawExhaustion = true;
        // Reset hint drives both the typed 429's Retry-After and the row's
        // self-revive timestamp. Grok's 429 body states a rolling 24h window
        // and gives no timestamp, so default to it; other providers only get
        // a hint when they surfaced resetsAt themselves.
        const resetHint =
          result.resetsAt ??
          (providerName === "grok"
            ? new Date(Date.now() + GROK_FREE_USAGE_ROLLING_WINDOW_MS)
            : null);
        if (resetHint && (!earliestExhaustedReset || resetHint < earliestExhaustedReset)) {
          earliestExhaustedReset = resetHint;
        }
        if (providerName === "alibaba") {
          // Alibaba: per-model exhaustion is already handled by the provider
          // (setModelQuotaToZero called in chatCompletion). Just invalidate
          // the pool cache so the next request picks a different account for
          // this model.
          pool.invalidate(providerName);
          lastError = errText || "Quota exhausted for this model";
        } else {
          if (!isStaticAccount) {
            await pool.markExhausted(account.id, { resetAt: resetHint });
          }
          lastError = errText || "Quota exhausted";
        }
        // FREE hop: do not increment `attempt` — rotate through every
        // dispatch-eligible account once rather than failing while untried
        // accounts exist. Bounded so a dead fleet can't stall the client.
        // Static single-credential nodes can't rotate — the exclusion set is
        // ignored for them, so a free hop would re-hit the same key; count it.
        exhaustionHops++;
        if (isStaticAccount) attempt++;
        if (exhaustionHops >= MAX_EXHAUSTION_HOPS || Date.now() >= exhaustionWalkDeadline) {
          break;
        }
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
        attempt++;
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
        sawOtherFailure = true;
        attempt++;
        continue; // Try next account (excluded via attemptedAccountIds)
      }

      // Hard connect failure (503 connection refused / upstream connect) —
      // same host for all Grok OAuth accounts. One failover attempt, then stop.
      if (isHardConnectFailure(errText)) {
        allRateLimited = false;
        sawOtherFailure = true;
        hardConnectFailures++;
        if (!isStaticAccount) {
          await pool.markTransientFailure(account.id, errText);
        }
        lastError = errText;
        if (hardConnectFailures >= MAX_HARD_CONNECT_ACCOUNT_ATTEMPTS) {
          break;
        }
        attempt++;
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
              // Same hand-off contract as the primary success path: without it
              // the outer finally also released and in-flight read 0 mid-stream.
              if (stream && retryResult.stream) handedStreamToCaller = true;
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
            // Releases only the inner attempt's start; the outer start is
            // released by the outer finally (or by the stream finalizer).
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
        sawOtherFailure = true;
        attempt++;
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
      sawOtherFailure = true;
      attempt++;
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
      sawOtherFailure = true;
      attempt++;
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
  if (allRateLimited && attemptsMade > 0 && !sawExhaustion && !sawOtherFailure) {
    const resetMs = earliestReset ? Math.max(0, earliestReset.getTime() - Date.now()) : 60_000;
    const err = new Error(
      `All ${providerName} accounts rate-limited. Retry in ${Math.ceil(resetMs / 1000)}s.`
    ) as Error & { rateLimited?: true; retryAfterMs?: number };
    err.rateLimited = true;
    err.retryAfterMs = resetMs;
    throw err;
  }

  // Typed "all quota-exhausted" path: every failure was exhaustion (pure), or
  // exhaustion mixed with rate-limits (still client-retryable). Either way the
  // client gets a clean 429 + Retry-After — never the raw upstream JSON blob.
  if (sawExhaustion && !sawOtherFailure) {
    const resetCandidates = [earliestExhaustedReset, earliestReset].filter(
      (d): d is Date => d instanceof Date,
    );
    const earliest =
      resetCandidates.length > 0
        ? new Date(Math.min(...resetCandidates.map((d) => d.getTime())))
        : null;
    throw buildPoolExhaustedError({
      providerName,
      exhaustedCount: exhaustionHops || null,
      resetAt: earliest,
      rawDetail: lastError || undefined,
    });
  }

  throw new Error(
    `All accounts failed for ${providerName}. Last error: ${lastError}`
  );
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
