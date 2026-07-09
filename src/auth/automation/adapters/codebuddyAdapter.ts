/**
 * CodeBuddy provider adapter — faithful TS reconstruction from enowxai's
 * readable companion files (codebuddy/_config.py + _api.py + _google_oauth.py
 * + _page_helpers.py + _utils.py). The single obfuscated file (_adapter.py) is
 * orchestration glue; the actual protocol/endpoints/selectors are all in the
 * readable companions ported here.
 *
 * Flow (1:1 with enowxai):
 *   Google login → region select (SG) → trial activate → console-login-enterprise
 *   (exchange state → accessToken) → create API key → fetch credits
 *
 * Emits the browser-log stream throughout.
 */
import { ProviderAdapter, type NormalizedAccount, type AdapterSession, type AuthState, type AdapterTokens, type QuotaSnapshot, type EmitFn } from "../enowxaiAdapter";
import {
  GOOGLE_EMAIL_SELECTORS,
  GOOGLE_PASSWORD_SELECTORS,
  GOOGLE_NEXT_BUTTON_SELECTORS,
  clickFirstVisible,
  waitForFirstVisibleLocator,
  fillInputResilient,
} from "../googleAutomation";
import {
  handleCodebuddyLanding,
  handleCodebuddyRegionSelect,
  captureCodebuddyState,
  detectGoogleBlockingChallenge,
  handleGoogleSomethingWentWrong,
  handleGoogleGaplustos,
  handleGoogleConsentContinue,
} from "./codebuddyPages";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODEBUDDY_BASE_URL = "https://www.codebuddy.ai";
const CODEBUDDY_PLATFORM = "IDE";
const CODEBUDDY_REDIRECT_SCHEME = "codebuddy://";

const CODEBUDDY_LOGIN_URL = `${CODEBUDDY_BASE_URL}/login`;
const CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/login/enterprise`;
const CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/login/account`;
const CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/accounts`;
const CODEBUDDY_USER_RESOURCE_ENDPOINT = `${CODEBUDDY_BASE_URL}/billing/meter/get-user-resource`;
const CODEBUDDY_API_KEYS_ENDPOINT = `${CODEBUDDY_BASE_URL}/console/api/client/v1/api-keys`;

const WEB_HEADERS: Record<string, string> = {
  "Accept": "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  "X-Domain": "www.codebuddy.ai",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};

function randName(): string {
  return `enowx-${Math.floor(100000 + Math.random() * 900000)}`;
}

export class CodeBuddyAdapter extends ProviderAdapter {
  override readonly name = "codebuddy";
  override readonly engine = "camoufox" as const;

  override parseAccount(raw: { email?: string; password?: string }): NormalizedAccount {
    const email = String(raw.email || "").trim().toLowerCase();
    const password = String(raw.password || "");
    if (!email || !password) throw new Error("codebuddy account requires email and password");
    if (!EMAIL_PATTERN.test(email)) throw new Error(`codebuddy account has an invalid email: ${email}`);
    return { provider: "codebuddy", identifier: email, secret: password };
  }

  override async bootstrapSession(account: NormalizedAccount, emit: EmitFn): Promise<AdapterSession> {
    // CodeBuddy needs a visible-ish context for the Google login + page-fetch
    // calls. The base bootstrapSession returns {browser}; we add a context + page.
    const session = await super.bootstrapSession(account, emit);
    const context = await session.browser.newContext();
    const page = await context.newPage();
    (session as any).context = context;
    (session as any).page = page;
    return session;
  }

  override async authenticate(account: NormalizedAccount, session: AdapterSession, emit: EmitFn): Promise<AuthState> {
    const page = (session as any).page;

    emit({ type: "progress", provider: "codebuddy", step: "navigate", message: "Opening CodeBuddy login…" });
    await page.goto(CODEBUDDY_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 1. Handle the CodeBuddy landing: terms checkbox + "Continue with Google".
    //    This is iframe-aware (login-iframe) — the real enowxai behavior.
    emit({ type: "progress", provider: "codebuddy", step: "landing", message: "Handling CodeBuddy landing (terms + Google)…" });
    let landed = await handleCodebuddyLanding(page);
    if (!landed) {
      // Retry once after a short dwell — the iframe can mount late.
      await sleep(1500);
      landed = await handleCodebuddyLanding(page);
    }
    if (!landed) {
      throw new Error("Could not find CodeBuddy login iframe or 'Continue with Google' button");
    }

    // 2. Google login + interstitial recovery loop. We drive the Google account
    //    flow directly (it has launched into accounts.google.com by now), with
    //    recovery for "something went wrong", gaplustos, and consent pages, plus
    //    blocking-challenge detection (captcha / 2FA → manual signal).
    emit({ type: "progress", provider: "codebuddy", step: "google_login", message: "Stealth Google login…" });
    await this.runGoogleLoginWithRecovery(page, account, emit);

    // 3. Region select (Singapore) — the /register/user/complete page.
    emit({ type: "progress", provider: "codebuddy", step: "region", message: "Setting region (Singapore)…" });
    await handleCodebuddyRegionSelect(page);

    // 4. Trial activation.
    emit({ type: "progress", provider: "codebuddy", step: "trial", message: "Activating trial…" });
    await this.activateTrial(page, emit);

    // 5. Capture the OAuth state from the /started redirect (codebuddy:// callback).
    emit({ type: "progress", provider: "codebuddy", step: "await_callback", message: "Awaiting CodeBuddy OAuth callback…" });
    const state = await captureCodebuddyState(page, 60_000);
    if (!state) throw new Error("CodeBuddy callback (codebuddy://) not received");

    emit({ type: "progress", provider: "codebuddy", step: "authenticated", message: "CodeBuddy login complete" });
    return { state, callbackUrl: state };
  }

  /**
   * Drive the Google account login with an interstitial-recovery loop. Handles:
   *   - "Something went wrong" → restart
   *   - gaplustos speedbump → confirm
   *   - consent/continue → approve
   *   - blocking challenge (captcha/2FA) → emit manual signal, fatal-stop
   * Types email/password humanized via the shared googleAutomation helpers.
   */
  private async runGoogleLoginWithRecovery(page: any, account: NormalizedAccount, emit: EmitFn): Promise<void> {
    const deadline = Date.now() + 5 * 60_000;
    let emailed = false;
    let passworded = false;

    while (Date.now() < deadline) {
      // Blocking challenge → surface manual, stop.
      const challenge = await detectGoogleBlockingChallenge(page);
      if (challenge) {
        emit({ type: "manual_challenge", provider: "codebuddy", challengeType: "google_2fa", message: `Google blocking challenge: ${challenge}` });
        const e = new Error(`Google blocking challenge: ${challenge}`);
        (e as any).fatal = true;
        throw e;
      }

      // Recovery handlers (no-op if not on those pages).
      if (await handleGoogleSomethingWentWrong(page)) { await sleep(1500); continue; }
      if (await handleGoogleGaplustos(page)) { await sleep(1500); continue; }
      if (await handleGoogleConsentContinue(page)) { await sleep(1500); continue; }

      // Email step.
      if (!emailed) {
        const emailLoc = await waitForFirstVisibleLocator(page, GOOGLE_EMAIL_SELECTORS.join(", "), { timeout: 8_000 });
        if (emailLoc) {
          const ok = await fillInputResilient(emailLoc, account.identifier);
          if (ok) {
            await sleep(400 + Math.floor(Math.random() * 500));
            await clickFirstVisible(page, GOOGLE_NEXT_BUTTON_SELECTORS);
            await sleep(1500);
            emailed = true;
            continue;
          }
        }
      }

      // Password step.
      if (emailed && !passworded) {
        const pwLoc = await waitForFirstVisibleLocator(page, GOOGLE_PASSWORD_SELECTORS.join(", "), { timeout: 8_000 });
        if (pwLoc) {
          const ok = await fillInputResilient(pwLoc, account.secret);
          if (ok) {
            await sleep(400 + Math.floor(Math.random() * 500));
            await clickFirstVisible(page, GOOGLE_NEXT_BUTTON_SELECTORS);
            await sleep(2000);
            passworded = true;
            continue;
          }
        }
      }

      // If we've typed password and we're no longer on accounts.google.com,
      // the Google flow is done.
      if (passworded) {
        const url = String(page.url() || "");
        if (!url.includes("accounts.google.com")) return;
      }

      await sleep(1000);
    }
    throw new Error("Google login timed out");
  }

  override async fetchTokens(account: NormalizedAccount, authState: AuthState, session: AdapterSession, emit: EmitFn): Promise<AdapterTokens> {
    const page = (session as any).page;
    emit({ type: "progress", provider: "codebuddy", step: "token_exchange", message: "Exchanging state for accessToken…" });
    // console-login-enterprise: POST /console/login/enterprise?state=... → accessToken.
    const result = await pageEvaluate(page, async ({ url, state }) => {
      const resp = await fetch(`${url}?state=${encodeURIComponent(state)}`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" },
      });
      const text = await resp.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      return { status: resp.status, json };
    }, { url: CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE_ENDPOINT, state: authState.state });

    if (result.status !== 200 || result.json?.code !== 0) {
      throw new Error(`codebuddy console-login-enterprise failed (${result.status})`);
    }
    const accessToken = String(result.json?.data?.accessToken || "");
    if (!accessToken) throw new Error("codebuddy console-login-enterprise returned no accessToken");

    // Create an API key (the durable credential we store).
    emit({ type: "progress", provider: "codebuddy", step: "create_api_key", message: "Creating API key…" });
    const keyResult = await pageEvaluate(page, async ({ url, body }) => {
      const resp = await fetch(url, {
        method: "POST", credentials: "include",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      return { status: resp.status, json };
    }, { url: CODEBUDDY_API_KEYS_ENDPOINT, body: { name: randName(), expire_in_days: -1, user_enterprise_id: "personal-edition-user-id" } });

    const apiKey = keyResult.json?.data?.key ? String(keyResult.json.data.key) : "";
    emit({ type: "progress", provider: "codebuddy", step: "tokens", message: "Tokens + API key obtained" });
    return { access_token: apiKey || accessToken, refresh_token: accessToken, id_token: undefined };
  }

  override async fetchQuota(account: NormalizedAccount, tokens: AdapterTokens, session: AdapterSession, emit: EmitFn): Promise<QuotaSnapshot | null> {
    const page = (session as any).page;
    if (!page) return null;
    // Fetch user-resource credit via the logged-in page (mirrors _fetch_user_resource_credit_via_page).
    const now = new Date();
    const body = {
      PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3],
      PackageEndTimeRangeBegin: now.toISOString().replace("T", " ").slice(0, 19),
      PackageEndTimeRangeEnd: new Date(now.getTime() + 365 * 20 * 86400000).toISOString().replace("T", " ").slice(0, 19),
    };
    const result = await pageEvaluate(page, async ({ url, body }) => {
      const resp = await fetch(url, {
        method: "POST", credentials: "include",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      return { status: resp.status, json };
    }, { url: CODEBUDDY_USER_RESOURCE_ENDPOINT, body });

    if (result.status !== 200 || result.json?.code !== 0) return null;
    return creditFromResourcePayload(result.json);
  }

  // --- Helpers (1:1 with enowxai _api.py) ---
  private async activateTrial(page: any, emit: EmitFn): Promise<boolean> {
    const result = await pageEvaluate(page, async (url) => {
      const resp = await fetch(url, { method: "POST", credentials: "include", headers: { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" } });
      const text = await resp.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      return { status: resp.status, json };
    }, `${CODEBUDDY_BASE_URL}/billing/ide/trial`);
    return result.status === 200;
  }
}

/** Run a function in the page context (mirrors page.evaluate in enowxai). */
async function pageEvaluate(page: any, fn: (arg: any) => any, arg?: any): Promise<any> {
  if (!page?.evaluate) return { status: 0, json: null };
  try {
    return await page.evaluate(fn, arg);
  } catch {
    return { status: 0, json: null };
  }
}

/** Parse the user-resource payload into a QuotaSnapshot (1:1 with _credit_from_resource_payload). */
function creditFromResourcePayload(payload: any): QuotaSnapshot | null {
  if (payload?.code !== 0) return null;
  const data = payload?.data?.Response?.Data ?? {};
  const totalDosage = Number(data.TotalDosage || 0);
  const accounts = data.Accounts || [];
  let remain = 0, used = 0, size = 0;
  for (const a of accounts) {
    remain += Number(a.CapacityRemain || 0);
    used += Number(a.CapacityUsed || 0);
    size += Number(a.CapacitySize || 0);
  }
  return {
    credit_total_dosage: totalDosage,
    credit_capacity_remain: totalDosage > remain ? totalDosage : remain,
    credit_capacity_used: used,
    credit_capacity_size: totalDosage > size ? totalDosage : size,
    remaining_credits: totalDosage > remain ? totalDosage : remain,
    total_credits: totalDosage > size ? totalDosage : size,
  };
}

export function createCodeBuddyAdapter(): CodeBuddyAdapter {
  return new CodeBuddyAdapter();
}
