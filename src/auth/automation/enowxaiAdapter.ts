/**
 * enowxai ProviderAdapter contract — 1:1 TS port of enowxai's
 * app/providers/base.py + login.py driver architecture.
 *
 * This is the automation architecture the user directed us to follow 1:1:
 *   ProviderAdapter contract: parse_account → bootstrap_session (Camoufox)
 *     → authenticate → fetch_tokens → fetch_quota → cleanup_session → build_result
 *   run_provider driver: retry/backoff + emit() line-JSON events
 *     (init → browser_launch → authenticated → tokens → quota)
 *
 * The emit() protocol IS the browser-log stream: events are {type:"progress",
 * provider, step, message} plus {type:"manual_challenge", ...} for captcha
 * round-trips and {type:"error"/"result", ...}. Our runner.ts already parses
 * this line-JSON shape.
 */
import type { Browser } from "playwright";
import { launchBrowser, type BrowserEngine } from "./engine";

/** A normalized account credential (mirrors enowxai NormalizedAccount). */
export interface NormalizedAccount {
  provider: string;
  identifier: string; // email
  secret: string; // password
  /** Extra provider-specific fields (tokens, region, phone, etc). */
  meta?: Record<string, unknown>;
}

/** Quota snapshot returned by fetch_quota. */
export interface QuotaSnapshot {
  remaining_credits?: number;
  total_credits?: number;
  remaining?: number;
  limit?: number;
  credit_capacity_remain?: number;
  credit_capacity_size?: number;
  credit_total_dosage?: number;
  gift_claimed?: boolean;
  gift_credits?: number;
  [key: string]: unknown;
}

/** Tokens returned by fetch_tokens. */
export interface AdapterTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number;
  [key: string]: unknown;
}

/** A browser session bootstrapped by the adapter (Camoufox). */
export interface AdapterSession {
  browser: Browser;
  /** Provider-specific session state (page, context, cookies, etc). */
  [key: string]: unknown;
}

/** Result of authenticate(). */
export interface AuthState {
  /** The OAuth callback URL/code captured after Google approval. */
  callbackUrl?: string;
  code?: string;
  state?: string;
  [key: string]: unknown;
}

/** A browser-log event emitted during a login (the emit() protocol). */
export type AutomationEvent =
  | { type: "progress"; provider: string; step: string; message: string }
  | { type: "manual_challenge"; provider: string; challengeType: string; message: string; imageData?: string }
  | { type: "error"; provider: string; error: string; fatal?: boolean }
  | { type: "result"; provider: string; success: boolean; credentials?: AdapterTokens; quota?: QuotaSnapshot | null; email?: string; error?: string };

/** Emit callback — the driver passes this in; the adapter calls it to stream events. */
export type EmitFn = (event: AutomationEvent) => void;

/**
 * The ProviderAdapter contract — 1:1 with enowxai's app/providers/base.py.
 * Each provider implements these methods; run_provider() drives them.
 */
export abstract class ProviderAdapter {
  abstract readonly name: string;
  /** Which browser engine this provider needs (camoufox for Google-login providers). */
  readonly engine: BrowserEngine = "camoufox";
  readonly headless: boolean = true;
  /** Optional proxy URL for the browser session. */
  proxyUrl?: string;

  /** Validate + normalize the account credential. Throws on invalid. */
  abstract parseAccount(raw: { email?: string; password?: string; [k: string]: unknown }): NormalizedAccount;

  /** Launch a Camoufox browser session. */
  async bootstrapSession(account: NormalizedAccount, emit: EmitFn): Promise<AdapterSession> {
    const browser = await launchBrowser({
      engine: this.engine,
      headless: this.headless,
      proxyUrl: this.proxyUrl,
      stealthSeed: hashSeed(account.identifier),
    });
    return { browser };
  }

  /** Run the provider's login flow (e.g. stealth Google OAuth). Returns auth state. */
  abstract authenticate(account: NormalizedAccount, session: AdapterSession, emit: EmitFn): Promise<AuthState>;

  /** Exchange the auth state for tokens. */
  abstract fetchTokens(account: NormalizedAccount, authState: AuthState, session: AdapterSession, emit: EmitFn): Promise<AdapterTokens>;

  /** Fetch the account's quota/usage (best-effort — failures are non-fatal). */
  async fetchQuota(account: NormalizedAccount, tokens: AdapterTokens, session: AdapterSession, emit: EmitFn): Promise<QuotaSnapshot | null> {
    return null;
  }

  /** Tear down the browser session. */
  async cleanupSession(session: AdapterSession): Promise<void> {
    try { await session.browser.close(); } catch { /* noop */ }
  }

  /** Compose the final result object (mirrors enowxai build_result). */
  buildResult(account: NormalizedAccount, tokens: AdapterTokens, quota: QuotaSnapshot | null): { success: true; provider: string; credentials: AdapterTokens; quota: QuotaSnapshot | null; email: string } {
    return { success: true, provider: this.name, credentials: tokens, quota, email: account.identifier };
  }
}

/** Deterministic seed from an identifier (for stable stealth profiles). */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

// --- run_provider driver (1:1 with enowxai login.py) ---
const BASE_DELAY = 2; // seconds
const MAX_DELAY = 60;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 10 * 60; // 10 min per attempt

function retryDelay(attempt: number): number {
  return Math.min(BASE_DELAY * (2 ** attempt), MAX_DELAY);
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Run a single login attempt through the full adapter contract. */
async function runProviderOnce(adapter: ProviderAdapter, account: NormalizedAccount, emit: EmitFn): Promise<{ success: true; provider: string; credentials: AdapterTokens; quota: QuotaSnapshot | null; email: string }> {
  let session: AdapterSession | null = null;
  try {
    session = await adapter.bootstrapSession(account, emit);
    emit({ type: "progress", provider: adapter.name, step: "browser_launch", message: "Browser session ready" });

    const authState = await adapter.authenticate(account, session, emit);
    emit({ type: "progress", provider: adapter.name, step: "authenticated", message: "Authenticated" });

    const tokens = await adapter.fetchTokens(account, authState, session, emit);
    emit({ type: "progress", provider: adapter.name, step: "tokens", message: "Tokens obtained" });

    let quota: QuotaSnapshot | null = null;
    try {
      quota = await adapter.fetchQuota(account, tokens, session, emit);
      let quotaMsg = "Quota fetched";
      if (quota) {
        if (quota.gift_claimed) {
          emit({ type: "progress", provider: adapter.name, step: "claim", message: `VIP bonus claimed: +${Math.floor(Number(quota.gift_credits || 0))} credits` });
        }
        const remain = quota.remaining_credits ?? quota.remaining ?? quota.credit_capacity_remain;
        const total = quota.total_credits ?? quota.limit ?? quota.credit_capacity_size ?? quota.credit_total_dosage;
        if (remain != null && total != null) quotaMsg = `Quota fetched: ${Number(remain).toFixed(0)}/${Number(total).toFixed(0)} credits remaining`;
        else if (total != null) quotaMsg = `Quota fetched: ${Number(total).toFixed(0)} credits total`;
        else if (remain != null) quotaMsg = `Quota fetched: ${Number(remain).toFixed(0)} credits remaining`;
      }
      emit({ type: "progress", provider: adapter.name, step: "quota", message: quotaMsg });
    } catch (e: any) {
      emit({ type: "progress", provider: adapter.name, step: "quota_skip", message: `Quota fetch skipped: ${e?.message || e}` });
    }

    return adapter.buildResult(account, tokens, quota);
  } finally {
    if (session) {
      try { await adapter.cleanupSession(session); } catch { /* noop */ }
    }
  }
}

/**
 * Run a provider login with retry/backoff, emitting browser-log events.
 * 1:1 with enowxai's run_provider(). The emit() stream is the automation +
 * browser log the dashboard renders.
 */
export async function runProvider(
  adapter: ProviderAdapter,
  account: NormalizedAccount,
  emit: EmitFn,
  opts: { maxRetries?: number; timeoutMs?: number } = {},
): Promise<{ success: true; provider: string; credentials: AdapterTokens; quota: QuotaSnapshot | null; email: string } | { success: false; provider: string; error: string }> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT * 1000;
  let lastError = "";

  emit({ type: "progress", provider: adapter.name, step: "init", message: "Initializing..." });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await withTimeout(() => runProviderOnce(adapter, account, emit), timeoutMs);
      emit({ type: "result", provider: adapter.name, success: true, credentials: result.credentials, quota: result.quota, email: result.email });
      return result;
    } catch (e: any) {
      lastError = e?.message || String(e);
      // A manual_challenge that timed out or a fatal error — stop retrying.
      const fatal = e?.fatal || /manual|captcha|invalid credential|restricted|banned/i.test(lastError);
      emit({ type: "error", provider: adapter.name, error: lastError, fatal });
      if (fatal || attempt === maxRetries - 1) break;
      const delay = retryDelay(attempt);
      emit({ type: "progress", provider: adapter.name, step: "retry", message: `Retry ${attempt + 1}/${maxRetries} in ${delay}s: ${lastError}` });
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }

  emit({ type: "result", provider: adapter.name, success: false, error: lastError });
  return { success: false, provider: adapter.name, error: lastError };
}
