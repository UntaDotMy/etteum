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

export function registerAlibabaRoutes(router: Hono): void {
  router.post("/alibaba", async (c) => {
    const body = await c.req.json<{ api_keys?: string }>();
    const keys = (body.api_keys || "")
      .split("\n")
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0);

    if (keys.length === 0) {
      return c.json({ error: "api_keys is empty — paste one sk-... key per line" }, 400);
    }

    const created: Array<{ id: number; email: string }> = [];
    const existingKeys = new Set(
      (await db.select({ password: accounts.password }).from(accounts)
        .where(eq(accounts.provider, "alibaba"))
      ).map((r) => { try { return decrypt(r.password); } catch { return ""; } })
    );

    const existingCount = existingKeys.size;
    let skippedCount = 0;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const encryptedKey = encrypt(key);

      // Skip duplicate keys
      if (existingKeys.has(key)) {
        skippedCount++;
        continue;
      }

      const email = `ali-key-${existingCount + i + 1 - skippedCount}`;

      const inserted = await db.insert(accounts).values({
        provider: "alibaba",
        email,
        password: encryptedKey,
        status: "active",
        enabled: true,
        quotaLimit: -1,
        quotaRemaining: -1,
        lastLoginAt: new Date(),
      }).returning();

      if (inserted[0]) {
        created.push({ id: inserted[0].id, email });
        existingKeys.add(key);
      }
    }

    await pool.invalidate("alibaba" as any);
    broadcast({ type: "account_created", data: { provider: "alibaba", count: created.length } });

    // Auto-warmup newly created Alibaba accounts to populate queryableModels
    if (created.length > 0) {
      for (const acc of created) {
        warmupQueue.enqueue(acc.id).catch(() => {});
      }
    }

    return c.json({
      success: true,
      count: created.length,
      skipped: skippedCount,
      accounts: created,
    }, 201);
  });

  /**
   * POST /api/accounts/alibaba/:id/reveal - Reveal a stored Alibaba API key.
   */
  router.post("/alibaba/:id/reveal", async (c) => {
    // Secret disclosure: require local origin / CLI admin token.
    const guard = adminGuardFromPeer(peerIpFromHonoContext(c), c.req.raw.headers, new URL(c.req.url).searchParams);
    if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);

    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid account id" }, 400);

    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!account || account.provider !== "alibaba") {
      return c.json({ error: "Alibaba account not found" }, 404);
    }

    try {
      const apiKey = decrypt(account.password);
      return c.json({ success: true, id: account.id, email: account.email, apiKey });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to decrypt key" }, 500);
    }
  });

  /**
   * POST /api/accounts/alibaba/:id/test - Test an Alibaba API key connection.
   */
  router.post("/alibaba/:id/test", async (c) => {
    const id = Number(c.req.param("id"));
    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!account || account.provider !== "alibaba") {
      return c.json({ error: "Alibaba account not found" }, 404);
    }

    const apiKey = decrypt(account.password);
    if (!apiKey) return c.json({ success: false, error: "No API key stored" });

    try {
      const startTime = Date.now();
      const response = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", {
        method: "GET",
        headers: { "Authorization": `Bearer ${apiKey}` },
      });
      const latencyMs = Date.now() - startTime;

      if (response.status === 401) {
        return c.json({ success: false, error: "Invalid API key (401)", latency_ms: latencyMs });
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return c.json({ success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, latency_ms: latencyMs });
      }

      const data = await response.json() as any;
      const modelCount = Array.isArray(data.data) ? data.data.length : 0;

      return c.json({
        success: true,
        message: "Connection OK",
        model_count: modelCount,
        latency_ms: latencyMs,
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : "Network error",
      });
    }
  });

  /**
   * ============================================================================
   * GitLab Duo Management Endpoints
   * NOTE: Must be defined BEFORE /:id routes to avoid route collision.
   * ============================================================================
   */

  /**
   * Create a GitLab Duo account from a PAT — pure function, callable from both
   * the HTTP route AND the bot runner (after Camoufox finishes the OAuth flow
   * and obtains a fresh PAT). Performs PAT validation → namespace resolve →
   * models lookup → row insert (or update of an existing pending row).
   *
   * Pass `existingAccountId` when called from the bot path to UPDATE the
   * pending row created at queue time (preserves email + log history) instead
   * of inserting a duplicate.
   */




  /**
   * POST /api/accounts/gitlab-duo - Create a GitLab Duo account from a PAT.
   *
   * Body: { gitlab_base_url?: string, pat: string, label?: string }
   *
   * Thin wrapper over `createGitlabDuoAccount()`.
   */
}
