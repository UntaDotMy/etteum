/**
 * 5sim.net SMS-OTP client — TS port of the reference proxy's
 * src/lib/oauth/services/fiveSimClient.js, 1:1.
 *
 * Rents a virtual phone number, polls for the OTP SMS, parses the code, and
 * releases/cancels the number. Used for phone-verified signups (codebuddy-cn).
 */
const FIVE_SIM_API_BASE = "https://5sim.net/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_INITIAL_OTP_POLL_DELAY_MS = 5_000;
const DEFAULT_OTP_TIMEOUT_MS = 120_000;
const PRICE_CACHE_TTL_MS = 30_000;
const PRICE_CACHE_STALE_TTL_MS = 5 * 60_000;
const GUEST_RETRY_DELAYS_MS = [250, 750];
const PROFILE_RETRY_DELAYS_MS = [250, 750, 1500];
const MIN_CHECK_POLL_INTERVAL_MS = 5_000;
const FIVE_SIM_COOLDOWN_MS = 10 * 60_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FiveSimSmsItem { code?: string; text?: string }
interface FiveSimOrder { sms?: FiveSimSmsItem[]; [k: string]: any; code?: string }
interface FiveSimProfile { balance?: number; [k: string]: any }
interface FiveSimPriceMeta { count?: number; cost?: number }
interface FiveSimOffer { operator: string; cost: number; count: number }
interface FiveSimQuote {
  country: string; product: string; operator: string; balance: number;
  selectedOffer: FiveSimOffer | null; availableCount: number;
  unitCost: number | null; purchasableByBalance: number; capacity: number;
  noStockMessage: string;
}

function extractOtpCode(payload: FiveSimOrder): string {
  const sms = Array.isArray(payload?.sms) ? payload.sms : [];
  for (const item of sms) {
    if (item?.code) return String(item.code).trim();
    const text = String(item?.text || "");
    const match = text.match(/\b(\d{4,8})\b/);
    if (match) return match[1] || "";
  }
  return "";
}

function normalizeOrder(payload: FiveSimOrder): FiveSimOrder {
  return { ...payload, code: extractOtpCode(payload) };
}

function buildQuery(params: Record<string, any>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const clean = String(value || "").trim().toLowerCase();
    if (clean) searchParams.set(key, clean);
  }
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

function listAvailableOffers(prices: any, country: string, product: string): FiveSimOffer[] {
  const countryPrices = prices?.[country] || {};
  const productPrices = countryPrices?.[product] || {};
  return Object.entries(productPrices)
    .filter(([, meta]: [any, any]) => Number(meta?.count || 0) > 0)
    .map(([operator, meta]: [string, any]) => ({
      operator,
      cost: Number(meta?.cost ?? Number.POSITIVE_INFINITY),
      count: Number(meta?.count || 0),
    }))
    .sort((left, right) => left.cost !== right.cost ? left.cost - right.cost : right.count - left.count);
}

function buildNoStockMessage(country: string, product: string, operator: string): string {
  const scope = operator && operator !== "any" ? `${operator} operator` : "any operator";
  return `No available 5sim phone numbers for ${product} in ${country} using ${scope}`;
}

interface FiveSimError extends Error { status?: number; path?: string; code?: string; cooldownMs?: number; order?: any; lastError?: any }

function createFiveSimCooldownError(path: string, message?: string): FiveSimError {
  const error = new Error(message || "5sim temporarily banned this IP/API key; wait 10 minutes before retrying.") as FiveSimError;
  error.status = 444;
  error.path = path;
  error.code = "FIVE_SIM_COOLDOWN";
  error.cooldownMs = FIVE_SIM_COOLDOWN_MS;
  return error;
}

function isFiveSimCooldownError(error: any): boolean {
  return error?.code === "FIVE_SIM_COOLDOWN" || Number(error?.status || 0) === 444;
}

function isTransientRequestError(error: any): boolean {
  const status = Number(error?.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

function getCheckBackoffDelay(error: any, currentDelay: number): number {
  const status = Number(error?.status || 0);
  if (status === 429) return Math.min(Math.max(currentDelay * 2, 10_000), 60_000);
  if (status === 503) return Math.min(Math.max(currentDelay * 2, 10_000), 30_000);
  if (status === 504) return Math.min(Math.max(Math.ceil(currentDelay * 1.5), 8_000), 20_000);
  return Math.min(Math.max(Math.ceil(currentDelay * 1.5), MIN_CHECK_POLL_INTERVAL_MS), 30_000);
}

export interface FiveSimClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  waitImpl?: (ms: number) => Promise<void>;
  proxyUrl?: string;
}

export class FiveSimClient {
  private token: string;
  private fetchImpl: typeof fetch;
  private baseUrl: string;
  private waitImpl: (ms: number) => Promise<void>;
  private proxyUrl: string;
  private priceCache: Map<string, any>;

  constructor({ token, fetchImpl = fetch, baseUrl = FIVE_SIM_API_BASE, waitImpl = wait, proxyUrl }: FiveSimClientOptions) {
    this.token = String(token || "").trim();
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || FIVE_SIM_API_BASE).replace(/\/$/, "");
    this.waitImpl = waitImpl;
    this.proxyUrl = String(proxyUrl || "").trim();
    this.priceCache = new Map();
  }

  private async fetchJson(path: string, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers, signal: controller.signal } as any);
      const text = await response.text?.() ?? "";
      let payload: any = null;
      try { payload = text ? JSON.parse(text) : await response.json(); } catch { payload = { message: text }; }
      if (!response.ok) {
        const msg = payload?.message || payload?.error || text || `5sim HTTP ${response.status}`;
        if (response.status === 444) throw createFiveSimCooldownError(path, "5sim temporarily banned this IP/API key; wait 10 minutes before retrying.");
        const error = new Error(`5sim HTTP ${response.status} for ${path}: ${msg}`) as FiveSimError;
        error.status = response.status; error.path = path; throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(path: string, opts?: { timeoutMs?: number }): Promise<any> {
    if (!this.token) throw new Error("5sim token is required");
    return this.fetchJson(path, { timeoutMs: opts?.timeoutMs, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } });
  }

  private async guestRequest(path: string, opts?: { timeoutMs?: number }): Promise<any> {
    return this.fetchJson(path, { timeoutMs: opts?.timeoutMs, headers: { Accept: "application/json" } });
  }

  async getProfile(): Promise<FiveSimProfile> {
    let lastError: any = null;
    for (let attempt = 0; attempt <= PROFILE_RETRY_DELAYS_MS.length; attempt++) {
      try { return await this.request("/user/profile"); }
      catch (error) { lastError = error; if (!isTransientRequestError(error) || attempt === PROFILE_RETRY_DELAYS_MS.length) break; await this.waitImpl(PROFILE_RETRY_DELAYS_MS[attempt] ?? 500); }
    }
    throw lastError;
  }

  async getPrices({ country, product }: { country?: string; product?: string } = {}): Promise<any> {
    const path = `/guest/prices${buildQuery({ country, product })}`;
    const cacheKey = path;
    const now = Date.now();
    const cached = this.priceCache.get(cacheKey);
    if (cached?.payload && cached.expiresAt > now) return cached.payload;
    if (cached?.inFlight) return cached.inFlight;
    const inFlight = (async () => {
      let lastError: any = null;
      for (let attempt = 0; attempt <= GUEST_RETRY_DELAYS_MS.length; attempt++) {
        try {
          const payload = await this.guestRequest(path);
          this.priceCache.set(cacheKey, { payload, expiresAt: Date.now() + PRICE_CACHE_TTL_MS, staleUntil: Date.now() + PRICE_CACHE_STALE_TTL_MS, inFlight: null });
          return payload;
        } catch (error) { lastError = error; if (!isTransientRequestError(error) || attempt === GUEST_RETRY_DELAYS_MS.length) break; await this.waitImpl(GUEST_RETRY_DELAYS_MS[attempt] ?? 500); }
      }
      if (cached?.payload && cached.staleUntil > Date.now()) return cached.payload;
      throw lastError;
    })();
    this.priceCache.set(cacheKey, { ...cached, inFlight });
    try { return await inFlight; }
    finally {
      const current = this.priceCache.get(cacheKey);
      if (current?.inFlight === inFlight) {
        if (current.payload) this.priceCache.set(cacheKey, { ...current, inFlight: null });
        else this.priceCache.delete(cacheKey);
      }
    }
  }

  async buyActivation({ country = "hongkong", operator = "any", product = "codebuddy" }: { country?: string; operator?: string; product?: string } = {}): Promise<any> {
    const normalizedCountry = String(country || "hongkong").trim().toLowerCase();
    const normalizedProduct = String(product || "codebuddy").trim().toLowerCase();
    const cleanCountry = encodeURIComponent(normalizedCountry);
    const cleanProduct = encodeURIComponent(normalizedProduct);
    const requestedOperator = String(operator || "any").trim().toLowerCase();
    const cleanOperator = encodeURIComponent(requestedOperator || "any");
    const path = `/user/buy/activation/${cleanCountry}/${cleanOperator}/${cleanProduct}`;
    const BUY_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 8000];
    let lastError: any = null;
    for (let attempt = 0; attempt <= BUY_RETRY_DELAYS_MS.length; attempt++) {
      try { return await this.request(path); }
      catch (error) { lastError = error; if (isFiveSimCooldownError(error)) throw error; if (!isTransientRequestError(error) || attempt === BUY_RETRY_DELAYS_MS.length) break; await this.waitImpl(BUY_RETRY_DELAYS_MS[attempt] ?? 500); }
    }
    throw lastError;
  }

  async getActivationQuote({ country = "hongkong", operator = "any", product = "codebuddy" }: { country?: string; operator?: string; product?: string } = {}): Promise<FiveSimQuote> {
    const normalizedCountry = String(country || "hongkong").trim().toLowerCase();
    const normalizedProduct = String(product || "codebuddy").trim().toLowerCase();
    const requestedOperator = String(operator || "any").trim().toLowerCase();
    const [profile, prices] = await Promise.all([this.getProfile(), this.getPrices({ country: normalizedCountry, product: normalizedProduct })]);
    const offers = listAvailableOffers(prices, normalizedCountry, normalizedProduct);
    const candidates = requestedOperator && requestedOperator !== "any" ? offers.filter((o) => o.operator === requestedOperator) : offers;
    const selectedOffer = candidates[0] || null;
    const balance = Number(profile?.balance ?? 0);
    const unitCost = Number(selectedOffer?.cost ?? 0);
    const purchasableByBalance = unitCost > 0 ? Math.floor(balance / unitCost) : 0;
    const availableCount = Number(selectedOffer?.count || 0);
    return {
      country: normalizedCountry, product: normalizedProduct, operator: requestedOperator || "any", balance,
      selectedOffer, availableCount, unitCost: selectedOffer ? unitCost : null,
      purchasableByBalance: selectedOffer ? purchasableByBalance : 0,
      capacity: selectedOffer ? Math.min(availableCount, purchasableByBalance) : 0,
      noStockMessage: selectedOffer ? "" : buildNoStockMessage(normalizedCountry, normalizedProduct, requestedOperator || "any"),
    };
  }

  async checkOrder(orderId: string): Promise<FiveSimOrder> {
    const id = encodeURIComponent(String(orderId || "").trim());
    if (!id) throw new Error("5sim order id is required");
    return normalizeOrder(await this.request(`/user/check/${id}`));
  }

  async finishOrder(orderId: string): Promise<any> {
    const id = encodeURIComponent(String(orderId || "").trim());
    if (!id) throw new Error("5sim order id is required");
    return this.request(`/user/finish/${id}`);
  }

  async cancelOrder(orderId: string): Promise<any> {
    const id = encodeURIComponent(String(orderId || "").trim());
    if (!id) throw new Error("5sim order id is required");
    return this.request(`/user/cancel/${id}`);
  }

  async waitForCode(orderId: string, { timeoutMs = DEFAULT_OTP_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, initialDelayMs = DEFAULT_INITIAL_OTP_POLL_DELAY_MS } = {}): Promise<FiveSimOrder> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const minPollInterval = Math.max(MIN_CHECK_POLL_INTERVAL_MS, Number.parseInt(String(pollIntervalMs), 10) || DEFAULT_POLL_INTERVAL_MS);
    let nextDelayMs = minPollInterval;
    let lastOrder: FiveSimOrder | null = null;
    let lastError: any = null;
    const firstDelay = Math.min(Math.max(0, Number.parseInt(String(initialDelayMs), 10) || 0), Math.max(0, deadline - Date.now()));
    if (firstDelay > 0) await this.waitImpl(firstDelay);
    while (Date.now() < deadline) {
      try {
        lastOrder = await this.checkOrder(orderId);
        lastError = null;
        nextDelayMs = minPollInterval;
        if (lastOrder.code) return lastOrder;
      } catch (error) {
        if (isFiveSimCooldownError(error)) throw error;
        if (!isTransientRequestError(error)) throw error;
        lastError = error;
        nextDelayMs = getCheckBackoffDelay(error, nextDelayMs);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitImpl(Math.min(nextDelayMs, remaining));
    }
    const suffix = lastError?.message ? `; last 5sim error: ${lastError.message}` : "";
    const error = new Error(`Timed out waiting for 5sim OTP code${suffix}`) as FiveSimError;
    error.order = lastOrder; error.lastError = lastError;
    throw error;
  }
}

export function createFiveSimClient(options: FiveSimClientOptions): FiveSimClient {
  return new FiveSimClient(options);
}
