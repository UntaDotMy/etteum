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
    const allAccounts = await db.select().from(accounts);

    // Don't expose passwords in response
    const sanitized = allAccounts.map((acc) => {
      let tokensOut: unknown = null;
      if (acc.tokens) {
        if (acc.provider === "alibaba") {
          // Alibaba tokens contain per-model quota data (non-sensitive).
          // Try to parse from JSON string if needed.
          if (typeof acc.tokens === "string") {
            try { tokensOut = JSON.parse(acc.tokens); } catch { tokensOut = acc.tokens; }
          } else {
            tokensOut = acc.tokens;
          }
        } else {
          tokensOut = "[set]";
        }
      }
      return { ...acc, password: "***", tokens: tokensOut };
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
