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

export async function exchangeCodexRefreshTokens(tokens: string[]) {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const refreshToken of tokens) {
    const trimmed = refreshToken.trim();
    if (!trimmed) { failed++; continue; }

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
        errors.push(`token ...${trimmed.slice(-8)}: refresh failed (${response.status}): ${text.slice(0, 100)}`);
        failed++;
        continue;
      }

      const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        expires_in?: number;
      };

      if (!data.access_token) {
        errors.push(`token ...${trimmed.slice(-8)}: no access_token in response`);
        failed++;
        continue;
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
      errors.push(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  pool.invalidate("codex" as ProviderName);
  if (success > 0) {
    broadcast({ type: "accounts_updated", data: { provider: "codex", count: success } });
  }

  return { success, failed, errors: errors.length > 0 ? errors : undefined };
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

    // All providers (including antigravity) now route through the TS+Camoufox
    // automation layer . The nodriver visible-frame manual-login
    // flow has been removed; the stealth engine surfaces challenges as a `manual`
    // result via the standard loginAccount path.
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

  const CODEX_ISSUER = "https://auth.openai.com";
  const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
  const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
  const CODEX_SCOPE = "openid profile email offline_access";


  async function upsertCodexAccount(email: string, tokens: Record<string, unknown>) {
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




  async function handleCodexInstantLogin(c: any, tokens: string[]) {
    const result = await exchangeCodexRefreshTokens(tokens);
    return c.json(result);
  }

  /**
   * Bulk-import Grok accounts via refresh tokens (preferred) or access tokens.
   * Mirrors exchangeCodexRefreshTokens: exchange → upsert → invalidate → broadcast.
   *
   * - Refresh tokens (durable): exchanged at auth.x.ai for a fresh access token.
   *   Account stays alive; etteum auto-refreshes before the 6h expiry.
   * - Access tokens (JWT, "eyJ..."): stored as-is with no refresh capability.
   *   Will expire in ~6h — useful only for quick testing.
   */
  async function handleGrokInstantLogin(c: any, tokens: string[]) {
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) { failed++; continue; }

      try {
        let oauthTokens;
        let email = "";

        if (trimmed.startsWith("eyJ")) {
          // Looks like a JWT access token — bundle as-is (no refresh).
          oauthTokens = bundleFromAccessToken(trimmed);
          email = oauthTokens.sub ? `grok-${oauthTokens.sub.slice(0, 8)}@oauth` : `grok-${trimmed.slice(-8)}@token.local`;
        } else {
          // Treat as a refresh token — exchange for a fresh access token.
          oauthTokens = await exchangeRefreshToken(trimmed);
          email = oauthTokens.sub ? `grok-${oauthTokens.sub.slice(0, 8)}@oauth` : `grok-${trimmed.slice(-8)}@token.local`;
        }

        await upsertGrokOAuthAccount(email, oauthTokens);
        success++;
      } catch (err) {
        errors.push(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    pool.invalidate("grok" as ProviderName);
    if (success > 0) {
      broadcast({ type: "accounts_updated", data: { provider: "grok", count: success } });
    }

    return c.json({ success, failed, errors: errors.length > 0 ? errors : undefined });
  }

  /**
   * Upsert a Grok OAuth account. Dedupes by (provider, email); preserves existing id.
   * Tokens stored in the existing `accounts.tokens` JSON column (no migration).
   */
  async function upsertGrokOAuthAccount(email: string, oauthTokens: import("../../proxy/providers/grok/oauth").GrokOAuthTokens) {
    const existing = await db.select().from(accounts)
      .where(and(eq(accounts.provider, "grok"), eq(accounts.email, email)))
      .limit(1);

    const tokensBlob = {
      auth_method: "oauth" as const,
      access_token: oauthTokens.access_token,
      refresh_token: oauthTokens.refresh_token,
      expires_at: oauthTokens.expires_at,
      oidc_client_id: oauthTokens.oidc_client_id,
      sub: oauthTokens.sub,
    };

    if (existing.length > 0) {
      await db.update(accounts)
        .set({
          tokens: tokensBlob,
          status: "active",
          enabled: true,
          lastLoginAt: new Date(),
        })
        .where(eq(accounts.id, existing[0]!.id));
    } else {
      await db.insert(accounts).values({
        provider: "grok",
        email,
        // password is NOT NULL but unused for OAuth — store an encrypted sentinel
        // (never plaintext: legacy decrypt() of "oauth:no-password" yields binary
        // garbage that Bun rejects as an Authorization header value).
        password: encrypt("oauth:no-password"),
        status: "active",
        enabled: true,
        tokens: tokensBlob,
        metadata: { auth_method: "oauth", oidc_client_id: oauthTokens.oidc_client_id },
      });
    }
  }

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
      // Use nodriver to open a headed Chrome browser
      const nodriverMod = await import("nodriver");
      const browser = await nodriverMod.start({ headless: false });

      if (account.provider.startsWith("kiro")) {
        if (!tokens.refresh_token) {
          await browser.stop();
          return c.json({ error: "No refresh token available" }, 400);
        }

        // Refresh to get fresh access token
        const refreshResp = await fetch("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokens.refresh_token }),
        });

        if (!refreshResp.ok) {
          await browser.stop();
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

        // Set cookies via browser CDP
        const page = browser.pages[0] || await browser.get("about:blank");
        await page.send("Network.setCookie", {
          name: "AccessToken", value: accessToken || "", domain: "app.kiro.dev", path: "/",
        });
        await page.send("Network.setCookie", {
          name: "RefreshToken", value: tokens.refresh_token, domain: "app.kiro.dev", path: "/",
        });
        if (userId) {
          await page.send("Network.setCookie", {
            name: "UserId", value: userId, domain: "app.kiro.dev", path: "/",
          });
        }
        await page.send("Network.setCookie", {
          name: "Idp", value: "Google", domain: "app.kiro.dev", path: "/",
        });

        await page.navigate("https://app.kiro.dev/settings/account");
        return c.json({ success: true, message: `Browser opened for ${account.email}` });

      } else if (account.provider === "qoder") {
        const webCookie = tokens.web_cookie as string | undefined;
        if (!webCookie) {
          await browser.stop();
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
          await browser.stop();
          return c.json({ error: "No valid Qoder cookies found in web_cookie" }, 400);
        }

        const page = browser.pages[0] || await browser.get("about:blank");
        for (const cookie of qoderCookies) {
          await page.send("Network.setCookie", {
            name: cookie.name, value: cookie.value, domain: "qoder.com", path: "/",
          });
        }

        await page.navigate("https://qoder.com/account/profile");
        return c.json({
          success: true,
          message: `Browser opened for ${account.email}`,
          cookiesInjected: qoderCookies.length,
        });

      } else {
        await browser.stop();
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
