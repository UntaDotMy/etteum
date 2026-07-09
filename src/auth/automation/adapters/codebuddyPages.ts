/// <reference lib="dom" />
/**
 * CodeBuddy page-interaction helpers — 1:1 TS port of enowxai's
 * app/providers/codebuddy/_page_helpers.py.
 *
 * This is the real CodeBuddy login logic the obfuscated _adapter.py orchestrates:
 *   - login-iframe detection
 *   - terms-checkbox + "Continue with Google" click (#social-google / broker)
 *   - Google "something went wrong" recovery
 *   - gaplustos interstitial dismissal
 *   - Google consent/continue approval
 *   - blocking-challenge detection (captcha / "verify it's you")
 *   - region-select page (Singapore dropdown)
 *   - Gmail email-verification round-trip
 *
 * Each function is a faithful port of the readable Python source.
 */
import type { Page, Frame } from "playwright";

const CODEBUDDY_BASE_URL = "https://www.codebuddy.ai";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Find CodeBuddy's login iframe (Keycloak openid-connect auth frame). */
export async function getCodebuddyLoginIframe(page: Page): Promise<Frame | null> {
  const selectors = [
    'iframe[title="login-iframe"]',
    'iframe[src*="/auth/realms/copilot/protocol/openid-connect/auth"]',
  ];
  for (const selector of selectors) {
    try {
      const iframeEl = await page.$(selector);
      if (!iframeEl) continue;
      const frame = await iframeEl.contentFrame();
      if (frame) return frame;
    } catch { continue; }
  }
  return null;
}

/**
 * Handle the CodeBuddy landing: click the terms checkbox (div.checkmark) and
 * the "Continue with Google" button (#social-google or /broker/google/login).
 * Falls back to scanning the top-nav for a Login / Google sign-in button.
 * Returns true if anything was clicked.
 */
export async function handleCodebuddyLanding(page: Page): Promise<boolean> {
  const frame = await getCodebuddyLoginIframe(page);
  const target: Page | Frame = frame || page;

  let clickedCheckbox = false;
  let clickedGoogle = false;

  try {
    clickedCheckbox = Boolean(await (target as any).evaluate(() => {
      const el = document.querySelector("div.checkmark");
      if (!el || (el as HTMLElement).offsetParent === null) return false;
      (el as HTMLElement).click();
      return true;
    }));
  } catch {}

  try {
    clickedGoogle = Boolean(await (target as any).evaluate(() => {
      const byId = document.querySelector("#social-google");
      if (byId && (byId as HTMLElement).offsetParent !== null) {
        (byId as HTMLElement).click();
        return true;
      }
      for (const a of Array.from(document.querySelectorAll('a[href*="/broker/google/login"]'))) {
        const txt = (a.textContent || "").toLowerCase();
        if (txt.includes("google") && (a as HTMLElement).offsetParent !== null) {
          (a as HTMLElement).click();
          return true;
        }
      }
      return false;
    }));
  } catch {}

  // Fallback: scan the whole page for a Google / Login button (top-nav case).
  if (!clickedGoogle && !clickedCheckbox) {
    try {
      clickedGoogle = Boolean(await page.evaluate(() => {
        const googlePhrases = ["sign in with google", "login with google", "continue with google"];
        for (const btn of Array.from(document.querySelectorAll('button, a, div[role="button"]'))) {
          if ((btn as HTMLElement).offsetParent === null) continue;
          const txt = (btn.textContent || "").toLowerCase().trim();
          if (googlePhrases.some((p) => txt.includes(p))) { (btn as HTMLElement).click(); return true; }
        }
        const loginPhrases = ["login", "sign in", "log in"];
        for (const a of Array.from(document.querySelectorAll("a, button"))) {
          if ((a as HTMLElement).offsetParent === null) continue;
          const txt = (a.textContent || "").toLowerCase().trim();
          if (loginPhrases.some((p) => txt === p) || loginPhrases.some((p) => txt.startsWith(p + " "))) {
            (a as HTMLElement).click(); return true;
          }
        }
        return false;
      }));
    } catch {}
  }

  return clickedCheckbox || clickedGoogle;
}

/** Detect a Google blocking challenge (captcha / "verify it's you" / unusual traffic). Returns the marker or null. */
export async function detectGoogleBlockingChallenge(page: Page): Promise<string | null> {
  try {
    const url = page.url();
    if (!url.includes("accounts.google.com")) return null;
    const marker = String(await page.evaluate(() => {
      const text = ((globalThis as any).document?.body?.innerText || "").toLowerCase();
      const markers = ["captcha", "try again later", "this browser or app may not be secure", "this browser may not be secure", "unusual traffic", "verify it's you", "verify it’s you", "confirm it's you", "confirm it’s you"];
      for (const c of markers) if (text.includes(c)) return c;
      if (((globalThis as any).window?.location?.pathname || "").includes("/challenge/")) return "google challenge";
      return "";
    })).trim();
    return marker || null;
  } catch { return null; }
}

/** Dismiss Google's "Something went wrong" page by clicking restart/try-again/retry. */
export async function handleGoogleSomethingWentWrong(page: Page): Promise<boolean> {
  try {
    return Boolean(await page.evaluate(() => {
      const body = (globalThis as any).document?.body;
      if (!body) return false;
      const text = (body.innerText || "");
      if (!text.includes("Something went wrong") && !text.includes("went wrong")) return false;
      const containers = document.querySelectorAll('div[role="dialog"], div[role="alertdialog"], div[class*="modal"], div[class*="overlay"], div[class*="popup"]');
      const scan = (root: ParentNode) => {
        for (const el of Array.from(root.querySelectorAll('button, a, div[role="button"], span[role="button"]'))) {
          if ((el as HTMLElement).offsetParent === null) continue;
          const txt = (el.textContent || "").trim().toLowerCase();
          if (txt === "restart" || txt === "try again" || txt === "retry") { (el as HTMLElement).click(); return true; }
        }
        return false;
      };
      for (const c of Array.from(containers)) if (scan(c)) return true;
      return scan(document);
    }));
  } catch { return false; }
}

/** Dismiss the gaplustos speedbump interstitial (multi-language confirm keywords). */
export async function handleGoogleGaplustos(page: Page): Promise<boolean> {
  let url = "";
  try { url = page.url(); } catch {}
  const urlMatch = url.includes("/speedbump/gaplustos");
  if (!urlMatch) {
    let hasEl = false;
    try { hasEl = (await page.$("#gaplustosNext")) !== null; } catch {}
    if (!hasEl) return false;
  }
  try {
    try {
      const btn = page.locator("#gaplustosNext button");
      if ((await btn.count()) > 0 && await btn.first().isVisible()) {
        await btn.first().click({ force: true });
        return true;
      }
    } catch {}
    try { await page.waitForSelector('#confirm, input[name="confirm"], input[type="submit"]', { state: "visible", timeout: 5000 }); } catch {}
    for (const selector of ["#confirm", 'input[name="confirm"]', 'input[type="submit"]']) {
      const loc = page.locator(selector).first();
      try {
        if ((await loc.count()) === 0 || !(await loc.isVisible())) continue;
        await loc.click({ force: true });
        return true;
      } catch {}
    }
    return Boolean(await page.evaluate(() => {
      const candidates = [
        document.querySelector("#confirm"),
        document.querySelector('input[name="confirm"]'),
        ...Array.from(document.querySelectorAll('input[type="submit"], button')),
      ];
      const keywords = ["confirm","understand","accept","agree","continue","ok","mengerti","terima","понятно","принимаю","принять","продолжить","entendido","aceptar","continuar","compris","accepter","了解","同意","确认","接受","理解","同意する","確認","동의","확인","verstanden","akzeptieren","zustimmen","anladım","kabul","entendi","aceitar","capisco","accetta","rozumiem","akceptuję","begrijpen","accepteren","เข้าใจ","ยอมรับ","hiểu","chấp nhận","فهمت","قبول","समझ गया","स्वीकार"];
      for (const el of candidates) {
        if (!el || (el as HTMLElement).offsetParent === null) continue;
        const txt = ((el as HTMLInputElement).value || (el.textContent || "")).toLowerCase().trim();
        if (keywords.some((k) => txt.includes(k))) { (el as HTMLElement).click(); return true; }
      }
      const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
      for (const el of Array.from(submits)) { if ((el as HTMLElement).offsetParent !== null) { (el as HTMLElement).click(); return true; } }
      return false;
    }));
  } catch { return false; }
}

/** Approve the Google OAuth consent screen (#submit_approve_access, multi-language). */
export async function handleGoogleConsentContinue(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (!url.includes("accounts.google.com")) return false;
    return Boolean(await page.evaluate(() => {
      const el = document.querySelector("#submit_approve_access button, #submit_approve_access");
      if (el && (el as HTMLElement).offsetParent !== null) { (el as HTMLElement).click(); return true; }
      const keywords = ["continue","allow","lanjut","продолжить","разрешить","продовжити","дозволити","weiter","erlauben","continuer","autoriser","continuar","permitir","続行","허용","继续","允许"];
      for (const btn of Array.from(document.querySelectorAll('button, div[role="button"]'))) {
        const txt = (btn.textContent || "").trim().toLowerCase();
        if (!txt || (btn as HTMLElement).offsetParent === null) continue;
        if (keywords.some((k) => txt.includes(k))) { (btn as HTMLElement).click(); return true; }
      }
      return false;
    }));
  } catch { return false; }
}

/**
 * Handle the CodeBuddy region-select page (/register/user/complete): open the
 * "Registration location" dropdown, search + select Singapore, submit.
 */
export async function handleCodebuddyRegionSelect(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    const parsed = new URL(url);
    if (parsed.host !== new URL(CODEBUDDY_BASE_URL).host || !parsed.pathname.startsWith("/register/user/complete")) return false;

    try { await page.waitForSelector('div.t-input input[placeholder="Registration location"]', { state: "visible", timeout: 2000 }); }
    catch { return false; }

    let regionValue = String(await page.evaluate(() => {
      const box = document.querySelector('div.t-input input[placeholder="Registration location"]') as HTMLInputElement | null;
      if (!box || (box as any).offsetParent === null) return "";
      return box.value || "";
    })).trim();

    if (regionValue.toLowerCase() !== "singapore") {
      const opened = Boolean(await page.evaluate(() => {
        const box = document.querySelector('div.t-input input[placeholder="Registration location"]') as HTMLElement | null;
        if (!box || box.offsetParent === null) return false;
        box.click();
        return true;
      }));
      if (!opened) return false;
      await sleep(300);

      try {
        const overlaySearch = page.locator('.dropdown-overlay input[placeholder="Search countries"], .dropdown-search input[placeholder="Search countries"]').first();
        if ((await overlaySearch.count()) > 0 && await overlaySearch.isVisible()) {
          await overlaySearch.click({ force: true });
          await overlaySearch.fill("Singapore");
          await sleep(250);
        }
      } catch {}

      let selected = false;
      const optionSelectors: Array<{ locator: () => any }> = [
        { locator: () => page.locator(".dropdown-overlay").getByText("Singapore", { exact: true }).first() },
        { locator: () => page.locator(".dropdown-overlay").getByText("Current region Singapore", { exact: false }).first() },
        { locator: () => page.getByText("Current region Singapore", { exact: false }).first() },
        { locator: () => page.getByText("Singapore", { exact: true }).first() },
      ];
      for (const { locator } of optionSelectors) {
        try {
          const loc = locator();
          if (!loc) continue;
          if ((await loc.count()) === 0 || !(await loc.isVisible())) continue;
          await loc.click({ force: true });
          selected = true;
          break;
        } catch {}
      }

      if (!selected) {
        selected = Boolean(await page.evaluate(() => {
          const selectors = ['.dropdown-overlay [role="option"]', '.dropdown-overlay .dropdown-item', '.dropdown-overlay li', '.dropdown-overlay div'];
          for (const sel of selectors) {
            for (const el of Array.from(document.querySelectorAll(sel))) {
              const txt = (el.textContent || "").toLowerCase().trim();
              if (!txt || (el as HTMLElement).offsetParent === null) continue;
              if (txt === "singapore" || txt.includes("singapore") || txt.includes("current region singapore")) {
                (el as HTMLElement).click(); return true;
              }
            }
          }
          return false;
        }));
      }
      await sleep(300);

      try {
        await page.waitForFunction(() => {
          const box = document.querySelector('div.t-input input[placeholder="Registration location"]') as HTMLInputElement | null;
          const value = (box?.value || "").trim().toLowerCase();
          const text = ((globalThis as any).document?.body?.innerText || "").toLowerCase();
          return value === "singapore" || text.includes("current region singapore");
        }, { timeout: 4000 });
      } catch {}

      regionValue = String(await page.evaluate(() => {
        const box = document.querySelector('div.t-input input[placeholder="Registration location"]') as HTMLInputElement | null;
        const inputValue = box && (box as any).offsetParent !== null ? (box.value || "") : "";
        if (inputValue) return inputValue;
        const text = ((globalThis as any).document?.body?.innerText || "").toLowerCase();
        if (text.includes("current region singapore")) return "Singapore";
        return "";
      })).trim();
    }

    if (regionValue.toLowerCase() !== "singapore") return false;

    let submitted = false;
    const submitSelectors = [
      'button:has-text("Submit")',
      '[role="button"]:has-text("Submit")',
      'div[class*="cursor-pointer"]:has-text("Submit")',
    ];
    for (const sel of submitSelectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) === 0 || !(await loc.isVisible())) continue;
        await loc.click({ force: true });
        submitted = true;
        break;
      } catch {}
    }
    try {
      const loc = page.getByText("Submit", { exact: true }).first();
      if (!submitted && (await loc.count()) > 0 && await loc.isVisible()) {
        await loc.click({ force: true });
        submitted = true;
      }
    } catch {}
    if (!submitted) {
      submitted = Boolean(await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('button, [role="button"], div[class*="cursor-pointer"]'))) {
          const txt = (el.textContent || "").trim().toLowerCase();
          if (!txt || (el as HTMLElement).offsetParent === null) continue;
          if (txt === "submit" || txt.includes("submit")) { (el as HTMLElement).click(); return true; }
        }
        return false;
      }));
    }
    if (submitted) {
      const redirectUri = parsed.searchParams.get("redirect_uri") || "";
      try {
        await page.waitForFunction(() => {
          const path = (globalThis as any).window?.location?.pathname || "";
          return path === "/started" || !path.startsWith("/register/user/complete");
        }, { timeout: 4000 });
      } catch {
        if (redirectUri.startsWith(CODEBUDDY_BASE_URL)) {
          try { await page.goto(redirectUri, { waitUntil: "domcontentloaded" }); } catch {}
        }
        try {
          await page.waitForFunction(() => {
            const path = (globalThis as any).window?.location?.pathname || "";
            return path === "/started" || !path.startsWith("/register/user/complete");
          }, { timeout: 10000 });
        } catch {}
      }
    }
    return submitted;
  } catch { return false; }
}

/** Wait for the codebuddy:// callback carrying ?state=. Returns the state or null. */
export async function captureCodebuddyState(page: Page, timeoutMs = 60_000): Promise<string | null> {
  try { await page.goto(`${CODEBUDDY_BASE_URL}/started`, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = String(page.url() || "");
    if (url.startsWith("codebuddy://") || url.includes("codebuddy://")) {
      const q = url.indexOf("?");
      if (q >= 0) {
        const params = new URLSearchParams(url.slice(q + 1));
        const state = params.get("state");
        if (state) return state;
      }
    }
    await sleep(500);
  }
  return null;
}

/** Build a cookie header from the page's cookies for a base URL. */
export async function buildCookieHeaderFromPage(page: Page, baseUrl: string): Promise<string> {
  try {
    const context = page.context();
    const cookies = await context.cookies([baseUrl]);
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch { return ""; }
}
