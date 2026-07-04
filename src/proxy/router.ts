import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, type ProviderName } from "./providers/registry";
import { isNonAccountRequestError, isTransientError } from "./errors";
import { applyPudidilFilters, type FilterScope } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import {
  compressRequest,
  getCompressionConfig,
  type CompressionStats,
} from "./compression";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
}

/** Check if a request contains image content blocks */
function requestHasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as any[]).some(
      (block) => block?.type === "image_url" || block?.type === "image"
    );
  });
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 * Strips Claude Code identity, billing headers, and other patterns
 * that trigger content moderation on upstream providers.
 */
const IDENTITY_FILTER_PROVIDERS = new Set(["codebuddy", "codebuddy-china", "alibaba"]);

function sanitizeRequest(request: ChatCompletionRequest, providerName?: string): ChatCompletionRequest {
  const sanitized = { ...request };
  const scope: FilterScope = providerName && IDENTITY_FILTER_PROVIDERS.has(providerName) ? undefined : "structural";

  sanitized.messages = request.messages.map((msg) => {
    // Normalize "developer" role → "system" (OpenAI's newer alias that
    // upstream providers like CodeWhisperer/CodeBuddy reject with HTTP 400).
    const role = (msg.role as string) === "developer" ? "system" : msg.role;
    if (typeof msg.content === "string") {
      return { ...msg, role, content: applyPudidilFilters(msg.content, scope) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        role,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text, scope) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content, scope) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text, scope) }
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
            description: applyPudidilFilters(tool.function.description, scope),
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
  // Apply content filters to strip Claude Code identity, billing headers, etc.
  const providerName = pool.getProviderForModel(request.model);
  const sanitizedRequest = sanitizeRequest(request, providerName ?? undefined);

  const hasImages = requestHasImages(sanitizedRequest);
  if (!providerName) {
    throw new Error(`No provider found for model: ${sanitizedRequest.model}`);
  }

  // Apply compression pipeline (RTK + DCP + Caveman + image dedupe + cache markers).
  // Failures here are non-fatal — fall back to the sanitized request and move on.
  let compressedRequest = sanitizedRequest;
  let compressionStats: CompressionStats | undefined;
  try {
    const cfg = await getCompressionConfig();
    const out = compressRequest(sanitizedRequest, cfg, providerName);
    compressedRequest = out.request;
    compressionStats = out.stats;
  } catch (err) {
    console.error("[Compression] Failed, passing request through unchanged:", err);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Reject image requests for models that don't support vision
  if (hasImages) {
    const modelInfo = provider.getModelInfo(sanitizedRequest.model);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${sanitizedRequest.model}" does not support image/vision inputs. Use a vision-capable model instead.`
      );
    }
  }

  // Try up to 3 accounts before giving up
  const maxRetries = 3;
  let lastError = "";
  const attemptedByokAccountIds = new Set<number>();

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
      const result = stream
        ? await provider.chatCompletionStream(account, compressedRequest)
        : await provider.chatCompletion(account, compressedRequest);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // If provider refreshed tokens internally, persist them to database
        if (result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        await pool.markUsed(account.id);
        return { result, account, provider: providerName, durationMs, compressionStats };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      // Handle rate limiting (429) — temporary, don't mark exhausted
      if (result.rateLimited) {
        lastError = result.error || "Rate limited";
        continue; // Try next account without poisoning this one
      }

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

      // Handle token refresh for expired/401 errors
      if (
        result.error?.includes("expired") ||
        result.error?.includes("401")
      ) {
        const refreshResult = await provider.refreshToken(account);
        if (refreshResult.success && refreshResult.tokens) {
          // Parse tokens string to store as jsonb
          let parsedTokens: unknown;
          try {
            parsedTokens = JSON.parse(refreshResult.tokens);
          } catch {
            parsedTokens = refreshResult.tokens;
          }
          await pool.updateTokens(account.id, parsedTokens);
          // Retry with same account after refresh
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = stream
            ? await provider.chatCompletionStream(account, compressedRequest)
            : await provider.chatCompletion(account, compressedRequest);

          if (retryResult.success) {
            await pool.markUsed(account.id);
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
              compressionStats,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
          // Refresh succeeded but retry failed — treat as transient (token
          // might work on next request after propagation).
          await pool.markTransientFailure(account.id, result.error || "Auth failed");
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

  throw new Error(
    `All accounts failed for ${providerName}. Last error: ${lastError}`
  );
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
