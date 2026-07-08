/**
 * CodeBuddy provider adapter — faithful TS reconstruction from the reference
 * automation design's readable companion files (codebuddy/_config.py + _api.py
 * + _google_oauth.py + _page_helpers.py + _utils.py). The single obfuscated file
 * (_adapter.py) is orchestration glue; the actual protocol/endpoints/selectors
 * are all in the readable companions ported here.
 *
 * Flow (1:1 with the reference design):
 *   Google login → region select (SG) → trial activate → console-login-enterprise
 *   (exchange state → accessToken) → create API key → fetch credits
 *
 * Emits the browser-log stream throughout.
 */
import { ProviderAdapter, type NormalizedAccount, type AdapterSession, type AuthState, type AdapterTokens, type QuotaSnapshot, type EmitFn } from "../providerAdapter";
import { runGoogleAccountAutomation } from "../googleAutomation";

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
  return `cb-key-${Math.floor(100000 + Math.random() * 900000)}`;
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

  override async authenticate(account: NormalizedAccount, session: AdapterSession, emit: EmitFn): Promise<AuthState> {
    const page = await session.browser.newPage().then((p) => p).catch(async () => {
      const ctx = await session.browser.newContext();
      return ctx.newPage();
    });
    (session as any).page = page;

    emit({ type: "progress", provider: "codebuddy", step: "navigate", message: "Opening CodeBuddy login…" });
    await page.goto(CODEBUDDY_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Stealth Google login via the shared googleAutomation recipe.
    emit({ type: "progress", provider: "codebuddy", step: "google_login", message: "Stealth Google login…" });
    const loginResult = await runGoogleAccountAutomation(page, {
      email: account.identifier,
      password: account.secret,
      loginUrl: CODEBUDDY_LOGIN_URL,
      onManual: (reason) => emit({ type: "manual_challenge", provider: "codebuddy", challengeType: "google_2fa", message: reason }),
    });
    if (!loginResult.success) {
      const e = new Error(loginResult.error || "CodeBuddy Google login failed");
      if (loginResult.manual) (e as any).fatal = true;
      throw e;
    }

    // Region select (Singapore) + trial activation — mirrors _submit_region_via_page.
    emit({ type: "progress", provider: "codebuddy", step: "region", message: "Setting region (Singapore)…" });
    await this.submitRegion(page, emit);
    emit({ type: "progress", provider: "codebuddy", step: "trial", message: "Activating trial…" });
    await this.activateTrial(page, emit);

    // Capture the OAuth state from the /started redirect (codebuddy:// callback).
    emit({ type: "progress", provider: "codebuddy", step: "await_callback", message: "Awaiting CodeBuddy OAuth callback…" });
    const state = await this.captureState(page, emit);
    if (!state) throw new Error("CodeBuddy callback (codebuddy://) not received");

    emit({ type: "progress", provider: "codebuddy", step: "authenticated", message: "CodeBuddy login complete" });
    return { state, callbackUrl: state };
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

  // --- Helpers (1:1 with the reference _api.py) ---
  private async submitRegion(page: any, emit: EmitFn): Promise<boolean> {
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
    }, { url: CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT, body: { attributes: { countryCode: ["65"], countryFullName: ["Singapore"], countryName: ["SG"] } } });
    return result.status === 200 && result.json?.code === 0;
  }

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

  private async captureState(page: any, emit: EmitFn): Promise<string | null> {
    // Navigate to /started and wait for the codebuddy:// redirect carrying ?state=.
    try {
      await page.goto(`${CODEBUDDY_BASE_URL}/started`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch { /* may redirect immediately */ }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const url: string = String(page.url() || "");
      if (url.startsWith(CODEBUDDY_REDIRECT_SCHEME) || url.includes("codebuddy://")) {
        const q = url.indexOf("?");
        if (q >= 0) {
          const params = new URLSearchParams(url.slice(q + 1));
          return params.get("state");
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }
}

/** Run a function in the page context (mirrors page.evaluate in the reference). */
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
