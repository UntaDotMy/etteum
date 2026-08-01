import type { Hono } from "hono";
import { db } from "../../db/index";
import { accounts, requestLogs, vccCards, vccTransactions, settings } from "../../db/schema";
import { eq, inArray, and, sql, desc, ne, or, like, gte, lte, isNull, not, asc, count } from "drizzle-orm";
import { encrypt, decrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";
import { adminGuardFromPeer, peerIpFromHonoContext, RateLimiter } from "../../utils/security";
import type { NewAccount, Account } from "../../db/schema";
import { loginQueue } from "../../auth/queue";
import { warmupQueue } from "../../auth/warmup-queue";
import { warmupAccount } from "../../auth/warmup-runner";
import { pool, type ProviderName } from "../../proxy/pool";
import { activateQoderPat } from "../../proxy/providers/qoder";
import { activateYouMindKey } from "../../proxy/providers/youmind";
import {
  exchangeRefreshToken,
  bundleFromAccessToken,
  GROK_OAUTH,
} from "../../proxy/providers/grok/oauth";
import { providers } from "../../proxy/providers/registry";
import { config } from "../../config";
import {
  HttpError,
  parseByokTokens,
  getByokPrefix,
  getByokKeyLabel,
  normalizeModels,
  BYOK_PREFIX_RE,
  BYOK_KEY_LABEL_RE,
} from "./shared";
import * as shared from "./shared";

/** Register routes on the parent accounts router (order-sensitive). */
export function registerListRoutes(router: Hono): void {
  router.get("/warmup-queue", (c) => {
    return c.json({ data: warmupQueue.getProgressByProvider() });
  });

  /**
   * GET /api/accounts - List all accounts
   */
  router.get("/", async (c) => {
    const allAccounts = await db
      .select({
        id: accounts.id,
        provider: accounts.provider,
        email: accounts.email,
        status: accounts.status,
        enabled: accounts.enabled,
        quotaLimit: accounts.quotaLimit,
        quotaRemaining: accounts.quotaRemaining,
        quotaResetAt: accounts.quotaResetAt,
        freeLimit: accounts.freeLimit,
        freeRemaining: accounts.freeRemaining,
        freeResetAt: accounts.freeResetAt,
        lastUsedAt: accounts.lastUsedAt,
        lastLoginAt: accounts.lastLoginAt,
        errorMessage: accounts.errorMessage,
        metadata: accounts.metadata,
        cooldownUntil: accounts.cooldownUntil,
        consecutiveTransientFailures: accounts.consecutiveTransientFailures,
        nextBackoffMs: accounts.nextBackoffMs,
        consecutiveAuthErrors: accounts.consecutiveAuthErrors,
        priority: accounts.priority,
        consecutiveUseCount: accounts.consecutiveUseCount,
        createdAt: accounts.createdAt,
        updatedAt: accounts.updatedAt,
        hasTokens: sql<number>`CASE WHEN ${accounts.tokens} IS NULL OR ${accounts.tokens} = '' THEN 0 ELSE 1 END`,
      })
      .from(accounts);

    // Don't expose passwords in response
    const sanitized = allAccounts.map((acc) => {
      const { hasTokens, ...safeAccount } = acc;
      return { ...safeAccount, password: "***", tokens: hasTokens ? "[set]" : null };
    });

    return c.json({ data: sanitized, total: sanitized.length });
  });

  /**
   * BYOK (Bring Your Own Key) Management Endpoints
   * NOTE: Must be defined BEFORE /:id routes to avoid route collision
   */

  /**
   * POST /api/accounts/byok - Create BYOK provider group with one or more API keys.
   * Backward compatible: accepts either `api_key` or `api_keys[]`.
   */
}
