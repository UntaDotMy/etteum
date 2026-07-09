/**
 * Stealth Google login automation — TS port of the reference proxy's
 * src/lib/oauth/services/kiroGoogleAutomation.js, 1:1.
 *
 * This is the #410-critical recipe: locale-aware Google login selectors
 * (English/Indonesian/Chinese), humanized typing (humanType), resilient fills,
 * multi-frame scanning, and the Kiro/CodeBuddy callback monitoring. The Camoufox
 * engine (engine.ts) provides the deep fingerprint; this module provides the
 * behavioral stealth on top.
 *
 * Fidelity to the reference selectors and humanized timing is mandatory — that
 * is what defeats Google's bot detection (#410).
 */
import type { Page, Locator, Frame, BrowserContext } from "playwright";

const DEFAULT_SHORT_TIMEOUT_MS = 90_000;
const DEFAULT_MANUAL_TIMEOUT_MS = 15 * 60_000;

// --- Google account-input selectors (multi-language) ---
export const GOOGLE_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="identifier"]',
  'input[id="identifierId"]',
  'input[autocomplete="username"]',
  'input[aria-label*="Email" i]',
  'input[aria-label*="email" i]',
  'input[placeholder*="Email" i]',
  'input[placeholder*="email" i]',
];

export const GOOGLE_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="Passwd"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[aria-label*="Enter your password" i]',
  'input[aria-label*="password" i]',
];

export const GOOGLE_NEXT_BUTTON_SELECTORS = [
  '#identifierNext',
  '#passwordNext',
  'button:has-text("Next")',
  'button:has-text("next")',
  'div[role="button"]:has-text("Next")',
  'button:has-text("Continue")',
  'button:has-text("继续")',
  'button:has-text("下一步")',
  'div[role="button"]:has-text("继续")',
  'div[role="button"]:has-text("下一步")',
];

const GOOGLE_CHALLENGE_SELECTORS = [
  'input[type="tel"]',
  'input[name="knowledgePreregisteredPhoneVerification"]',
  'input[autocomplete="tel"]',
  'input[aria-label*="phone" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="SMS" i]',
  '#totpPin',
  'input[name="totpPin"]',
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
];

const GOOGLE_APPROVE_BUTTON_SELECTORS = [
  'button:has-text("Allow")',
  'button:has-text("Continue")',
  'button:has-text("Approve")',
  'button:has-text("Got it")',
  'button:has-text("Done")',
  'button:has-text("OK")',
  'div[role="button"]:has-text("Allow")',
  'div[role="button"]:has-text("Continue")',
];

const GOOGLE_SKIP_BUTTON_SELECTORS = [
  'button:has-text("Not now")',
  'button:has-text("Skip")',
  'button:has-text("Not now, thanks")',
  'button:has-text("Maybe later")',
  'button:has-text("现在不用")',
  'div[role="button"]:has-text("跳过")',
  'div[role="button"]:has-text("暂不")',
];

const GOOGLE_LOGIN_BUTTON_SELECTORS = [
  '#social-google',
  'a#social-google',
  'button.ButtonContinueWithGoogle',
  'button[class*="ContinueWithGoogle"]',
  'a:has-text("Sign up with Google")',
  'a:has-text("Log in with Google")',
  'button:has-text("Sign up with Google")',
  'button:has-text("Log in with Google")',
  'button:has-text("Continue with Google")',
  'button:has-text("Google")',
  'a:has-text("Google")',
  'div[role="button"]:has-text("Google")',
  'span:has-text("Google")',
  '[aria-label*="Google"]',
  '[data-provider*="google" i]',
];

const TERMS_CHECKBOX_SELECTORS = [
  '#agree-policy-account',
  '#agree-policy',
  '#agree-policy-sso',
  'input[type="checkbox"][id*="agree" i]',
  'input[type="checkbox"][name*="agree" i]',
  'input[type="checkbox"][id*="policy" i]',
  'input[type="checkbox"][name*="policy" i]',
  'input[type="checkbox"][id*="terms" i]',
  'input[type="checkbox"][name*="terms" i]',
  '.login-checkbox input[type="checkbox"]',
  '[class*="checkbox"] input[type="checkbox"]',
  '[class*="agree"] input[type="checkbox"]',
  'input[type="checkbox"]',
];

const PRIVACY_CONFIRM_BUTTON_SELECTORS = [
  '.ui-dialog button:has-text("Confirm")',
  'dialog button:has-text("Confirm")',
  'button:has-text("Confirm")',
  'button:has-text("I agree")',
  'button:has-text("Agree")',
  'button:has-text("同意")',
  'button:has-text("确认")',
];

const PROVIDER_ONBOARDING_ACTION_SELECTORS = [
  'button:has-text("Continue")', '[role="button"]:has-text("Continue")',
  'button:has-text("Get started")', 'button:has-text("GET STARTED")',
  'input[type="submit"][value="GET STARTED"]',
  'button:has-text("Start")', 'button:has-text("Confirm")',
  'button:has-text("Done")', 'button:has-text("Next")',
  'button:has-text("Skip")', 'button:has-text("Not now")',
  'button:has-text("Save")', 'button:has-text("Create")',
  'button:has-text("Enter")', 'button:has-text("Launch")',
  'button:has-text("Use CodeBuddy")', 'button:has-text("Go to CodeBuddy")',
  'button:has-text("继续")', 'button:has-text("下一步")',
  'button:has-text("确认")', 'button:has-text("同意")',
  'button:has-text("开始")', 'button:has-text("完成")',
  'button:has-text("跳过")', 'button:has-text("暂不")',
  'button:has-text("保存")', 'button:has-text("创建")',
  '[role="button"]:has-text("继续")', '[role="button"]:has-text("确认")',
  '[role="button"]:has-text("同意")',
];

const PROVIDER_REGION_TRIGGER_SELECTORS = [
  'select', '[role="combobox"]', '.page-region [role="combobox"]',
  '.page-region .t-select', '.page-region [class*="t-select"]',
  '.page-region [class*="select"]', '.page-region input[placeholder]',
  'button:has-text("Region")', '[role="button"]:has-text("Region")',
  'button:has-text("Select region")', '[role="button"]:has-text("Select region")',
  'button:has-text("Data region")', '[aria-label*="region" i]',
  '[placeholder*="region" i]',
];

const PROVIDER_REGION_OPTION_SELECTORS = [
  'text=/^Indonesia$/i', 'text=/^ID$/i', 'text=/^Singapore$/i', 'text=/^SG$/i',
  'text=/^Japan$/i', 'text=/^JP$/i', 'text=/^Thailand$/i', 'text=/^TH$/i',
  'text=/^Global$/i', 'text=/^International$/i', 'text=/^United States$/i',
  'text=/^US$/i', 'text=/^Asia Pacific$/i', 'text=/^Hong Kong$/i',
  'text=/^Default$/i',
];

const PROVIDER_ONBOARDING_INPUT_DEFAULTS = [
  { selector: 'input[name*="workspace" i]', value: "Default" },
  { selector: 'input[placeholder*="workspace" i]', value: "Default" },
  { selector: 'input[name*="team" i]', value: "Default" },
  { selector: 'input[placeholder*="team" i]', value: "Default" },
  { selector: 'input[name*="name" i]', value: "Default" },
  { selector: 'input[placeholder*="name" i]', value: "Default" },
];

const INVALID_CREDENTIAL_MARKERS = [
  "wrong password", "incorrect password", "couldn't find your google account",
  "couldn’t find your google account", "enter a valid email", "couldn’t sign you in",
  "couldn't sign you in", "invalid email or password", "password is incorrect",
  "密码错误", "密码不正确", "找不到该 google 帐号", "找不到该 google 账号",
  "无法登录", "无法为您登录", "请输入有效的电子邮件", "电子邮件或密码无效",
];

const MANUAL_ASSIST_MARKERS = [
  "2-step verification", "2-step verification required", "verify it’s you",
  "verify it's you", "check your phone", "confirm it’s you", "confirm it's you",
  "recovery email", "recovery phone", "suspicious sign-in prevented",
  "unusual activity detected", "captcha", "try again later",
  "两步验证", "双重验证", "验证您的身份", "确认是您本人", "检查您的手机",
  "恢复邮箱", "恢复电话", "已阻止可疑的登录", "检测到异常活动", "验证码", "请稍后重试",
];

const RESTRICTED_ACCOUNT_MARKERS = [
  "restricted", "account has been restricted", "account is restricted",
  "account has been suspended", "account is suspended", "account has been disabled",
  "account is disabled", "account has been banned", "account is banned",
  "access denied", "account locked", "帐号已受限", "账号已受限", "帐号已被封禁", "账号已被封禁",
];

const GOOGLE_WORKSPACE_WELCOME_MARKERS = [
  "welcome to your new account", "selamat datang di akun baru",
  "your administrator decides which", "欢迎使用您的新 google 帐号", "您的管理员决定",
];

const KIRO_CALLBACK_PREFIX = "kiro://kiro.kiroAgent/authenticate-success";

function parseCallbackUrl(rawUrl: string): { callbackUrl: string; code: string; state: string | null } | null {
  if (!rawUrl || !rawUrl.startsWith(KIRO_CALLBACK_PREFIX)) return null;
  const queryIndex = rawUrl.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : "");
  const code = params.get("code");
  if (!code) return null;
  return { callbackUrl: rawUrl, code, state: params.get("state") };
}

type Scope = Page | Frame;

function getInteractionScopes(page: Page): Scope[] {
  const frames = typeof page.frames === "function" ? page.frames() : [];
  const main = (page as any).mainFrame?.() ?? page;
  return [page, ...frames.filter((frame) => frame !== main)];
}

export async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const clicked = await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
  }
  return false;
}

export async function clickFirstActionable(page: Page, selectors: string[]): Promise<boolean> {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => null);
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const enabled = await locator.isEnabled().catch(() => true);
      if (!enabled) continue;
      const clicked = await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
  }
  return false;
}

export async function checkFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const scope of getInteractionScopes(page)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const checked = await locator.isChecked().catch(() => false);
      if (checked) return true;
      const didCheck = await locator.check({ force: true, timeout: 5_000 }).then(() => true).catch(() => false);
      if (didCheck) {
        const verified = await locator.isChecked().catch(() => false);
        if (verified) return true;
      }
      const clicked = await locator.click({ force: true, timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) {
        await scope.waitForTimeout(200).catch(() => null);
        const verified = await locator.isChecked().catch(() => false);
        if (verified) return true;
      }
    }
  }
  return false;
}

export async function getFirstVisibleLocator(page: Page, selector: string): Promise<Locator | null> {
  for (const scope of getInteractionScopes(page)) {
    const locator = scope.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    return locator;
  }
  return null;
}

export async function waitForFirstVisibleLocator(
  page: Page,
  selector: string,
  { timeout = 15_000, pollInterval = 500 }: { timeout?: number; pollInterval?: number } = {},
): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await getFirstVisibleLocator(page, selector);
    if (found) return found;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(pollInterval, remaining)));
  }
  return null;
}

/**
 * Humanized typing — the core anti-detection behavior. Types character by
 * character with random per-keystroke delays (50-180ms) and occasional long
 * pauses (~6% chance, 300-800ms) that mimic a real user. Selects-all + deletes
 * first so a stale autofill can't poison the input.
 */
export async function humanType(locator: Locator | null, value: string, { timeout = 15_000 }: { timeout?: number } = {}): Promise<boolean> {
  if (!locator || value == null) return false;
  const text = String(value);

  try {
    await locator.click({ timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.floor(Math.random() * 400)));
  } catch { /* noop */ }

  try {
    await locator.press("Control+a");
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 100)));
    await locator.press("Delete");
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.floor(Math.random() * 300)));
  } catch {
    try { await locator.fill(""); } catch { /* noop */ }
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch) await locator.press(ch, { timeout });
    const baseDelay = 50 + Math.floor(Math.random() * 130);
    const longPause = Math.random() < 0.06 ? 300 + Math.floor(Math.random() * 500) : 0;
    await new Promise((resolve) => setTimeout(resolve, baseDelay + longPause));
  }

  let observed = "";
  try { observed = await locator.inputValue(); } catch { observed = ""; }
  return observed === text;
}

export async function fillInputResilient(locator: Locator | null, value: string, opts?: { timeout?: number }): Promise<boolean> {
  if (!locator || value == null) return false;
  const filled = await humanType(locator, value, opts);
  if (filled) return true;
  // Fallback to Playwright's fill + a blur (some frameworks validate on blur).
  try {
    await locator.fill(value, { timeout: opts?.timeout ?? 15_000 });
    await locator.press("Tab").catch(() => null);
    const observed = await locator.inputValue().catch(() => "");
    return observed === value;
  } catch {
    return false;
  }
}

export function parseSelectorList(list: string): string[] {
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}

async function detectPageState(page: Page, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = await page.evaluate(() => (globalThis as any).document?.body?.innerText?.toLowerCase() || "").catch(() => "");
    if (!bodyText) { await new Promise((r) => setTimeout(r, 300)); continue; }
    if (INVALID_CREDENTIAL_MARKERS.some((m) => bodyText.includes(m.toLowerCase()))) return "invalid";
    if (MANUAL_ASSIST_MARKERS.some((m) => bodyText.includes(m.toLowerCase()))) return "manual";
    if (RESTRICTED_ACCOUNT_MARKERS.some((m) => bodyText.includes(m.toLowerCase()))) return "restricted";
    if (GOOGLE_WORKSPACE_WELCOME_MARKERS.some((m) => bodyText.includes(m.toLowerCase()))) return "welcome";
    return "ok";
  }
  return "unknown";
}

export interface GoogleLoginResult {
  success: boolean;
  callbackUrl?: string;
  code?: string;
  state?: string | null;
  email?: string;
  error?: string;
  manual?: boolean;
}

/**
 * Run the stealth Google account automation: navigates to the provider's login,
 * clicks "Continue with Google", types email/password humanized, handles 2FA
 * prompts by surfacing a manual signal, and monitors for the OAuth callback.
 */
export async function runGoogleAccountAutomation(
  page: Page,
  opts: { email: string; password: string; loginUrl: string; onManual?: (reason: string) => void; manualTimeoutMs?: number },
): Promise<GoogleLoginResult> {
  const { email, password, loginUrl, onManual, manualTimeoutMs = DEFAULT_MANUAL_TIMEOUT_MS } = opts;

  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_SHORT_TIMEOUT_MS });
  // Random pre-interaction dwell — a real user doesn't click instantly.
  await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 1200)));

  // Click "Continue with Google"
  const googleClicked = await clickFirstVisible(page, GOOGLE_LOGIN_BUTTON_SELECTORS);
  if (!googleClicked) {
    return { success: false, error: "Could not find 'Continue with Google' button" };
  }
  await page.waitForTimeout(1000 + Math.floor(Math.random() * 1500));

  // Email
  const emailLocator = await waitForFirstVisibleLocator(page, GOOGLE_EMAIL_SELECTORS.join(", "), { timeout: 30_000 });
  if (!emailLocator) {
    const state = await detectPageState(page);
    return { success: false, error: `Google email field not found (state=${state})`, manual: state === "manual" };
  }
  const emailOk = await fillInputResilient(emailLocator, email);
  if (!emailOk) return { success: false, error: "Failed to type Google email" };
  await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 600)));
  await clickFirstVisible(page, GOOGLE_NEXT_BUTTON_SELECTORS);
  await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));

  // Check for errors / challenges after email
  const postEmailState = await detectPageState(page);
  if (postEmailState === "manual") {
    onManual?.("Google 2-step verification / challenge required");
    return { success: false, error: "Manual assist required (2FA/challenge)", manual: true };
  }
  if (postEmailState === "invalid") return { success: false, error: "Invalid Google credentials" };
  if (postEmailState === "restricted") return { success: false, error: "Google account restricted" };

  // Password
  const pwLocator = await waitForFirstVisibleLocator(page, GOOGLE_PASSWORD_SELECTORS.join(", "), { timeout: 30_000 });
  if (!pwLocator) return { success: false, error: "Google password field not found" };
  const pwOk = await fillInputResilient(pwLocator, password);
  if (!pwOk) return { success: false, error: "Failed to type Google password" };
  await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 600)));
  await clickFirstVisible(page, GOOGLE_NEXT_BUTTON_SELECTORS);
  await page.waitForTimeout(2000 + Math.floor(Math.random() * 2000));

  // Post-password state check
  const postPwState = await detectPageState(page);
  if (postPwState === "manual") {
    onManual?.("Google 2-step verification / challenge required after password");
    return { success: false, error: "Manual assist required (post-password 2FA)", manual: true };
  }
  if (postPwState === "invalid") return { success: false, error: "Invalid Google password" };

  // Approve consent / skip extras
  await clickFirstVisible(page, GOOGLE_APPROVE_BUTTON_SELECTORS);
  await page.waitForTimeout(1000);
  await clickFirstVisible(page, GOOGLE_SKIP_BUTTON_SELECTORS);

  return { success: true, email };
}

/** Monitor a Kiro OAuth flow for the kiro:// callback redirect. */
export async function createKiroCallbackMonitor(page: Page, { timeoutMs = DEFAULT_SHORT_TIMEOUT_MS } = {}): Promise<{ code: string; state: string | null; callbackUrl: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const parsed = parseCallbackUrl(url);
    if (parsed) return { code: parsed.code, state: parsed.state, callbackUrl: parsed.callbackUrl };
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export async function runKiroGoogleAutomation(
  page: Page,
  opts: { email: string; password: string; loginUrl: string; onManual?: (reason: string) => void },
): Promise<GoogleLoginResult> {
  const loginResult = await runGoogleAccountAutomation(page, opts);
  if (!loginResult.success) return loginResult;
  // After Google approval, Kiro redirects to kiro://...?code=... — monitor for it.
  const callback = await createKiroCallbackMonitor(page, { timeoutMs: DEFAULT_SHORT_TIMEOUT_MS });
  if (!callback) return { success: false, error: "Kiro callback (kiro://) not received after Google login" };
  return { success: true, code: callback.code, state: callback.state, email: opts.email };
}

/** Handle a CodeBuddy region-selection onboarding page. Returns true if handled. */
export async function handleCodeBuddyRegionPage(page: Page): Promise<boolean> {
  const trigger = await getFirstVisibleLocator(page, PROVIDER_REGION_TRIGGER_SELECTORS.join(", "));
  if (!trigger) return false;
  await trigger.click().catch(() => null);
  await page.waitForTimeout(500);
  const option = await getFirstVisibleLocator(page, PROVIDER_REGION_OPTION_SELECTORS.join(", "));
  if (option) {
    await option.click().catch(() => null);
    await page.waitForTimeout(500);
  }
  await clickFirstVisible(page, PROVIDER_ONBOARDING_ACTION_SELECTORS);
  return true;
}

/** Returns true if the current page looks like a provider onboarding/welcome page. */
export async function isProviderPage(page: Page): Promise<boolean> {
  const bodyText = await page.evaluate(() => (globalThis as any).document?.body?.innerText?.toLowerCase() || "").catch(() => "");
  return GOOGLE_WORKSPACE_WELCOME_MARKERS.some((m) => bodyText.includes(m.toLowerCase()));
}

/** Drive a generic provider onboarding flow (terms checkbox + confirm + continue). */
export async function handleProviderOnboarding(page: Page): Promise<boolean> {
  let acted = false;
  if (await checkFirstVisible(page, TERMS_CHECKBOX_SELECTORS)) acted = true;
  if (await clickFirstVisible(page, PRIVACY_CONFIRM_BUTTON_SELECTORS)) acted = true;
  // Fill default onboarding inputs (workspace/team name).
  for (const { selector, value } of PROVIDER_ONBOARDING_INPUT_DEFAULTS) {
    const loc = await getFirstVisibleLocator(page, selector);
    if (loc) {
      const ok = await fillInputResilient(loc, value);
      if (ok) acted = true;
    }
  }
  if (await clickFirstVisible(page, PROVIDER_ONBOARDING_ACTION_SELECTORS)) acted = true;
  return acted;
}

/** Signal that the provider started authorization (callback URL appeared). */
export async function handleCodeBuddyStartedAuthorization(page: Page): Promise<boolean> {
  const callback = await createKiroCallbackMonitor(page, { timeoutMs: 10_000 });
  return !!callback;
}
