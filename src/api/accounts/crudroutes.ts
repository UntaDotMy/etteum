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
export function registerCrudRoutes(router: Hono): void {
  router.get("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));

    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    return c.json({
      ...account,
      password: "***",
      tokens: account.tokens ? "[set]" : null,
    });
  });

  /**
   * POST /api/accounts - Create new account
   */
  router.post("/", async (c) => {
    const body = await c.req.json<{
      provider: "kiro" | "kiro-pro" | "codebuddy" | "codebuddy-china" | "canva" | "codex" | "qoder" | "gitlab-duo" | "youmind" | "alibaba" | "antigravity" | "grok";
      email?: string;
      password?: string;
      personalToken?: string;
      apiKey?: string; // YouMind sk-ym-... key
      apiKeys?: string; // CodeBuddy China bulk: newline-separated ck_... keys
      refreshTokens?: string; // Antigravity bulk: newline-separated Google OAuth refresh_tokens
      tokens?: Record<string, unknown>;
      status?: "active" | "pending";
      browserEngine?: string;
      headless?: boolean;
    }>();

    if (!body.provider) {
      return c.json({ error: "provider is required" }, 400);
    }

    if (body.provider === "qoder" && body.personalToken) {
      const trimmed = body.personalToken.trim();
      if (!trimmed) return c.json({ error: "personalToken is empty" }, 400);

      try {
        const { tokens, jobToken } = await activateQoderPat(trimmed);
        const email = jobToken.email || jobToken.name || `qoder-${tokens.userId || Date.now()}@pat`;

        const existing = await db.select().from(accounts)
          .where(eq(accounts.email, email))
          .then((rows) => rows.find((r) => r.provider === "qoder"));

        if (existing) {
          await db.update(accounts).set({
            status: "active",
            tokens: tokens as unknown,
            errorMessage: null,
            lastLoginAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(accounts.id, existing.id));
          pool.invalidate("qoder");
          broadcast({ type: "account_updated", data: { id: existing.id, provider: "qoder", status: "active" } });
          return c.json({ id: existing.id, provider: "qoder", email, status: "active", updated: true }, 200);
        }

        const inserted = await db.insert(accounts).values({
          provider: "qoder",
          email,
          password: encrypt("pat-login"),
          status: "active",
          tokens: tokens as unknown,
          lastLoginAt: new Date(),
        }).returning();
        const created = inserted[0]!;
        pool.invalidate("qoder");
        broadcast({ type: "account_created", data: { id: created.id, provider: "qoder", email } });
        return c.json({ ...created, password: "***", tokens: "[set]" }, 201);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: `Qoder PAT activation failed: ${msg}` }, 400);
      }
    }

    // ── YouMind: API key paste flow (sk-ym-...) ────────────────────────
    // Mirrors the Qoder PAT branch above: validate the key against YouMind's
    // OpenAPI relay, derive a stable email-like label from the user's space_id,
    // then upsert by (provider, email) so re-pasting the same key updates the
    // existing row instead of erroring on the unique-index conflict.
    if (body.provider === "youmind" && body.apiKey) {
      const trimmed = body.apiKey.trim();
      if (!trimmed) return c.json({ error: "apiKey is empty" }, 400);

      try {
        const { email, metadata } = await activateYouMindKey(trimmed);
        const encryptedKey = encrypt(trimmed);

        const existing = await db.select().from(accounts)
          .where(eq(accounts.email, email))
          .then((rows) => rows.find((r) => r.provider === "youmind"));

        if (existing) {
          await db.update(accounts).set({
            password: encryptedKey,
            status: "active",
            tokens: null,
            metadata: metadata as unknown,
            errorMessage: null,
            lastLoginAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(accounts.id, existing.id));
          pool.invalidate("youmind");
          broadcast({ type: "account_updated", data: { id: existing.id, provider: "youmind", status: "active" } });
          return c.json({ id: existing.id, provider: "youmind", email, status: "active", updated: true }, 200);
        }

        const inserted = await db.insert(accounts).values({
          provider: "youmind",
          email,
          password: encryptedKey,
          status: "active",
          tokens: null,
          metadata: metadata as unknown,
          // YouMind doesn't expose per-account credit numbers via OpenAPI; use
          // -1 sentinel ("unlimited / unknown") so the warmup runner won't flip
          // the account to exhausted on a real positive limit.
          quotaLimit: -1,
          quotaRemaining: -1,
          lastLoginAt: new Date(),
        }).returning();
        const created = inserted[0]!;
        pool.invalidate("youmind");
        broadcast({ type: "account_created", data: { id: created.id, provider: "youmind", email } });
        return c.json({ ...created, password: "***", tokens: null }, 201);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: `YouMind API key activation failed: ${msg}` }, 400);
      }
    }

    // ── Grok: SSO cookie paste flow ───────────────────────────────────
    // Accept an SSO cookie value (and optional sso-rw), store it as the
    // account token. No upstream validation here — the warmup/refresh
    // scheduler will validate via /rest/rate-limits.
    if (body.provider === "grok" && body.tokens) {
      const sso = (body.tokens as Record<string, unknown>).sso as string | undefined;
      const ssoRw = (body.tokens as Record<string, unknown>).ssoRw as string | undefined;
      if (!sso || !sso.trim()) return c.json({ error: "SSO cookie is required" }, 400);

      const tokens = JSON.stringify({
        sso: sso.trim(),
        ssoRw: (ssoRw || sso).trim(),
        tier: (body.tokens as Record<string, unknown>).tier || "basic",
      });
      const email = body.email || `grok-${Date.now()}@sso`;

      const existing = await db.select().from(accounts)
        .where(eq(accounts.email, email))
        .then((rows) => rows.find((r) => r.provider === "grok"));

      if (existing) {
        await db.update(accounts).set({
          status: "active",
          tokens: tokens as unknown,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(accounts.id, existing.id));
        pool.invalidate("grok");
        broadcast({ type: "account_updated", data: { id: existing.id, provider: "grok", status: "active" } });
        return c.json({ id: existing.id, provider: "grok", email, status: "active", updated: true }, 200);
      }

      const inserted = await db.insert(accounts).values({
        provider: "grok",
        email,
        password: encrypt("sso-cookie"),
        status: "active",
        tokens: tokens as unknown,
        lastLoginAt: new Date(),
      }).returning();
      const created = inserted[0]!;
      pool.invalidate("grok");
      broadcast({ type: "account_created", data: { id: created.id, provider: "grok", email } });
      return c.json({ ...created, password: "***", tokens: "[set]" }, 201);
    }

    // ── CodeBuddy China: Bulk API key flow (ck_...) ─────────────────────
    // Accept multiple API keys (one per line), validate format, and create
    // account per key with auto-generated email label.
    if (body.provider === "codebuddy-china" && body.apiKeys) {
      const keys = body.apiKeys
        .split("\n")
        .map((k: string) => k.trim())
        .filter((k: string) => k.length > 0);

      if (keys.length === 0) {
        return c.json({ error: "apiKeys is empty" }, 400);
      }

      // Validate format
      for (const key of keys) {
        if (!key.startsWith("ck_")) {
          return c.json({ error: `Invalid API key format: ${key.substring(0, 20)}... (must start with ck_)` }, 400);
        }
      }

      const created: Array<{ id: number; email: string }> = [];
      const existingKeys = new Set(
        (await db.select({ password: accounts.password }).from(accounts)
          .where(eq(accounts.provider, "codebuddy-china"))
        ).map((r) => { try { return decrypt(r.password); } catch { return r.password; } })
      );
      const existingCount = existingKeys.size;
      let skippedCount = 0;

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const encryptedKey = encrypt(key);

        if (existingKeys.has(key)) {
          skippedCount++;
          continue;
        }

        const email = `cbc-account-${existingCount + i + 1 - skippedCount}`;
        const tokens = JSON.stringify({ api_key: key });

        const inserted = await db.insert(accounts).values({
          provider: "codebuddy-china",
          email,
          password: encryptedKey,
          status: "active",
          tokens,
          quotaLimit: -1,
          quotaRemaining: -1,
          lastLoginAt: new Date(),
        }).returning();

        if (inserted[0]) {
          created.push({ id: inserted[0].id, email });
          existingKeys.add(key);
        }
      }

      pool.invalidate("codebuddy-china" as any);
      broadcast({ type: "account_created", data: { provider: "codebuddy-china", count: created.length } });

      return c.json({
        success: true,
        count: created.length,
        skipped: skippedCount,
        accounts: created,
      }, 201);
    }

    // Antigravity bulk onboarding: newline-separated Google OAuth refresh_tokens.
    // Each is exchanged for an access_token + bound to a projectId via
    // loadCodeAssist on first use (warmup). Email is derived from the Google
    // account info if available, else a synthetic label. No browser automation.
    if (body.provider === "antigravity" && body.refreshTokens) {
      const tokens = body.refreshTokens
        .split("\n")
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0);

      if (tokens.length === 0) {
        return c.json({ error: "refreshTokens is empty" }, 400);
      }

      const created: Array<{ id: number; email: string }> = [];
      const existingTokens = new Set(
        (await db.select({ password: accounts.password }).from(accounts)
          .where(eq(accounts.provider, "antigravity"))
        ).map((r) => { try { return decrypt(r.password); } catch { return r.password; } })
      );
      const existingCount = existingTokens.size;
      let skippedCount = 0;

      for (let i = 0; i < tokens.length; i++) {
        const rt = tokens[i]!;
        const encryptedRt = encrypt(rt);
        if (existingTokens.has(rt)) { skippedCount++; continue; }

        const email = `antigravity-account-${existingCount + i + 1 - skippedCount}`;
        const tokenSet = JSON.stringify({ refresh_token: rt });

        const inserted = await db.insert(accounts).values({
          provider: "antigravity",
          email,
          password: encryptedRt,
          status: "active",
          tokens: tokenSet,
          quotaLimit: -1,
          quotaRemaining: -1,
          lastLoginAt: new Date(),
        }).returning();

        if (inserted[0]) {
          created.push({ id: inserted[0].id, email });
          existingTokens.add(rt);
        }
      }

      pool.invalidate("antigravity" as any);
      broadcast({ type: "account_created", data: { provider: "antigravity", count: created.length } });

      return c.json({
        success: true,
        count: created.length,
        skipped: skippedCount,
        accounts: created,
      }, 201);
    }

    if (!body.email || !body.password) {
      return c.json(
        { error: "email and password are required" },
        400
      );
    }

    const encryptedPassword = encrypt(body.password);

    const newAccount: NewAccount = {
      provider: body.provider,
      email: body.email,
      password: encryptedPassword,
      status: body.tokens ? "active" : (body.status || "pending"),
      tokens: body.tokens || null,
    };

    try {
      const result = await db.insert(accounts).values(newAccount).returning();
      const created = result[0]!;
      pool.invalidate(created.provider as ProviderName);

      broadcast({
        type: "account_created",
        data: { id: created.id, provider: created.provider, email: created.email },
      });

      if (!body.tokens) {
        loginQueue.enqueue(created.id, { browserEngine: body.browserEngine, headless: body.headless });
      }

      return c.json(
        { ...created, password: "***", tokens: created.tokens ? "[set]" : null, loginQueued: true },
        201
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("unique") || error.message.includes("duplicate"))
      ) {
        return c.json({ error: "Account with this email already exists for this provider" }, 409);
      }
      throw error;
    }
  });

  /**
   * POST /api/accounts/instant-login - Instant login via refresh token (bulk)
   * No browser needed — just exchange refresh token for access token
   * Body: { tokens: ["refreshToken1", ...], provider?: "kiro-pro" | "codex" | "grok" }
   *
   * - kiro-pro (default): tokens are Kiro AWS Identity refresh tokens
   * - codex: tokens are OpenAI OAuth refresh tokens (start with rt_*, ~200 chars)
   * - grok: tokens are xAI OIDC refresh tokens (auth.x.ai). Exchange → ES256 JWT
   *         access token (~6h) + durable refresh token. Stored as auth_method:"oauth".
   *         Also accepts raw access tokens (JWT starting "eyJ") — stored as-is.
   */
  router.post("/instant-login", async (c) => {
    const body = await c.req.json<{ tokens: string[]; provider?: "kiro-pro" | "codex" | "grok" }>();
    const provider = body.provider || "kiro-pro";

    if (!body.tokens || !Array.isArray(body.tokens) || body.tokens.length === 0) {
      return c.json({ error: "tokens array is required (array of refresh token strings)" }, 400);
    }

    if (provider === "codex") {
      return await handleCodexInstantLogin(c, body.tokens);
    }

    if (provider === "grok") {
      return await handleGrokInstantLogin(c, body.tokens);
    }

    const REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
    const KIRO_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const refreshToken of body.tokens) {
      const trimmed = refreshToken.trim();
      if (!trimmed) { failed++; continue; }

      try {
        const response = await fetch(REFRESH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: trimmed }),
        });

        if (!response.ok) {
          errors.push(`token ...${trimmed.slice(-8)}: refresh failed (${response.status})`);
          failed++;
          continue;
        }

        const data = await response.json() as {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: string;
        };

        if (!data.accessToken) {
          errors.push(`token ...${trimmed.slice(-8)}: no access token received`);
          failed++;
          continue;
        }

        // Generate email identifier from token (Kiro tokens are not JWT, can't extract email)
        // Use a hash of the refresh token as unique identifier
        const tokenHash = trimmed.slice(10, 18);
        let email = `kiro-${tokenHash}@token.local`;

        const tokens = {
          access_token: data.accessToken,
          refresh_token: data.refreshToken || trimmed,
          expires_at: data.expiresAt || null,
          profile_arn: KIRO_PROFILE_ARN,
        };

        // Create or update account as active with tokens
        const existing = await db.select().from(accounts)
          .where(eq(accounts.email, email))
          .then((rows) => rows.find((r) => r.provider === "kiro-pro"));

        if (existing) {
          await db.update(accounts).set({
            status: "active",
            tokens: tokens as unknown,
            errorMessage: null,
            lastLoginAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(accounts.id, existing.id));
        } else {
          await db.insert(accounts).values({
            provider: "kiro-pro",
            email,
            password: encrypt("instant-login"),
            status: "active",
            tokens: tokens as unknown,
            lastLoginAt: new Date(),
          });
        }
        success++;
      } catch (err) {
        errors.push(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    pool.invalidate("kiro-pro" as ProviderName);
    if (success > 0) {
      broadcast({ type: "accounts_updated", data: { provider: "kiro-pro", count: success } });
    }

    return c.json({ success, failed, errors: errors.length > 0 ? errors : undefined });
  });

  /**
   * POST /api/accounts/bulk - Create multiple accounts
   */
  router.post("/bulk", async (c) => {
    const body = await c.req.json<{
      accounts: Array<{
        provider: "kiro" | "codebuddy" | "canva" | "codex";
        email: string;
        password: string;
      }>;
    }>();

    if (!body.accounts || !Array.isArray(body.accounts)) {
      return c.json({ error: "accounts array is required" }, 400);
    }

    const results: Array<{ email: string; success: boolean; error?: string }> = [];

    for (const acc of body.accounts) {
      try {
        await db.insert(accounts).values({
          provider: acc.provider,
          email: acc.email,
          password: encrypt(acc.password),
          status: "pending",
        });
        results.push({ email: acc.email, success: true });
      } catch (error) {
        results.push({
          email: acc.email,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    pool.invalidate();
    broadcast({ type: "accounts_bulk_created", data: { count: results.filter((r) => r.success).length } });

    return c.json({
      total: body.accounts.length,
      success: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  });

  /**
   * PATCH /api/accounts/:id - Update account
   */
  router.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<Partial<{
      status: "active" | "exhausted" | "error" | "pending";
      enabled: boolean;
      tokens: Record<string, unknown>;
      password: string;
      quotaLimit: number;
      quotaRemaining: number;
      quotaResetAt: string;
      errorMessage: string | null;
    }>>();

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (body.status) updateData.status = body.status;
    if (typeof body.enabled === "boolean") updateData.enabled = body.enabled;
    if (body.tokens) updateData.tokens = body.tokens;
    if (body.password) updateData.password = encrypt(body.password);
    if (body.quotaLimit !== undefined) updateData.quotaLimit = body.quotaLimit;
    if (body.quotaRemaining !== undefined) updateData.quotaRemaining = body.quotaRemaining;
    if (body.quotaResetAt) updateData.quotaResetAt = new Date(body.quotaResetAt);
    if (body.errorMessage !== undefined) updateData.errorMessage = body.errorMessage;

    const result = await db
      .update(accounts)
      .set(updateData)
      .where(eq(accounts.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Account not found" }, 404);
    }

    const updated = result[0]!;
    pool.invalidate(updated.provider as ProviderName);
    broadcast({
      type: "account_updated",
      data: { id: updated.id, status: updated.status, enabled: updated.enabled, provider: updated.provider },
    });

    return c.json({ ...updated, password: "***", tokens: updated.tokens ? "[set]" : null });
  });

  /**
   * POST /api/accounts/:id/toggle - Toggle account enabled flag
   */
  router.post("/:id/toggle", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));

    const [current] = await db
      .select({ enabled: accounts.enabled })
      .from(accounts)
      .where(eq(accounts.id, id));

    if (!current) {
      return c.json({ error: "Account not found" }, 404);
    }

    const next = typeof body.enabled === "boolean" ? body.enabled : !current.enabled;
    const updated = await pool.setEnabled(id, next);

    if (!updated) {
      return c.json({ error: "Account not found" }, 404);
    }

    return c.json({
      id: updated.id,
      enabled: updated.enabled,
      status: updated.status,
      provider: updated.provider,
    });
  });

  /**
   * POST /api/accounts/toggle-all - Bulk toggle enabled for all accounts of a provider
   * Body: { provider: string, enabled: boolean }
   */
  router.post("/toggle-all", async (c) => {
    const body = await c.req.json<{ provider: string; enabled: boolean }>();

    if (!body.provider) {
      return c.json({ error: "provider is required" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) is required" }, 400);
    }

    const count = await pool.setEnabledByProvider(body.provider as ProviderName, body.enabled);
    return c.json({ provider: body.provider, enabled: body.enabled, count });
  });

  /**
   * POST /api/accounts/bulk-delete - Delete multiple accounts at once.
   *
   * Works for every provider (the row shape is identical). Defined BEFORE the
   * dynamic `/:id` route so Hono matches the literal path first.
   *
   * Body: { ids: number[] }
   * Returns: { success, requested, deleted, providers, notFound }
   */
  router.post("/bulk-delete", async (c) => {
    const body = await c.req.json<{ ids?: Array<number | string> }>().catch(() => ({} as { ids?: Array<number | string> }));

    // Coerce + dedupe + drop anything non-numeric so a malformed entry can't
    // widen the delete (e.g. NaN turning into "delete everything").
    const ids = Array.from(
      new Set(
        (body.ids ?? [])
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    );

    if (ids.length === 0) {
      return c.json({ error: "ids must be a non-empty array of account ids" }, 400);
    }

    // Resolve providers up front so we can invalidate exactly the affected pools.
    const targets = await db
      .select({ id: accounts.id, provider: accounts.provider })
      .from(accounts)
      .where(inArray(accounts.id, ids));

    if (targets.length === 0) {
      return c.json({ error: "No matching accounts found" }, 404);
    }

    const foundIds = targets.map((t) => t.id);
    const providersAffected = Array.from(new Set(targets.map((t) => t.provider)));

    // Atomic: FK cleanup + delete in one transaction (CWE-362).
    const deletedIds = await db.transaction(async (tx) => {
      await tx.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, foundIds));
      await tx.update(vccCards).set({ usedByAccountId: null }).where(inArray(vccCards.usedByAccountId, foundIds));
      await tx.delete(vccTransactions).where(inArray(vccTransactions.accountId, foundIds));
      const result = await tx.delete(accounts).where(inArray(accounts.id, foundIds)).returning();
      return result.map((r) => r.id);
    });

    for (const provider of providersAffected) {
      pool.invalidate(provider as ProviderName);
    }
    // Mirror single-delete's broadcast shape per id so existing dashboard
    // listeners (`account_deleted`) keep working without changes, then send
    // one summary frame for clients that prefer the bulk signal.
    for (const id of deletedIds) {
      broadcast({ type: "account_deleted", data: { id } });
    }
    broadcast({ type: "accounts_deleted", data: { ids: deletedIds, providers: providersAffected } });

    const notFound = ids.filter((id) => !foundIds.includes(id));
    return c.json({
      success: true,
      requested: ids.length,
      deleted: deletedIds.length,
      deletedIds,
      providers: providersAffected,
      notFound,
    });
  });

  /**
   * DELETE /api/accounts/:id - Delete account
   */
  router.delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));

    // Wrap FK cleanup + delete in a transaction so a crash between steps cannot
    // leave orphaned FKs or a half-deleted account (CWE-362). Delete the account
    // FIRST with .returning(); rollback on not-found so we never side-effect
    // other tables for a missing id.
    let deleted: typeof accounts.$inferSelect | null = null;
    try {
      deleted = await db.transaction(async (tx) => {
        const result = await tx.delete(accounts).where(eq(accounts.id, id)).returning();
        if (result.length === 0) {
          await tx.rollback();
          return null;
        }
        await tx.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));
        await tx.update(vccCards).set({ usedByAccountId: null }).where(eq(vccCards.usedByAccountId, id));
        await tx.delete(vccTransactions).where(eq(vccTransactions.accountId, id));
        return result[0]!;
      });
    } catch (err: any) {
      // rollback throws; surface not-found distinctly.
      if (err && err.message === "rollback") return c.json({ error: "Account not found" }, 404);
      throw err;
    }

    if (!deleted) {
      return c.json({ error: "Account not found" }, 404);
    }

    pool.invalidate(deleted.provider as ProviderName);
    broadcast({ type: "account_deleted", data: { id } });

    return c.json({ success: true, deleted: id });
  });

  /**
   * POST /api/accounts/:id/login - Trigger login for account
   */
}
