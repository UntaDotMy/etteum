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
export function decodeJwtPayload(token: string): Record<string, any> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1]! + "=".repeat((4 - parts[1]!.length % 4) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// Module-level Codex OAuth constants + upsert. Must live here (not nested inside
// registerActionRoutes) so importCodexAccessToken / exchangeCodex* can call them.
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_SCOPE = "openid profile email offline_access";

async function upsertCodexAccount(email: string, tokens: Record<string, unknown>): Promise<number> {
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, email))
    .then((rows) => rows.find((r) => r.provider === "codex"));

  if (existing) {
    await db.update(accounts).set({
      status: "active",
      tokens: tokens as unknown,
      errorMessage: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(accounts.id, existing.id));
    return existing.id;
  }

  const inserted = await db.insert(accounts).values({
    provider: "codex",
    email,
    password: encrypt("instant-login"),
    status: "active",
    tokens: tokens as unknown,
    lastLoginAt: new Date(),
  }).returning();

  return inserted[0]!.id;
}

export async function importCodexAccessToken(accessToken: string, name?: string) {
  const token = accessToken.trim();
  if (!token) {
    throw new Error("Access token is required");
  }

  const claims = decodeJwtPayload(token);
  const authClaim = claims["https://api.openai.com/auth"];
  const profileClaim = claims["https://api.openai.com/profile"];

  let email = String(profileClaim?.email || claims.email || claims.preferred_username || "");
  let accountId = String(
    authClaim?.chatgpt_account_id || authClaim?.account_id || authClaim?.user_id || claims.chatgpt_account_id || claims.account_id || ""
  );
  const planType = String(authClaim?.chatgpt_plan_type || claims.plan_type || "");
  const jwtExp = claims.exp ? Number(claims.exp) : null;

  if (!email || !accountId) {
    try {
      const usageResp = await fetch(CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "codex_cli_rs/0.1.0",
        },
      });
      if (usageResp.ok) {
        const usage = await usageResp.json() as any;
        if (!email) email = String(usage.email || "");
        if (!accountId) accountId = String(usage.account_id || usage.chatgpt_account_id || "");
      }
    } catch {}
  }

  if (!email) {
    email = name?.trim() || `codex-${token.slice(-8)}@token.local`;
  }

  const newTokens = {
    access_token: token,
    refresh_token: "",
    id_token: "",
    expires_at: jwtExp ? String(jwtExp) : "",
    email,
    account_id: accountId,
    method: "access_token",
    plan_type: planType,
  };

  const id = await upsertCodexAccount(email, newTokens);
  pool.invalidate("codex" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codex", count: 1 } });

  return {
    id,
    provider: "codex",
    email,
    name: name?.trim() || email,
    workspace: accountId || null,
    plan: planType || null,
  };
}

export async function exchangeCodexAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });

  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("Codex token exchange returned no access_token");
  }

  const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
  let email = String(claims.email || "");
  let accountId = "";
  const authClaim = claims["https://api.openai.com/auth"];
  const profileClaim = claims["https://api.openai.com/profile"];
  const planType = String(authClaim?.chatgpt_plan_type || claims.plan_type || "");

  if (profileClaim && typeof profileClaim === "object") {
    email = String(profileClaim.email || email || "");
  }

  if (authClaim && typeof authClaim === "object") {
    accountId = String(
      authClaim.chatgpt_account_id || authClaim.account_id || authClaim.user_id || ""
    );
  }
  if (!accountId) {
    accountId = String(claims.chatgpt_account_id || claims.account_id || "");
  }

  if (!email || !accountId) {
    try {
      const usageResp = await fetch(CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${data.access_token}`,
          "User-Agent": "codex_cli_rs/0.1.0",
        },
      });
      if (usageResp.ok) {
        const usage = await usageResp.json() as any;
        if (!email) email = String(usage.email || "");
        if (!accountId) accountId = String(usage.account_id || usage.chatgpt_account_id || "");
      }
    } catch {}
  }

  if (!email) {
    email = `codex-${input.code.slice(-8)}@oauth.local`;
  }

  const expiresIn = Number(data.expires_in) || 3600;
  const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || "",
    id_token: data.id_token || "",
    expires_at: expiresAt,
    email,
    account_id: accountId,
    method: "authorization_code",
    plan_type: planType,
  };

  const id = await upsertCodexAccount(email, newTokens);
  pool.invalidate("codex" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codex", count: 1 } });

  return {
    id,
    provider: "codex",
    email,
    name: email,
    workspace: accountId || null,
    plan: planType || null,
  };
}

/** Bounded parallel map for bulk token exchange (keeps upstream load reasonable). */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i]!, i);
      }
    }),
  );
}

export async function exchangeCodexRefreshTokens(tokens: string[]) {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];
  // Cap error list so huge batches don't balloon the response body.
  const pushErr = (msg: string) => {
    if (errors.length < 50) errors.push(msg);
  };

  await mapPool(tokens, 8, async (refreshToken) => {
    const trimmed = refreshToken.trim();
    if (!trimmed) { failed++; return; }

    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: trimmed,
        client_id: CODEX_CLIENT_ID,
        scope: CODEX_SCOPE,
      });

      const response = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        pushErr(`token ...${trimmed.slice(-8)}: refresh failed (${response.status}): ${text.slice(0, 100)}`);
        failed++;
        return;
      }

      const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        expires_in?: number;
      };

      if (!data.access_token) {
        pushErr(`token ...${trimmed.slice(-8)}: no access_token in response`);
        failed++;
        return;
      }

      const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
      let email = String(claims.email || "");
      let accountId = "";
      const authClaim = claims["https://api.openai.com/auth"];
      if (authClaim && typeof authClaim === "object") {
        accountId = String(
          authClaim.chatgpt_account_id || authClaim.account_id || authClaim.user_id || ""
        );
      }
      if (!accountId) {
        accountId = String(claims.chatgpt_account_id || claims.account_id || "");
      }

      if (!email || !accountId) {
        try {
          const usageResp = await fetch(CODEX_USAGE_URL, {
            headers: {
              "Authorization": `Bearer ${data.access_token}`,
              "User-Agent": "codex_cli_rs/0.1.0",
            },
          });
          if (usageResp.ok) {
            const usage = await usageResp.json() as any;
            if (!email) email = usage.email || "";
            if (!accountId) {
              accountId = String(usage.account_id || usage.chatgpt_account_id || "");
            }
          }
        } catch {}
      }

      if (!email) email = `codex-${trimmed.slice(-8)}@token.local`;

      const expiresIn = Number(data.expires_in) || 3600;
      const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);

      const newTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || trimmed,
        id_token: data.id_token || "",
        expires_at: expiresAt,
        email,
        account_id: accountId,
        method: "refresh_token",
      };

      await upsertCodexAccount(email, newTokens);
      success++;
    } catch (err) {
      pushErr(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  });

  pool.invalidate("codex" as ProviderName);
  if (success > 0) {
    broadcast({ type: "accounts_updated", data: { provider: "codex", count: success } });
  }

  return { success, failed, errors: errors.length > 0 ? errors : undefined };
}

/**
 * Stable Grok OAuth email label for (provider,email) uniqueness.
 * Prefer full OIDC `sub` so the same user always maps to one row.
 */
export function grokOAuthEmailFromIdentity(opts: {
  sub?: string | null;
  email?: string | null;
  tokenFallback?: string;
}): string {
  const realEmail = (opts.email || "").trim();
  if (realEmail && realEmail.includes("@") && !realEmail.endsWith("@oauth") && !realEmail.endsWith("@token.local")) {
    return realEmail;
  }
  const sub = (opts.sub || "").trim();
  if (sub) return `grok-${sub}@oauth`;
  const fb = (opts.tokenFallback || "").trim();
  if (fb) return `grok-${fb.slice(-12)}@token.local`;
  return `grok-${Date.now()}@token.local`;
}

/** Dedup + normalize a bulk paste of tokens (order-preserving). */
export function uniqueTokenLines(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Bulk-import Grok accounts via refresh tokens (preferred) or access tokens.
 * Used by POST /api/accounts/instant-login (provider=grok).
 *
 * - Refresh tokens (durable): exchanged at auth.x.ai for a fresh access token.
 * - Access tokens (JWT, "eyJ..."): stored as-is with no refresh capability.
 * - Duplicates: same token in the paste, same refresh_token already in DB, or
 *   same OIDC sub → single account row (upsert), counted as `updated` / `skipped`.
 */
export async function exchangeGrokInstantTokens(tokens: string[]): Promise<{
  success: number;
  failed: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
}> {
  let success = 0;
  let failed = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  const pushErr = (msg: string) => {
    if (errors.length < 50) errors.push(msg);
  };

  const unique = uniqueTokenLines(tokens);
  skipped += Math.max(0, tokens.filter((t) => t.trim()).length - unique.length);

  // Preload existing Grok OAuth accounts for refresh_token / sub matching.
  const existingGrok = await db
    .select()
    .from(accounts)
    .where(eq(accounts.provider, "grok"));
  const byRefresh = new Map<string, { id: number; email: string }>();
  const bySub = new Map<string, { id: number; email: string }>();
  for (const row of existingGrok) {
    const tok = row.tokens as Record<string, unknown> | null;
    if (!tok || typeof tok !== "object") continue;
    const rt = typeof tok.refresh_token === "string" ? tok.refresh_token.trim() : "";
    const sub = typeof tok.sub === "string" ? tok.sub.trim() : "";
    if (rt) byRefresh.set(rt, { id: row.id, email: row.email });
    if (sub) bySub.set(sub, { id: row.id, email: row.email });
  }

  // Credit probe is one extra HTTP round-trip per token; for large pastes skip
  // it so import finishes (warmup / refresh-quota can fill credits later).
  const probeCredits = unique.length <= 25;

  // Serialize sub→email assignment within the batch so concurrent workers
  // don't create two rows for the same sub before either commits.
  const batchSubs = new Set<string>();
  const batchLock = { chain: Promise.resolve() };
  function withBatchLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = batchLock.chain.then(fn, fn);
    batchLock.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  await mapPool(unique, 8, async (token) => {
    const trimmed = token;

    try {
      // Already stored under this exact refresh token → skip network + insert.
      const knownRt = byRefresh.get(trimmed);
      if (knownRt && !trimmed.startsWith("eyJ")) {
        skipped++;
        return;
      }

      let oauthTokens;
      if (trimmed.startsWith("eyJ")) {
        oauthTokens = bundleFromAccessToken(trimmed);
      } else {
        oauthTokens = await exchangeRefreshToken(trimmed);
      }

      // Prefer email of existing row matched by sub (stable identity).
      const sub = (oauthTokens.sub || "").trim();
      let email = grokOAuthEmailFromIdentity({
        sub,
        email: oauthTokens.email,
        tokenFallback: trimmed,
      });
      if (sub && bySub.has(sub)) {
        email = bySub.get(sub)!.email;
      }

      if (probeCredits) {
        try {
          const { probeOAuthChatCredits } = await import("../../proxy/providers/grok/oauth");
          const q = await probeOAuthChatCredits(oauthTokens.access_token);
          if (q && q.limit > 0) {
            oauthTokens.credits_limit = q.limit;
            oauthTokens.credits_remaining = q.remaining;
          }
        } catch {
          /* non-fatal */
        }
      }

      const result = await withBatchLock(async () => {
        // Re-check sub after other workers may have inserted.
        if (sub && bySub.has(sub)) {
          email = bySub.get(sub)!.email;
        } else if (sub && batchSubs.has(sub)) {
          // Another concurrent worker is creating this sub — wait via lock is enough;
          // fall through to upsert by email which is deterministic.
          email = grokOAuthEmailFromIdentity({ sub, tokenFallback: trimmed });
        }
        if (sub) batchSubs.add(sub);
        return upsertGrokOAuthAccount(email, oauthTokens);
      });

      if (result.created) {
        success++;
      } else {
        updated++;
        success++; // still a successful import outcome
      }

      // Keep in-memory indexes warm for the rest of the batch.
      if (oauthTokens.refresh_token) {
        byRefresh.set(oauthTokens.refresh_token.trim(), { id: result.id, email });
      }
      // Also index the pre-rotation token so a second paste of the old value hits skip.
      if (!trimmed.startsWith("eyJ")) {
        byRefresh.set(trimmed, { id: result.id, email });
      }
      if (sub) bySub.set(sub, { id: result.id, email });
    } catch (err) {
      pushErr(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  });

  pool.invalidate("grok" as ProviderName);
  if (success > 0) {
    broadcast({ type: "accounts_updated", data: { provider: "grok", count: success } });
  }

  return {
    success,
    failed,
    updated,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Import grok-farm batch accounts (accounts.json records) into the Grok provider.
 * Normalizes farm token shape and writes absolute credits when present.
 */
export async function importGrokFarmAccounts(
  records: Array<Record<string, unknown>>,
): Promise<{ success: number; failed: number; errors?: string[]; ids: number[] }> {
  const { normalizeGrokOAuthTokens } = await import("../../proxy/providers/grok/oauth");
  let success = 0;
  let failed = 0;
  const errors: string[] = [];
  const ids: number[] = [];

  for (const rec of records) {
    try {
      const emailRaw = typeof rec.email === "string" ? rec.email.trim() : "";
      const tokensRaw = rec.tokens ?? rec;
      const oauthTokens = normalizeGrokOAuthTokens(tokensRaw);
      if (!oauthTokens) {
        failed++;
        errors.push(`${emailRaw || "record"}: missing access_token`);
        continue;
      }
      // Prefer farm absolute credits when present.
      const vRem = Number(rec.verify_credits_remaining ?? (tokensRaw as any)?.credits_remaining);
      const vLim = Number(rec.verify_credits_limit ?? (tokensRaw as any)?.credits_limit);
      if (Number.isFinite(vRem)) oauthTokens.credits_remaining = vRem;
      if (Number.isFinite(vLim)) oauthTokens.credits_limit = vLim;

      const email =
        emailRaw ||
        grokOAuthEmailFromIdentity({
          sub: oauthTokens.sub,
          email: oauthTokens.email,
          tokenFallback: oauthTokens.refresh_token || oauthTokens.access_token,
        });

      const { id } = await upsertGrokOAuthAccount(email, oauthTokens, {
        password: typeof rec.password === "string" ? rec.password : undefined,
        farmMeta: {
          source: "grok-farm",
          verified: rec.verified === true,
          web_activated: rec.web_activated === true,
          proxy: rec.proxy,
        },
      });
      ids.push(id);
      success++;
    } catch (err) {
      failed++;
      errors.push(`${String((rec as any).email || "?")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  pool.invalidate("grok" as ProviderName);
  if (success > 0) {
    broadcast({ type: "accounts_updated", data: { provider: "grok", count: success } });
  }
  return { success, failed, errors: errors.length > 0 ? errors : undefined, ids };
}

async function upsertGrokOAuthAccount(
  email: string,
  oauthTokens: import("../../proxy/providers/grok/oauth").GrokOAuthTokens,
  opts?: { password?: string; farmMeta?: Record<string, unknown> },
): Promise<{ id: number; created: boolean }> {
  // Prefer full-sub email identity so truncated labels from older builds still
  // collide on unique (provider,email) only when emails match; also match by sub
  // in tokens when the stored email was the short form.
  let existing = await db.select().from(accounts)
    .where(and(eq(accounts.provider, "grok"), eq(accounts.email, email)))
    .limit(1);

  if (existing.length === 0 && oauthTokens.sub) {
    const sub = oauthTokens.sub.trim();
    const allGrok = await db.select().from(accounts).where(eq(accounts.provider, "grok"));
    const bySub = allGrok.find((r) => {
      const t = r.tokens as Record<string, unknown> | null;
      return t && typeof t.sub === "string" && t.sub.trim() === sub;
    });
    if (bySub) existing = [bySub];
  }

  const tokensBlob = {
    auth_method: "oauth" as const,
    access_token: oauthTokens.access_token,
    refresh_token: oauthTokens.refresh_token,
    expires_at: oauthTokens.expires_at,
    oidc_client_id: oauthTokens.oidc_client_id,
    sub: oauthTokens.sub,
    email: oauthTokens.email || email,
    ...(oauthTokens.credits_remaining != null ? { credits_remaining: oauthTokens.credits_remaining } : {}),
    ...(oauthTokens.credits_limit != null ? { credits_limit: oauthTokens.credits_limit } : {}),
  };

  const quotaPatch: Record<string, unknown> = {};
  if (oauthTokens.credits_limit != null && oauthTokens.credits_limit > 0) {
    quotaPatch.quotaLimit = Math.floor(oauthTokens.credits_limit);
    quotaPatch.quotaRemaining = Math.floor(
      oauthTokens.credits_remaining ?? oauthTokens.credits_limit,
    );
  }

  if (existing.length > 0) {
    await db.update(accounts)
      .set({
        tokens: tokensBlob,
        status: "active",
        enabled: true,
        lastLoginAt: new Date(),
        errorMessage: null,
        ...quotaPatch,
        ...(opts?.password ? { password: encrypt(opts.password) } : {}),
        metadata: {
          ...((existing[0]!.metadata as object) || {}),
          auth_method: "oauth",
          oidc_client_id: oauthTokens.oidc_client_id,
          ...(opts?.farmMeta || {}),
        },
      })
      .where(eq(accounts.id, existing[0]!.id));
    return { id: existing[0]!.id, created: false };
  }

  const inserted = await db.insert(accounts).values({
    provider: "grok",
    email,
    password: encrypt(opts?.password || "oauth:no-password"),
    status: "active",
    enabled: true,
    tokens: tokensBlob,
    ...(quotaPatch as { quotaLimit?: number; quotaRemaining?: number }),
    lastLoginAt: new Date(),
    metadata: {
      auth_method: "oauth",
      oidc_client_id: oauthTokens.oidc_client_id,
      ...(opts?.farmMeta || {}),
    },
  }).returning();
  return { id: inserted[0]!.id, created: true };
}

export function registerActionRoutes(router: Hono): void {
  router.post("/:id/login", async (c) => {
    const id = Number(c.req.param("id"));
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));

    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    // Import auth runner dynamically to avoid circular deps
    const { loginAccount } = await import("../../auth/runner");

    // All providers (including antigravity) route through Camoufox automation.
    // Challenges surface as a `manual` result via the standard loginAccount path.
    const result = await loginAccount(account);

    return c.json(result);
  });

  /** Gone: manual captcha round-trip. Challenges surface as login results. */
  router.post("/:id/challenge-answer", (c) =>
    c.json({ error: { message: "Endpoint removed", type: "gone" } }, 410),
  );
  router.post("/:id/cancel-manual", (c) =>
    c.json({ error: { message: "Endpoint removed", type: "gone" } }, 410),
  );

  /**
   * POST /api/accounts/:id/reveal - Reveal the stored API key for key-based providers.
   *
   * Only allowed for providers that authenticate with static API keys/PATs
   * (byok, codebuddy-china, youmind). Browser-login providers store session
   * tokens that are not useful to the user in raw form.
   */
  router.post("/:id/reveal", async (c) => {
    // Secret disclosure: require local origin / CLI admin token on top of the
    // API key. A leaked low-priv managed key must not be able to exfiltrate
    // stored provider credentials (OWASP API1:2023 / CWE-862).
    const guard = adminGuardFromPeer(peerIpFromHonoContext(c), c.req.raw.headers, new URL(c.req.url).searchParams);
    if (!guard.allowed) return c.json({ error: `Forbidden: ${guard.reason}` }, 403);

    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid account id" }, 400);

    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    const KEY_BASED_PROVIDERS = new Set(["byok", "codebuddy-china", "youmind", "alibaba"]);
    if (!KEY_BASED_PROVIDERS.has(account.provider)) {
      return c.json({ error: "This provider does not use static API keys" }, 400);
    }

    try {
      // For codebuddy-china, the key is also stored in tokens.api_key
      const tokens = account.tokens ? (typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens) : {};
      const apiKey = (tokens as Record<string, string>)?.api_key || decrypt(account.password);
      return c.json({ success: true, id: account.id, provider: account.provider, apiKey });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to decrypt key" }, 500);
    }
  });

  /**
   * POST /api/accounts/:id/refresh-quota - Refresh quota for account
   */
  router.post("/:id/refresh-quota", async (c) => {
    const id = Number(c.req.param("id"));
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));

    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    const result = await warmupAccount(account);
    if (!result.success && !result.retryable && result.kind !== "unsupported") {
      return c.json(result, 500);
    }

    return c.json(result);
  });

  /**
   * POST /api/accounts/:id/warmup - Queue non-login WarmUp for account
   */
  router.post("/:id/warmup", async (c) => {
    const id = Number(c.req.param("id"));
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));

    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    warmupQueue.enqueue(id);
    return c.json({ message: "WarmUp queued", accountId: id });
  });

  /**
   * F15: Consume a Codex rate-limit-reset credit to reset the rate-limit window
   * immediately. Mirrors reference handleResetCodexLimit +
   * /api/usage/[connectionId]/codex-reset-credits. Server-side anti-replay
   * `redeemRequestId` prevents double-spending a credit on retry.
   */
  router.post("/:id/codex-reset-credits", async (c) => {
    const id = Number(c.req.param("id"));
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
    if (!account) return c.json({ error: "Account not found" }, 404);
    if (account.provider !== "codex") {
      return c.json({ error: "Codex reset credits only apply to codex accounts" }, 400);
    }
    const { providers } = await import("../../proxy/router");
    const codexProvider = providers["codex"] as any;
    if (!codexProvider?.consumeResetCredit) {
      return c.json({ error: "Codex provider does not support reset credits" }, 400);
    }
    const redeemRequestId = crypto.randomUUID();
    const result = await codexProvider.consumeResetCredit(account, redeemRequestId);
    if (!result.success) {
      if (result.error === "no_credit") return c.json({ code: "no_credit", error: "No reset credits available" }, 409);
      return c.json({ error: result.error || "Reset failed" }, 400);
    }
    // Invalidate pool cache so the reset is reflected immediately.
    pool.invalidate("codex" as ProviderName);
    broadcast({ type: "codex_reset_consumed", data: { accountId: id, remainingCredits: result.remainingCredits } });
    return c.json({ success: true, remainingCredits: result.remainingCredits });
  });

  /**
   * POST /api/accounts/:id/open-panel - Open web panel in browser with auto-login
   * Supports: kiro, kiro-pro, qoder
   */
  router.post("/:id/open-panel", async (c) => {
    const id = Number(c.req.param("id"));
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));

    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    const tokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : account.tokens;

    if (!tokens) {
      return c.json({ error: "No tokens available" }, 400);
    }

    try {
      // Headed Chromium via Playwright (shared dep) — leaves the window open for the user.
      const { chromium } = await import("playwright");

      if (account.provider.startsWith("kiro")) {
        if (!tokens.refresh_token) {
          return c.json({ error: "No refresh token available" }, 400);
        }

        // Refresh to get fresh access token
        const refreshResp = await fetch("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokens.refresh_token }),
        });

        if (!refreshResp.ok) {
          return c.json({ error: `Token refresh failed: ${refreshResp.status}` }, 500);
        }

        const refreshData = (await refreshResp.json()) as {
          accessToken?: string;
          refreshToken?: string;
          profileArn?: string;
        };

        const accessToken = refreshData.accessToken;
        const profileArn = tokens.profile_arn || tokens.profileArn || refreshData.profileArn || "";

        // Extract userId from getUsageLimits response
        const meta = (account.metadata || {}) as Record<string, unknown>;
        let userId = (meta.kiroUserId as string) || "";
        if (!userId) {
          try {
            const url = new URL("https://q.us-east-1.amazonaws.com/getUsageLimits");
            url.searchParams.set("origin", "AI_EDITOR");
            url.searchParams.set("resourceType", "AGENTIC_REQUEST");
            url.searchParams.set("profileArn", profileArn);
            const usageResp = await fetch(url.toString(), {
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`,
                "User-Agent": "KiroIDE/compatible pool-proxy/1.0.0",
              },
            });
            if (usageResp.ok) {
              const usageData = (await usageResp.json()) as { userInfo?: { userId?: string } };
              userId = usageData.userInfo?.userId || "";
            }
          } catch { /* ignore */ }
        }

        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        const cookies: Array<{ name: string; value: string; domain: string; path: string }> = [
          { name: "AccessToken", value: accessToken || "", domain: "app.kiro.dev", path: "/" },
          { name: "RefreshToken", value: String(tokens.refresh_token || ""), domain: "app.kiro.dev", path: "/" },
          { name: "Idp", value: "Google", domain: "app.kiro.dev", path: "/" },
        ];
        if (userId) {
          cookies.push({ name: "UserId", value: userId, domain: "app.kiro.dev", path: "/" });
        }
        await context.addCookies(cookies);
        const page = await context.newPage();
        await page.goto("https://app.kiro.dev/settings/account", { waitUntil: "domcontentloaded" });
        // Intentionally leave the browser open for the user (matches old open-panel UX).
        return c.json({ success: true, message: `Browser opened for ${account.email}` });

      } else if (account.provider === "qoder") {
        const webCookie = tokens.web_cookie as string | undefined;
        if (!webCookie) {
          return c.json({ error: "No web_cookie available for Qoder account" }, 400);
        }

        const cookies = webCookie.split("; ").map((pair) => {
          const idx = pair.indexOf("=");
          if (idx === -1) return null;
          const name = pair.slice(0, idx);
          const value = pair.slice(idx + 1);
          return { name, value };
        }).filter((c): c is { name: string; value: string } => c !== null);

        const qoderCookies = cookies
          .filter((c) => {
            if (c.name.startsWith("qoder_") || c.name === "tfstk" || c.name === "cbc" || c.name === "test_cookie") return true;
            if (c.name.startsWith("_ga") || c.name.startsWith("_gcl") || c.name.startsWith("_nb")) return true;
            if (c.name === "OTZ" || c.name.startsWith("_c_")) return true;
            return false;
          });

        if (qoderCookies.length === 0) {
          return c.json({ error: "No valid Qoder cookies found in web_cookie" }, 400);
        }

        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        await context.addCookies(
          qoderCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: "qoder.com",
            path: "/",
          })),
        );
        const page = await context.newPage();
        await page.goto("https://qoder.com/account/profile", { waitUntil: "domcontentloaded" });
        // Leave browser open for the user.
        return c.json({
          success: true,
          message: `Browser opened for ${account.email}`,
          cookiesInjected: qoderCookies.length,
        });

      } else {
        return c.json({
          error: `Open panel not supported for provider: ${account.provider}`,
        }, 400);
      }
    } catch (error) {
      return c.json({
        error: `Failed to open browser: ${error instanceof Error ? error.message : String(error)}`,
      }, 500);
    }
  });
}
