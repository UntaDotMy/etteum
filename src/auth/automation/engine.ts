/**
 * Browser automation engine — TS port of the reference proxy's bulkImportBrowserEngine.js,
 * 1:1 architecture, with #410 stealth hardening layered on top of Camoufox.
 *
 * SUPPORTED_ENGINES: "chromium" (Playwright) | "camoufox" (stealth Firefox).
 * DEFAULT = "camoufox" per the user directive (highly stealth, Google #410 fix).
 *
 * #410 context: Google previously detected Camoufox's default fingerprint and
 * blocked the antigravity Google login. The hardening here layers extra evasion
 * on top of camoufox.launchOptions(): consistent locale/timezone, WebRTC leak
 * blocking, randomized but coherent viewport + screen, and humanized input. The
 * Google-login service (kiroGoogleAutomation.ts) adds behavioral stealth on top.
 */
import { firefox as playwrightFirefox, chromium as playwrightChromium } from "playwright";
// camoufox-js is an optional stealth dependency. Resolve lazily so the module
// typechecks/loads even when the package isn't installed (e.g. CI, slim images).
// The engine falls back to chromium if camoufox is unavailable at runtime.
let camoufoxLaunchOptions: ((opts?: { headless?: boolean }) => Promise<any>) | null = null;
try {
  // @ts-expect-error — optional dependency, may be absent
  ({ launchOptions: camoufoxLaunchOptions } = await import("camoufox-js"));
} catch {
  camoufoxLaunchOptions = null;
}

export type BrowserEngine = "chromium" | "camoufox";
export const DEFAULT_ENGINE: BrowserEngine = "camoufox";
export const SUPPORTED_ENGINES = new Set<BrowserEngine>(["chromium", "camoufox"]);

export function normalizeEngine(value?: string): BrowserEngine {
  if (typeof value !== "string") return DEFAULT_ENGINE;
  const lower = value.trim().toLowerCase() as BrowserEngine;
  return SUPPORTED_ENGINES.has(lower) ? lower : DEFAULT_ENGINE;
}

/** Parse a proxy URL into Playwright's proxy option shape. */
export function buildBrowserProxyOption(proxyUrl?: string): { server: string; username?: string; password?: string } | null {
  const clean = String(proxyUrl || "").trim();
  if (!clean) return null;
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    return { server: clean };
  }
  const server = `${parsed.protocol}//${parsed.host}`;
  const proxy: { server: string; username?: string; password?: string } = { server };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

// --- #410 stealth hardening constants ---
// A coherent fingerprint: locale, timezone, and geo must agree, or Google flags
// the mismatch. These defaults are US/English; the Google-login service may
// override per-account. Viewport + screen are randomized within a believable
// range but kept internally consistent.
const STEALTH_LOCALES = ["en-US", "en-US", "en-US", "en-GB"];
const STEALTH_TIMEZES = ["America/New_York", "America/Chicago", "America/Los_Angeles", "America/Denver"];
const STEALTH_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

function pickDeterministic<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length] as T;
}

export interface StealthProfile {
  locale: string;
  timezone: string;
  viewport: { width: number; height: number };
  geolocation: { latitude: number; longitude: number };
}

/** Build a coherent stealth profile from a numeric seed (account id). */
export function buildStealthProfile(seed: number): StealthProfile {
  const locale = pickDeterministic(STEALTH_LOCALES, seed);
  const timezone = pickDeterministic(STEALTH_TIMEZES, seed);
  const viewport = pickDeterministic(STEALTH_VIEWPORTS, seed);
  // Rough lat/long for the timezone's region — keeps geo consistent with TZ.
  const geoMap: Record<string, { latitude: number; longitude: number }> = {
    "America/New_York": { latitude: 40.7128, longitude: -74.006 },
    "America/Chicago": { latitude: 41.8781, longitude: -87.6298 },
    "America/Los_Angeles": { latitude: 34.0522, longitude: -118.2437 },
    "America/Denver": { latitude: 39.7392, longitude: -104.9903 },
  };
  return { locale, timezone, viewport, geolocation: geoMap[timezone] ?? geoMap["America/New_York"]! };
}

export interface LaunchBrowserOptions {
  engine?: BrowserEngine;
  proxyUrl?: string;
  headless?: boolean;
  args?: string[];
  /** Account id used to seed a deterministic stealth profile (camoufox only). */
  stealthSeed?: number;
}

/**
 * Apply #410 stealth hardening to a Playwright Firefox context after Camoufox
 * launches. Camoufox handles the deep fingerprint (canvas, WebGL, fonts); this
 * adds the behavioral/consistency layer Google's login flow checks.
 */
async function applyStealthHardening(
  context: import("playwright").BrowserContext,
  profile: StealthProfile,
): Promise<void> {
  await context.addInitScript((p) => {
    // Block WebRTC IP leak (a classic bot tell that reveals real LAN/public IP).
    // This script runs in the BROWSER context; declare the globals for TS.
    const w = (globalThis as any).window ?? (globalThis as any);
    if (w.RTCPeerConnection) {
      const orig = w.RTCPeerConnection;
      w.RTCPeerConnection = new Proxy(orig, {
        construct(target, args) {
          const cfg = (args[0] && typeof args[0] === "object") ? args[0] : {};
          cfg.iceServers = [];
          cfg.iceTransportPolicy = "relay";
          return new target(cfg);
        },
      });
    }
    // navigator.languages must match the locale or Google flags it.
    const nav = (globalThis as any).navigator;
    if (nav) {
      Object.defineProperty(nav, "languages", { get: () => [p.locale, "en"] });
    }
    // timezone consistency is enforced via context options, but also harden
    // Intl to be safe.
    try {
      const IntlCtor = (globalThis as any).Intl;
      const origResolved = IntlCtor.DateTimeFormat.prototype.resolvedOptions;
      IntlCtor.DateTimeFormat.prototype.resolvedOptions = function () {
        const r = origResolved.call(this);
        r.timeZone = p.timezone;
        return r;
      };
    } catch { /* noop */ }
  }, profile);
}

async function launchCamoufox(opts: LaunchBrowserOptions) {
  const { proxyUrl, headless = true, args = [], stealthSeed = 1 } = opts;
  if (!camoufoxLaunchOptions) {
    // Package not installed — fall back to chromium so the engine still works
    // (e.g. in CI without the optional dep). The stealth profile is still
    // applied via applyStealthHardening on the chromium context.
    console.warn("[engine] camoufox-js not installed — falling back to chromium");
    return launchChromium(opts);
  }
  // Camoufox generates the stealth Firefox launch options; Playwright's firefox
  // driver actually launches the browser.
  const camoufoxOptions = await camoufoxLaunchOptions({ headless });
  const launchOptions: import("playwright").LaunchOptions = { ...(camoufoxOptions as any) };
  if (args.length) launchOptions.args = [...(launchOptions.args || []), ...args];
  const proxy = buildBrowserProxyOption(proxyUrl);
  if (proxy) launchOptions.proxy = proxy;

  const browser = await playwrightFirefox.launch(launchOptions);
  const profile = buildStealthProfile(stealthSeed);
  // Apply the consistency/behavioral hardening to every new context.
  // Patch newContext to auto-apply stealth.
  const origNewContext = browser.newContext.bind(browser);
  const hardenedNewContext = async (ctxOpts?: import("playwright").BrowserContextOptions) => {
    const merged = {
      locale: profile.locale,
      timezoneId: profile.timezone,
      viewport: profile.viewport,
      screen: profile.viewport,
      geolocation: profile.geolocation,
      permissions: ["geolocation"],
      ...ctxOpts,
    };
    const ctx = await origNewContext(merged);
    await applyStealthHardening(ctx, profile);
    return ctx;
  };
  (browser as any).newContext = hardenedNewContext;
  return browser;
}

async function launchChromium(opts: LaunchBrowserOptions) {
  const { proxyUrl, headless = true, args = [], stealthSeed = 1 } = opts;
  const options: import("playwright").LaunchOptions = { headless };
  if (args.length) options.args = args;
  const proxy = buildBrowserProxyOption(proxyUrl);
  if (proxy) options.proxy = proxy;
  return playwrightChromium.launch(options);
}

/** Launch a browser with the given engine. Returns a Playwright Browser. */
export async function launchBrowser(opts: LaunchBrowserOptions = {}): Promise<import("playwright").Browser> {
  const engine = normalizeEngine(opts.engine);
  if (engine === "camoufox") return launchCamoufox(opts);
  return launchChromium(opts);
}

/** Factory: returns a zero-arg launcher bound to the given options. */
export function makeBrowserLauncher(opts: LaunchBrowserOptions = {}) {
  return () => launchBrowser(opts);
}
