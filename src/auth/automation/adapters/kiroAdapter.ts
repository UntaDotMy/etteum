/**
 * Kiro provider adapter — 1:1 TS port of enowxai's
 * app/providers/kiro/_adapter.py + _google_oauth.py + _helpers.py.
 *
 * Implements the enowxai ProviderAdapter contract: stealth Google OAuth login
 * (via the Camoufox engine + googleAutomation stealth recipe), kiro:// callback
 * capture, token exchange, and quota fetch with token refresh.
 *
 * Emits the full browser-log event stream (init → browser_launch →
 * authenticated → tokens → quota, with manual_challenge for captchas).
 */
import crypto from "node:crypto";
import { ProviderAdapter, type NormalizedAccount, type AdapterSession, type AuthState, type AdapterTokens, type QuotaSnapshot, type EmitFn } from "../enowxaiAdapter";
import { runGoogleAccountAutomation, createKiroCallbackMonitor, type GoogleLoginResult } from "../googleAutomation";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KIRO_AUTH_BASE = "https://prod1.kiro.dev";
const KIRO_TOKEN_ENDPOINT = "https://prod1.kiro.dev/oauth2/token";
const KIRO_USAGE_ENDPOINT = "https://prod1.kiro.dev/ide/api/usage";
const KIRO_REFRESH_ENDPOINT = "https://prod1.kiro.dev/oauth2/token";
const KIRO_CLIENT_OS_POOL = "mac-arm64";
const KIRO_FALLBACK_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
];

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function extractCodeFromKiroUrl(url: string): string | null {
  if (!url.startsWith("kiro://")) return null;
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(url.slice(qIdx + 1));
  return params.get("code");
}

export class KiroAdapter extends ProviderAdapter {
  override readonly name = "kiro";
  override readonly engine = "camoufox" as const;

  override parseAccount(raw: { email?: string; password?: string }): NormalizedAccount {
    const email = String(raw.email || "").trim().toLowerCase();
    const password = String(raw.password || "");
    if (!email || !password) {
      throw new Error("kiro account requires email and password");
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw new Error(`kiro account has an invalid email: ${email}`);
    }
    return { provider: "kiro", identifier: email, secret: password };
  }

  override async authenticate(account: NormalizedAccount, session: AdapterSession, emit: EmitFn): Promise<AuthState> {
    const browser = session.browser;
    const context = await browser.newContext();
    const page = await context.newPage();
    // Stash for cleanup + later use.
    (session as any).context = context;
    (session as any).page = page;

    emit({ type: "progress", provider: "kiro", step: "navigate", message: "Opening Kiro login…" });
    await page.goto(`${KIRO_AUTH_BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // The stealth Google login (googleAutomation.ts) handles: click "Continue
    // with Google", humanized email/password typing, challenge detection, and
    // the kiro:// callback monitor.
    const loginResult: GoogleLoginResult = await runGoogleAccountAutomation(page, {
      email: account.identifier,
      password: account.secret,
      loginUrl: `${KIRO_AUTH_BASE}/login`,
      onManual: (reason) => {
        emit({ type: "manual_challenge", provider: "kiro", challengeType: "google_2fa", message: reason });
      },
    });

    if (!loginResult.success) {
      const err = new Error(loginResult.error || "Kiro Google login failed");
      if (loginResult.manual) (err as any).fatal = true;
      throw err;
    }

    // After Google approval, Kiro redirects to kiro://kiro.kiroAgent/authenticate-success?code=...
    emit({ type: "progress", provider: "kiro", step: "await_callback", message: "Awaiting Kiro OAuth callback…" });
    const callback = await createKiroCallbackMonitor(page, { timeoutMs: 90_000 });
    if (!callback) {
      throw new Error("Kiro callback (kiro://) not received after Google login");
    }

    emit({ type: "progress", provider: "kiro", step: "authenticated", message: "Google login + Kiro callback complete" });
    return { callbackUrl: callback.callbackUrl, code: callback.code, state: callback.state ?? undefined };
  }

  override async fetchTokens(account: NormalizedAccount, authState: AuthState, session: AdapterSession, emit: EmitFn): Promise<AdapterTokens> {
    const { verifier } = generatePkcePair();
    const userAgent = KIRO_FALLBACK_USER_AGENTS[Math.floor(Math.random() * KIRO_FALLBACK_USER_AGENTS.length)] || KIRO_FALLBACK_USER_AGENTS[0]!;

    emit({ type: "progress", provider: "kiro", step: "token_exchange", message: "Exchanging OAuth code for tokens…" });
    const res = await fetch(KIRO_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify({
        grantType: "authorization_code",
        code: authState.code,
        redirectUri: "kiro://kiro.kiroAgent/authenticate-success",
        codeVerifier: verifier,
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann", // shared Kiro client id
        clientOS: KIRO_CLIENT_OS_POOL,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`kiro token endpoint rejected request (${res.status}): ${body.slice(0, 120)}`);
    }

    const j = (await res.json()) as any;
    return {
      access_token: j.accessToken || j.access_token,
      refresh_token: j.refreshToken || j.refresh_token,
      id_token: j.idToken || j.id_token,
      profile_arn: j.profileArn || j.profile_arn,
      expires_at: j.expiresIn ? Date.now() + j.expiresIn * 1000 : undefined,
    };
  }

  override async fetchQuota(account: NormalizedAccount, tokens: AdapterTokens, session: AdapterSession, emit: EmitFn): Promise<QuotaSnapshot | null> {
    const accessToken = String(tokens.access_token || "").trim();
    if (!accessToken || accessToken.startsWith("stub-")) return { limit: 0, remaining: 0 };
    const profileArn = String((tokens as any).profile_arn || "").trim();
    const usageUrl = profileArn ? `${KIRO_USAGE_ENDPOINT}?profileArn=${encodeURIComponent(profileArn)}` : KIRO_USAGE_ENDPOINT;
    const userAgent = KIRO_FALLBACK_USER_AGENTS[Math.floor(Math.random() * KIRO_FALLBACK_USER_AGENTS.length)] || KIRO_FALLBACK_USER_AGENTS[0]!;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(usageUrl, {
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": userAgent },
        });
        if (res.status === 200) {
          const payload = await res.json();
          return parseKiroUsagePayload(payload);
        }
        if ((res.status === 401 || res.status === 403) && attempt === 0) {
          // Try a token refresh, then retry once.
          const refreshed = await refreshKiroAccessToken(tokens);
          if (refreshed) continue;
          return null;
        }
        // Non-retryable — quota fetch is best-effort.
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Refresh a Kiro access token in place. Returns true on success. */
async function refreshKiroAccessToken(tokens: AdapterTokens): Promise<boolean> {
  const refreshToken = String(tokens.refresh_token || "").trim();
  if (!refreshToken) return false;
  try {
    const res = await fetch(KIRO_REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        refreshToken,
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      }),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as any;
    tokens.access_token = j.accessToken || j.access_token || tokens.access_token;
    if (j.refreshToken || j.refresh_token) tokens.refresh_token = j.refreshToken || j.refresh_token;
    if (j.expiresIn) tokens.expires_at = Date.now() + j.expiresIn * 1000;
    return true;
  } catch {
    return false;
  }
}

/** Parse the Kiro usage payload into a QuotaSnapshot (1:1 with enowxai). */
function parseKiroUsagePayload(payload: any): QuotaSnapshot {
  // Kiro's usage API returns a free-credit bucket + a per-account capacity.
  const free = payload?.freeCredits ?? payload?.free_credits ?? {};
  const capacity = payload?.accountCapacity ?? payload?.account_capacity ?? payload?.capacity ?? {};
  const remaining = Number(free.remaining ?? free.remainingCredits ?? capacity.remain ?? capacity.remaining ?? 0);
  const total = Number(free.total ?? capacity.size ?? capacity.total ?? 0);
  return {
    remaining_credits: remaining,
    total_credits: total,
    credit_capacity_remain: Number(capacity.remain ?? capacity.remaining ?? 0),
    credit_capacity_size: Number(capacity.size ?? capacity.total ?? 0),
    credit_total_dosage: Number(payload?.totalDosage ?? payload?.total_dosage ?? 0),
  };
}

export function createKiroAdapter(): KiroAdapter {
  return new KiroAdapter();
}
