/**
 * CodeBuddy CN phone-login automation (F5 completion) — ports the reference's
 * codebuddyCnPhoneAutomation.js: navigate to codebuddy.cn phone login, enter a
 * 5sim-purchased number, poll 5sim for the OTP, submit it, then mint an API key.
 *
 * Wires the (already-ported) 5sim client into a real phone-login flow so the
 * bulk-import framework can create codebuddy-cn accounts without a manual step.
 * Ported from the reference proxy's src/lib/oauth/services/codebuddyCnPhoneAutomation.js.
 */
import type { Browser, Page } from "playwright";
import { createFiveSimClient, type FiveSimClient, type FiveSimClientOptions } from "./fiveSim";

/** 5sim options for the phone flow — token + the country/product to buy. */
export interface CodeBuddyCnPhoneFiveSimOptions extends FiveSimClientOptions {
  country?: string;
  product?: string;
}

const CODEBUDDY_CN_LOGIN_URL = "https://www.codebuddy.cn/login/?platform=admin&state=0";
const CODEBUDDY_CN_KEYS_URL = "https://www.codebuddy.cn/profile/keys";
const CODEBUDDY_CN_API_KEY_ENDPOINT_URL = "https://www.codebuddy.cn/console/api/client/v1/api-keys";

const PHONE_INPUT_SELECTORS = [
  "#phoneNumber", "input[type='tel']", "input[inputmode='tel']", "input[autocomplete='tel']",
  "input[name*='phone' i]", "input[name*='mobile' i]", "input[id*='phone' i]", "input[id*='mobile' i]",
  "input[placeholder*='手机']", "input[placeholder*='手机号']", "input[placeholder*='phone' i]",
];
const OTP_INPUT_SELECTORS = [
  "#code", "input[autocomplete='one-time-code']", "input[name*='code' i]", "input[id*='code' i]",
  "input[placeholder*='验证码']", "input[placeholder*='短信']", "input[placeholder*='code' i]", "input[maxlength='6']",
];
const PHONE_SUBMIT_SELECTORS = [
  "button:has-text('获取验证码')", "button:has-text('发送验证码')", "button:has-text('Send code')",
  "button:has-text('Continue')", "button:has-text('登录')", "button[type='submit']",
];
const OTP_SUBMIT_SELECTORS = [
  "button:has-text('登录')", "button:has-text('确认')", "button:has-text('完成')",
  "button:has-text('Continue')", "button[type='submit']",
];
const PHONE_LOGIN_MODE_SELECTORS = [
  "text=手机号", "text=手机号登录", "text=短信登录", "text=验证码登录", "text=Phone",
  "button:has-text('手机')", "button:has-text('短信')", "[role='tab']:has-text('手机')",
];

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function splitPhoneForLogin(phone: string): { dialCode: string | null; localNumber: string } {
  const normalized = String(phone || "").replace(/[^\d+]/g, "");
  for (const rawDial of ["+852", "+86"]) {
    if (normalized.startsWith(rawDial)) return { dialCode: rawDial, localNumber: normalized.slice(rawDial.length) };
    if (normalized.startsWith(rawDial.slice(1))) return { dialCode: rawDial, localNumber: normalized.slice(rawDial.slice(1).length) };
  }
  return { dialCode: null, localNumber: normalized.replace(/^\+/, "") };
}

async function clickFirst(scope: Page | any, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = scope.locator?.(selector)?.first?.();
    if (!locator) continue;
    const visible = await locator.isVisible?.({ timeout: 1_000 }).catch(() => false);
    if (!visible) continue;
    try { await locator.click({ timeout: 3_000 }); return true; } catch { continue; }
  }
  return false;
}

async function fillFirst(scope: Page | any, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = scope.locator?.(selector)?.first?.();
    if (!locator) continue;
    const visible = await locator.isVisible?.({ timeout: 1_000 }).catch(() => false);
    if (!visible) continue;
    try { await locator.fill(String(value), { timeout: 3_000 }); return true; }
    catch {
      try { await locator.click?.({ timeout: 3_000 }); await locator.press?.("Control+A").catch(() => null); await locator.press?.("Backspace").catch(() => null); await locator.fill(String(value), { timeout: 3_000 }); return true; }
      catch { continue; }
    }
  }
  return false;
}

function generateKeyName(): string {
  const left = ["china", "hoshi", "longma", "yulan", "meihua", "tianhe", "baihu", "yunhai"];
  const right = ["hoshi", "macan", "long", "mei", "shan", "hua", "yue", "xing"];
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)] as T;
  return `${pick(left)}-${pick(right)}-${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

export interface CodeBuddyCnPhoneResult {
  apiKey?: string;
  keyName?: string;
  phone?: string;
  error?: string;
}

/**
 * Run the full codebuddy-cn phone-login + API-key-creation flow.
 * @param browser  A launched (Camoufox/Chromium) browser.
 * @param fiveSimOpts  5sim client options (token + country/product defaults).
 */
export async function runCodeBuddyCnPhoneFlow(
  browser: Browser,
  fiveSimOpts: CodeBuddyCnPhoneFiveSimOptions,
): Promise<CodeBuddyCnPhoneResult> {
  const fiveSim: FiveSimClient = createFiveSimClient(fiveSimOpts);
  const page = await browser.newPage();
  try {
    // 1. Buy a phone number via 5sim.
    const activation: any = await fiveSim.buyActivation({
      country: fiveSimOpts.country || "hongkong",
      operator: "any",
      product: fiveSimOpts.product || "codebuddy",
    });
    const phone: string | undefined = activation?.phone;
    const orderId: string | undefined = activation?.id;
    if (!phone || !orderId) return { error: "5sim returned no phone number / order id" };

    // 2. Navigate to the codebuddy.cn phone login.
    await page.goto(CODEBUDDY_CN_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15_000 }).catch(() => null);

    // Select phone-login mode if not already active.
    await clickFirst(page, PHONE_LOGIN_MODE_SELECTORS).catch(() => null);
    await delay(1000);

    // 3. Enter the phone number.
    const { dialCode, localNumber } = splitPhoneForLogin(phone);
    if (dialCode) {
      // Try to open the country selector + pick the dial code.
      const opened = await clickFirst(page, [".kc-country-selector", "[role='combobox']:has-text('+')", "button:has-text('+')"]);
      if (opened) {
        await clickFirst(page, [
          `.kc-country-option:has-text('${dialCode}')`,
          `[role='option']:has-text('${dialCode}')`,
          `text=${dialCode}`,
        ]).catch(() => null);
        await delay(500);
      }
    }
    const phoneFilled = await fillFirst(page, PHONE_INPUT_SELECTORS, localNumber);
    if (!phoneFilled) {
      await fiveSim.cancelOrder(orderId).catch(() => null);
      return { error: "Could not find phone input on codebuddy.cn login", phone };
    }

    // 4. Click "send code".
    await clickFirst(page, PHONE_SUBMIT_SELECTORS);

    // 5. Poll 5sim for the OTP (waitForCode returns a normalized order with .code).
    const otpOrder: any = await fiveSim.waitForCode(orderId, { timeoutMs: 120_000 }).catch(() => null);
    const code: string | undefined = otpOrder?.code;
    if (!code) {
      await fiveSim.cancelOrder(orderId).catch(() => null);
      return { error: "Timed out waiting for OTP from 5sim", phone };
    }

    // 6. Enter + submit the OTP.
    await fillFirst(page, OTP_INPUT_SELECTORS, code);
    await clickFirst(page, OTP_SUBMIT_SELECTORS);
    await page.waitForLoadState?.("networkidle", { timeout: 20_000 }).catch(() => null);

    // 7. Finish the 5sim order (free up the number).
    await fiveSim.finishOrder(orderId).catch(() => null);

    // 8. Mint an API key via the keys page (page-evaluate POST).
    const key = await createApiKeyFromPage(page);
    if (!key) return { error: "Phone login succeeded but API key creation failed", phone };
    return { apiKey: key.key, keyName: key.name, phone };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

/** POST to the codebuddy.cn API-key endpoint from the authenticated page context. */
async function createApiKeyFromPage(page: Page): Promise<{ key: string; name: string } | null> {
  try {
    await page.goto(CODEBUDDY_CN_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout?.(2000);
    const name = generateKeyName();
    const result = await page.evaluate(async (keyName) => {
      const res = await fetch("/console/api/client/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName }),
      });
      const text = await res.text();
      let payload: any = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      return { ok: res.ok, status: res.status, payload, text };
    }, name);
    if (result?.ok) {
      const data = result.payload?.data || result.payload || {};
      const key = data.key || data.api_key || data.apiKey;
      if (key) return { key, name: data.name || name };
    }
    return null;
  } catch {
    return null;
  }
}
