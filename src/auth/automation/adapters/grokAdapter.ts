/**
 * Grok provider adapter — implements the ProviderAdapter contract.
 *
 * Unlike the Kiro/Codex/CodeBuddy adapters which use OAuth + browser
 * automation, Grok accounts authenticate via SSO cookies (sso + sso-rw).
 * There is no OAuth refresh-token flow — the SSO cookie IS the credential.
 *
 * This adapter follows the Codex adapter pattern: it overrides
 * bootstrapSession to skip the browser (no Camoufox needed) and does
 * pure HTTP validation against grok.com's /rest/rate-limits endpoint.
 *
 * If the SSO cookie is expired (401/403), the account is marked expired and
 * the user must re-paste a fresh SSO cookie (manual re-auth via browser).
 */

import {
  ProviderAdapter,
  type NormalizedAccount,
  type AdapterSession,
  type AuthState,
  type AdapterTokens,
  type QuotaSnapshot,
  type EmitFn,
} from "../enowxaiAdapter";
import { GROK_ENDPOINTS } from "../../../proxy/providers/grok/protocol";

const GROK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class GrokAdapter extends ProviderAdapter {
  readonly name = "grok";
  // No browser engine needed — Grok uses SSO cookies, not browser login.
  override readonly engine = "camoufox" as const;
  override readonly headless = true;

  parseAccount(raw: { email?: string; password?: string; [k: string]: unknown }): NormalizedAccount {
    const meta = raw as Record<string, unknown>;
    const sso = meta.sso as string | undefined;
    const ssoRw = (meta.ssoRw as string | undefined) ?? sso;
    const apiKey = meta.apiKey as string | undefined;
    const tier = (meta.tier as string | undefined) ?? "basic";

    if (!sso) {
      throw new Error("Grok requires an SSO cookie (sso field). Paste the sso cookie value from your grok.com session.");
    }

    return {
      provider: "grok",
      identifier: (meta.email as string | undefined) ?? "grok-sso-account",
      secret: sso,
      meta: { sso, ssoRw, apiKey, tier },
    };
  }

  /**
   * Override bootstrapSession — Grok doesn't need a browser.
   * Return a minimal "session" object with no browser.
   */
  override async bootstrapSession(_account: NormalizedAccount, emit: EmitFn): Promise<AdapterSession> {
    emit({ type: "progress", provider: "grok", step: "browser_launch", message: "SSO cookie auth — no browser needed" });
    // Return a dummy session (no browser to close).
    return { browser: null as any };
  }

  async authenticate(account: NormalizedAccount, _session: AdapterSession, emit: EmitFn): Promise<AuthState> {
    const sso = account.meta?.sso as string | undefined;
    const ssoRw = (account.meta?.ssoRw as string | undefined) ?? sso;

    if (!sso) {
      throw new Error("No SSO cookie in account meta");
    }

    emit({ type: "progress", provider: "grok", step: "authenticate", message: "Validating SSO cookie against grok.com..." });

    const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
      method: "GET",
      headers: {
        "Cookie": `sso=${sso}; sso-rw=${ssoRw}`,
        "User-Agent": GROK_UA,
        "Accept": "application/json",
        "Referer": "https://grok.com/",
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`expired: SSO cookie invalid (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Authentication failed: HTTP ${response.status}`);
    }

    emit({ type: "progress", provider: "grok", step: "authenticated", message: "SSO cookie valid" });
    return { callbackUrl: undefined };
  }

  async fetchTokens(account: NormalizedAccount, _authState: AuthState, _session: AdapterSession, emit: EmitFn): Promise<AdapterTokens> {
    const sso = account.meta?.sso as string;
    const ssoRw = (account.meta?.ssoRw as string | undefined) ?? sso;
    const apiKey = account.meta?.apiKey as string | undefined;
    const tier = account.meta?.tier as string | undefined;

    emit({ type: "progress", provider: "grok", step: "tokens", message: "SSO cookies retrieved (long-lived, no refresh needed)" });

    return {
      access_token: sso,
      sso,
      ssoRw,
      ...(apiKey ? { apiKey } : {}),
      ...(tier ? { tier } : {}),
      ...(account.identifier ? { email: account.identifier } : {}),
    };
  }

  override async fetchQuota(account: NormalizedAccount, tokens: AdapterTokens, _session: AdapterSession, emit: EmitFn): Promise<QuotaSnapshot | null> {
    const sso = tokens.sso as string;
    const ssoRw = (tokens.ssoRw as string | undefined) ?? sso;

    try {
      const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
        method: "GET",
        headers: {
          "Cookie": `sso=${sso}; sso-rw=${ssoRw}`,
          "User-Agent": GROK_UA,
          "Accept": "application/json",
          "Referer": "https://grok.com/",
        },
      });

      if (!response.ok) {
        emit({ type: "progress", provider: "grok", step: "quota_skip", message: `Quota fetch failed: HTTP ${response.status}` });
        return null;
      }

      const data = await response.json() as any;

      // Normalize grok.com rate-limit response into QuotaSnapshot.
      // Grok returns per-mode quota: { remainingQueries, totalQueries, ... }
      const snapshot: QuotaSnapshot = {};
      if (data?.remainingQueries != null) snapshot.remaining = data.remainingQueries;
      if (data?.totalQueries != null) snapshot.limit = data.totalQueries;
      if (data?.remainingCredit != null) snapshot.remaining_credits = data.remainingCredit;
      if (data?.totalCredit != null) snapshot.total_credits = data.totalCredit;
      // Copy through any other fields.
      for (const [k, v] of Object.entries(data)) {
        if (!(k in snapshot)) snapshot[k] = v;
      }

      const remain = snapshot.remaining ?? snapshot.remaining_credits;
      const total = snapshot.limit ?? snapshot.total_credits;
      let msg = "Quota fetched";
      if (remain != null && total != null) msg = `Quota fetched: ${remain}/${total} remaining`;
      else if (remain != null) msg = `Quota fetched: ${remain} remaining`;
      emit({ type: "progress", provider: "grok", step: "quota", message: msg });

      return snapshot;
    } catch (e: any) {
      emit({ type: "progress", provider: "grok", step: "quota_skip", message: `Quota fetch skipped: ${e?.message || e}` });
      return null;
    }
  }

  override async cleanupSession(_session: AdapterSession): Promise<void> {
    // No browser session to tear down.
  }
}

export function createGrokAdapter(): GrokAdapter {
  return new GrokAdapter();
}