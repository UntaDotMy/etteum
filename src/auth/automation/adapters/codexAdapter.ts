/**
 * Codex (OpenAI) provider adapter — 1:1 TS port of the reference automation
 * design's codex_login.py.
 *
 * Pure OAuth authorization-code flow (no browser automation — opens the user's
 * default browser + a local callback server). Follows the ProviderAdapter
 * contract, emitting the browser-log stream.
 */
import { ProviderAdapter, type NormalizedAccount, type AdapterSession, type AuthState, type AdapterTokens, type QuotaSnapshot, type EmitFn } from "../providerAdapter";
import { runAuthorizationCodeFlow, type TokenSet } from "../oauthService";
import { PROVIDER_OAUTH, PROVIDERS } from "../constants";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export class CodexAdapter extends ProviderAdapter {
  override readonly name = "codex";
  // Codex is a pure OAuth flow — no Camoufox browser needed.
  override readonly engine = "chromium" as const;

  override parseAccount(raw: { email?: string; password?: string }): NormalizedAccount {
    const email = String(raw.email || "").trim().toLowerCase();
    if (!email) throw new Error("codex account requires an email");
    return { provider: "codex", identifier: email, secret: String(raw.password || "") };
  }

  override async bootstrapSession(account: NormalizedAccount, emit: EmitFn): Promise<AdapterSession> {
    // No browser session for codex — return a stub. The OAuth flow opens the
    // user's default browser directly.
    return { browser: null as any };
  }

  override async authenticate(account: NormalizedAccount, session: AdapterSession, emit: EmitFn): Promise<AuthState> {
    emit({ type: "progress", provider: "codex", step: "starting", message: "Starting Codex OAuth login..." });
    const config = PROVIDER_OAUTH[PROVIDERS.CODEX];
    if (!config) throw new Error("Codex OAuth config missing");
    // runAuthorizationCodeFlow opens the browser + runs the local callback
    // server + exchanges the code. 1:1 with the reference codex_login.py main().
    const result = await runAuthorizationCodeFlow(config, { headless: false });
    emit({ type: "progress", provider: "codex", step: "authenticated", message: "Codex OAuth authorized" });
    return {
      code: result.accountInfo ? undefined : undefined, // tokens fetched in fetchTokens
      email: result.email,
      accountInfo: result.accountInfo,
      _tokens: result.tokens, // carry through to fetchTokens
    } as AuthState & { _tokens: TokenSet };
  }

  override async fetchTokens(account: NormalizedAccount, authState: AuthState, session: AdapterSession, emit: EmitFn): Promise<AdapterTokens> {
    const tokens = (authState as any)._tokens as TokenSet;
    if (!tokens?.accessToken) throw new Error("Codex token exchange produced no access token");
    emit({ type: "progress", provider: "codex", step: "tokens", message: "Codex tokens obtained" });
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      id_token: tokens.idToken,
      expires_at: tokens.expiresAt,
      chatgpt_account_id: (authState.accountInfo as any)?.chatgptAccountId,
      chatgpt_plan_type: (authState.accountInfo as any)?.chatgptPlanType,
    };
  }

  override async fetchQuota(account: NormalizedAccount, tokens: AdapterTokens, session: AdapterSession, emit: EmitFn): Promise<QuotaSnapshot | null> {
    const accessToken = String(tokens.access_token || "").trim();
    if (!accessToken) return null;
    try {
      const res = await fetch(CODEX_USAGE_URL, {
        headers: { authorization: `Bearer ${accessToken}`, "user-agent": "Mozilla/5.0" },
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as any;
      // Codex wham/usage returns primary + secondary rate-limit windows.
      const primary = payload?.primary ?? {};
      const secondary = payload?.secondary ?? {};
      return {
        remaining: Number(primary.remaining ?? 0),
        limit: Number(primary.limit ?? primary.capacity ?? 0),
        remaining_credits: Number(primary.remaining ?? 0),
        total_credits: Number(primary.limit ?? primary.capacity ?? 0),
        credit_capacity_remain: Number(secondary.remaining ?? primary.remaining ?? 0),
        credit_capacity_size: Number(secondary.limit ?? secondary.capacity ?? 0),
      };
    } catch {
      return null;
    }
  }

  override async cleanupSession(session: AdapterSession): Promise<void> {
    // No browser to close.
  }
}

export function createCodexAdapter(): CodexAdapter {
  return new CodexAdapter();
}
