/**
 * Per-provider automation services — TS port of the reference proxy's
 * src/lib/oauth/services/*.js, consolidated into one registry.
 *
 * Each entry wires a provider's login to the right mechanism:
 *   - Google-OAuth providers (kiro, antigravity) → Camoufox + runKiroGoogleAutomation
 *   - OAuth code/device providers (codex, codebuddy, github, qwen, ...) → oauthService flows
 *   - Import-token providers (cursor) → local SQLite token extraction
 *   - Cookie providers (iflow) → session cookie import
 *
 * Exports a SERVICES record keyed by provider id. Each value implements the
 * BulkImportAdapter contract from bulkImport.ts so the job framework can drive
 * any provider uniformly.
 */
import type { Browser } from "playwright";
import { PROVIDER_OAUTH, PROVIDERS, type ProviderId } from "./constants";
import { runAuthorizationCodeFlow, runDeviceCodeFlow, refreshAccessToken, type TokenSet } from "./oauthService";
import { launchBrowser, type BrowserEngine } from "./engine";
import { runGoogleAccountAutomation, runKiroGoogleAutomation, handleProviderOnboarding, handleCodeBuddyRegionPage } from "./googleAutomation";
import type { BulkImportAdapter, ImportCredential } from "./bulkImport";
import type { OAuthConfig } from "./constants";

/** Look up an OAuth config, throwing a clear error if missing. */
function cfg(id: string): OAuthConfig {
  const c = PROVIDER_OAUTH[id];
  if (!c) throw new Error(`No OAuth config for provider: ${id}`);
  return c;
}

export interface ProviderLoginResult {
  tokens?: TokenSet;
  email?: string;
  quota?: unknown;
  accountInfo?: Record<string, unknown>;
  error?: string;
}

export interface ProviderService {
  provider: string;
  engine: BrowserEngine;
  /** Run a headless browser login. Used by the bulk-import job framework. */
  login?: (credential: ImportCredential, ctx: { browser: Browser; signal: AbortSignal }) => Promise<ProviderLoginResult>;
  /** Run an OAuth flow without a browser (code/device grant). */
  oauthLogin?: (opts: { headless?: boolean }) => Promise<ProviderLoginResult>;
  /** Refresh an existing token. */
  refresh?: (refreshToken: string) => Promise<TokenSet>;
  /** Provider-specific login URL for browser automation. */
  loginUrl?: string;
  /** Optional captcha/2FA round-trip handler for bulk-import manual items. */
  handleManual?: (item: import("./bulkImport").ImportItem, answer: string) => Promise<void>;
}

const GOOGLE_LOGIN_URL = "https://accounts.google.com/o/oauth2/v2/auth";

async function runBrowserGoogleLogin(credential: ImportCredential, browser: Browser, loginUrl: string, useKiroCallback: boolean): Promise<ProviderLoginResult> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const result = useKiroCallback
      ? await runKiroGoogleAutomation(page, { email: credential.email, password: String(credential.password || ""), loginUrl })
      : await runGoogleAccountAutomation(page, { email: credential.email, password: String(credential.password || ""), loginUrl });
    if (!result.success) return { error: result.error };
    // Handle any post-login onboarding (terms, region, workspace).
    await handleProviderOnboarding(page).catch(() => null);
    await handleCodeBuddyRegionPage(page).catch(() => null);
    return { email: result.email, tokens: result.code ? { accessToken: result.code, idToken: result.code } : undefined };
  } finally {
    await context.close().catch(() => null);
  }
}

// --- Kiro: Google social login → kiro:// callback → token exchange ---
const kiroService: ProviderService = {
  provider: PROVIDERS.KIRO,
  engine: "camoufox",
  loginUrl: "https://prod1.kiro.dev/login",
  login: async (credential, { browser }) => runBrowserGoogleLogin(credential, browser, "https://prod1.kiro.dev/login", true),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.KIRO), refreshToken),
};

// --- Antigravity: Google OAuth → cloudcode-pa.googleapis.com token ---
const antigravityService: ProviderService = {
  provider: PROVIDERS.ANTIGRAVITY,
  engine: "camoufox",
  loginUrl: GOOGLE_LOGIN_URL,
  login: async (credential, { browser }) => runBrowserGoogleLogin(credential, browser, GOOGLE_LOGIN_URL, false),
  oauthLogin: async () => ({ ...(await runAuthorizationCodeFlow(cfg(PROVIDERS.ANTIGRAVITY))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.ANTIGRAVITY), refreshToken),
};

// --- Codex: authorization-code + PKCE (CLI flow) ---
const codexService: ProviderService = {
  provider: PROVIDERS.CODEX,
  engine: "chromium", // Codex is a pure OAuth flow — no Google login needed
  oauthLogin: async () => ({ ...(await runAuthorizationCodeFlow(cfg(PROVIDERS.CODEX))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.CODEX), refreshToken),
};

// --- Gemini CLI: Google authorization-code ---
const geminiService: ProviderService = {
  provider: PROVIDERS.GEMINI,
  engine: "camoufox",
  loginUrl: GOOGLE_LOGIN_URL,
  login: async (credential, { browser }) => runBrowserGoogleLogin(credential, browser, GOOGLE_LOGIN_URL, false),
  oauthLogin: async () => ({ ...(await runAuthorizationCodeFlow(cfg(PROVIDERS.GEMINI))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.GEMINI), refreshToken),
};

// --- CodeBuddy: device-code flow ---
const codebuddyService: ProviderService = {
  provider: PROVIDERS.CODEBUDDY,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runDeviceCodeFlow(cfg(PROVIDERS.CODEBUDDY))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.CODEBUDDY), refreshToken),
};

// --- CodeBuddy-CN: device-code + 5sim phone login (F5 phone-flow wiring) ---
const codebuddyCnService: ProviderService = {
  provider: PROVIDERS.CODEBUDDY_CN,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runDeviceCodeFlow(cfg(PROVIDERS.CODEBUDDY_CN))) }),
  // F5: phone-login flow — buys a 5sim number, enters it on codebuddy.cn, polls
  // the OTP, mints an API key. The credential carries the 5sim token + optional
  // country/product under extra fields. Falls back to device-code if no token.
  login: async (credential, ctx) => {
    const fiveSimToken = (credential as any).fiveSimToken || (credential as any).five_sim_token;
    if (!fiveSimToken) {
      // No 5sim token → fall back to device-code OAuth.
      return { ...(await runDeviceCodeFlow(cfg(PROVIDERS.CODEBUDDY_CN))) };
    }
    const { runCodeBuddyCnPhoneFlow } = await import("./codebuddy-cn-phone");
    const result = await runCodeBuddyCnPhoneFlow(ctx.browser, {
      token: fiveSimToken,
      country: (credential as any).country,
      product: (credential as any).product || "codebuddy",
    });
    if (result.error || !result.apiKey) {
      return { error: result.error || "Phone login failed" };
    }
    return {
      tokens: { api_key: result.apiKey, access_token: result.apiKey } as any,
      email: result.phone ? `phone-${result.phone}@codebuddy.cn` : `phone@codebuddy.cn`,
    };
  },
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.CODEBUDDY_CN), refreshToken),
};

// --- Qoder: device-code ---
const qoderService: ProviderService = {
  provider: PROVIDERS.QODER,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runDeviceCodeFlow(cfg(PROVIDERS.QODER))) }),
  // Qoder refresh 403s upstream — re-login required. No refresh.
};

// --- Qwen: device-code ---
const qwenService: ProviderService = {
  provider: PROVIDERS.QWEN,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runDeviceCodeFlow(cfg(PROVIDERS.QWEN))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.QWEN), refreshToken),
};

// --- GitHub: device-code ---
const githubService: ProviderService = {
  provider: PROVIDERS.GITHUB,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runDeviceCodeFlow(cfg(PROVIDERS.GITHUB))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.GITHUB), refreshToken),
};

// --- OpenAI: authorization-code ---
const openaiService: ProviderService = {
  provider: PROVIDERS.OPENAI,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runAuthorizationCodeFlow(cfg(PROVIDERS.OPENAI))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.OPENAI), refreshToken),
};

// --- iFlow: cookie-based import ---
const iflowService: ProviderService = {
  provider: PROVIDERS.IFLOW,
  engine: "camoufox",
  loginUrl: "https://iflow.cn/login",
  login: async (credential, { browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto("https://iflow.cn/login", { waitUntil: "domcontentloaded" });
      // iFlow uses session cookies — capture them after manual/login interaction.
      const cookies = await context.cookies();
      const sessionCookie = cookies.find((c) => c.name === "session" || c.name === "token");
      if (!sessionCookie) return { error: "No iFlow session cookie captured" };
      return { email: credential.email, tokens: { accessToken: sessionCookie.value } };
    } finally {
      await context.close().catch(() => null);
    }
  },
};

// --- Cursor: local SQLite token extraction (import-token flow) ---
const cursorService: ProviderService = {
  provider: PROVIDERS.CURSOR,
  engine: "chromium",
  login: async () => {
    // Cursor stores its auth token in a local SQLite DB. Read it directly.
    const cursorCfg = cfg(PROVIDERS.CURSOR);
    const paths = (cursorCfg.tokenStoragePaths as Record<string, string>) || {};
    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    let dbPath = paths[os] || "";
    dbPath = dbPath.replace("%APPDATA%", process.env.APPDATA || "").replace("<user>", process.env.USER || "").replace("/Users/<user>", `/Users/${process.env.USER || ""}`);
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });
      const row = db.query("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get() as any;
      db.close();
      if (!row?.value) return { error: "No Cursor auth token found in local DB" };
      return { tokens: { accessToken: String(row.value) } };
    } catch (err: any) {
      return { error: `Cursor token extraction failed: ${err.message}` };
    }
  },
};

// --- Cline: authorization-code ---
const clineService: ProviderService = {
  provider: PROVIDERS.CLINE,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runAuthorizationCodeFlow(cfg(PROVIDERS.CLINE))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.CLINE), refreshToken),
};

// --- GitLab Duo: authorization-code + PKCE ---
const gitlabService: ProviderService = {
  provider: PROVIDERS.GITLAB,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runAuthorizationCodeFlow(cfg(PROVIDERS.GITLAB))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.GITLAB), refreshToken),
};

// --- Claude (Anthropic): authorization-code + PKCE ---
const claudeService: ProviderService = {
  provider: PROVIDERS.CLAUDE,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runAuthorizationCodeFlow(cfg(PROVIDERS.CLAUDE))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.CLAUDE), refreshToken),
};

// --- Kimi Coding: device-code ---
const kimiCodingService: ProviderService = {
  provider: PROVIDERS.KIMI_CODING,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runDeviceCodeFlow(cfg(PROVIDERS.KIMI_CODING))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.KIMI_CODING), refreshToken),
};

// --- Kilo Code: device-code ---
const kilocodeService: ProviderService = {
  provider: PROVIDERS.KILOCODE,
  engine: "chromium",
  oauthLogin: async () => ({ ...(await runDeviceCodeFlow(cfg(PROVIDERS.KILOCODE))) }),
  refresh: async (refreshToken) => refreshAccessToken(cfg(PROVIDERS.KILOCODE), refreshToken),
};

/** Registry of all provider automation services, keyed by provider id. */
export const SERVICES: Record<ProviderId, ProviderService> = {
  [PROVIDERS.KIRO]: kiroService,
  [PROVIDERS.ANTIGRAVITY]: antigravityService,
  [PROVIDERS.CODEX]: codexService,
  [PROVIDERS.GEMINI]: geminiService,
  [PROVIDERS.CODEBUDDY]: codebuddyService,
  [PROVIDERS.CODEBUDDY_CN]: codebuddyCnService,
  [PROVIDERS.QODER]: qoderService,
  [PROVIDERS.QWEN]: qwenService,
  [PROVIDERS.GITHUB]: githubService,
  [PROVIDERS.OPENAI]: openaiService,
  [PROVIDERS.IFLOW]: iflowService,
  [PROVIDERS.CURSOR]: cursorService,
  [PROVIDERS.CLINE]: clineService,
  [PROVIDERS.GITLAB]: gitlabService,
  [PROVIDERS.CLAUDE]: claudeService,
  [PROVIDERS.KIMI_CODING]: kimiCodingService,
  [PROVIDERS.KILOCODE]: kilocodeService,
} as Record<ProviderId, ProviderService>;

/**
 * Adapt a ProviderService into a BulkImportAdapter so the job framework can
 * drive it uniformly. Browser-login providers use login(); OAuth-only providers
 * fall back to oauthLogin() (no browser needed).
 */
export function toBulkImportAdapter(service: ProviderService): BulkImportAdapter {
  return {
    provider: service.provider,
    login: async (credential, ctx) => {
      if (service.login) {
        const res = await service.login(credential, ctx);
        if (res.error) throw new Error(res.error);
        return { tokens: res.tokens, email: res.email, quota: res.quota };
      }
      if (service.oauthLogin) {
        const res = await service.oauthLogin({});
        if (res.error) throw new Error(res.error);
        return { tokens: res.tokens, email: res.email, quota: res.quota };
      }
      throw new Error(`Provider ${service.provider} has no login or oauthLogin implementation`);
    },
    // Pass through the provider's manual-captcha handler if it defines one.
    handleManual: service.handleManual,
  };
}

/** Convenience: run a single-account login for a provider (ad-hoc, outside the job framework). */
export async function loginProvider(provider: ProviderId, credential: ImportCredential, opts: { headless?: boolean; engine?: BrowserEngine } = {}): Promise<ProviderLoginResult> {
  const service = SERVICES[provider];
  if (!service) return { error: `Unknown provider: ${provider}` };
  if (service.oauthLogin && !service.login) {
    return service.oauthLogin({ headless: opts.headless });
  }
  const engine = opts.engine ?? service.engine;
  const browser = await launchBrowser({ engine, headless: opts.headless ?? true, stealthSeed: 1 });
  try {
    const signal = new AbortController().signal;
    if (!service.login) return { error: `Provider ${provider} has no browser login` };
    return service.login(credential, { browser, signal });
  } finally {
    await browser.close().catch(() => null);
  }
}
