import { bulkTimeoutMs, BULK_API_TIMEOUT_MS } from "./bulkTimeout";
export { bulkTimeoutMs, BULK_API_TIMEOUT_MS };

function resolveApiBase(): string {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  // Prefer same-origin: serve-dashboard proxies /api/* → backend (public admin,
  // custom ports, cookies, no CORS). Override with VITE_API_BASE only if needed.
  return window.location.origin;
}

export const API_BASE = resolveApiBase();

export function getWsBase(): string {
  const configured = import.meta.env.VITE_WS_BASE;
  if (configured) return configured;
  const { port, hostname, protocol: httpProto } = window.location;
  const protocol = httpProto === "https:" ? "wss" : "ws";
  // Same-origin WebSocket so the dashboard session cookie is sent on upgrade.
  // serve-dashboard proxies /ws → backend; backend also serves /ws when the UI
  // is opened on PORT directly. Override with VITE_WS_BASE only if needed.
  if (!port || port === "443" || port === "80") {
    return `${protocol}://${hostname}`;
  }
  return `${protocol}://${hostname}:${port}`;
}

function getApiKey(): string {
  // No hardcoded default — empty means "rely on session cookie only".
  return localStorage.getItem("api_key") || "";
}

export { getApiKey };

export async function validateApiKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/keys/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ key }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

/** Dashboard JWT session status (password / OIDC cookie). */
export async function getDashboardAuthStatus(): Promise<{
  authenticated: boolean;
  user: { email: string; method: string } | null;
  oidcEnabled: boolean;
  passwordConfigured: boolean;
} | null> {
  try {
    const res = await fetch(`${API_BASE}/api/dashboard-auth/status`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function loginWithPassword(password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/dashboard-auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any)?.error || `Login failed (${res.status})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Login failed" };
  }
}

export async function logoutDashboardSession(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/dashboard-auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch { /* best-effort */ }
}

export function isAuthenticated(): boolean {
  // Session cookie is checked server-side; local flag covers API-key mode and
  // a soft marker set after successful password login.
  return !!localStorage.getItem("api_key") || localStorage.getItem("dashboard_session") === "1";
}

export async function logout() {
  localStorage.removeItem("api_key");
  localStorage.removeItem("dashboard_session");
  await logoutDashboardSession();
}

type FetchApiOptions = RequestInit & {
  /**
   * Client abort timeout (ms). Default 30s for normal UI calls.
   * Use bulkTimeoutMs(n) for bulk add/import/instant-login so the browser does
   * not abort while the server is still writing accounts.
   * Set 0 to disable the client timeout.
   */
  timeoutMs?: number;
};

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return (
    e.name === "AbortError" ||
    e.name === "TimeoutError" ||
    /aborted|AbortError|The operation was aborted/i.test(String(e.message || ""))
  );
}

/**
 * Normalize API error payloads. Auth middleware returns
 * `{ error: { message, type } }` while many routes return `{ error: "string" }`.
 * Without unwrapping, `new Error(object)` becomes "[object Object]" in the UI.
 */
function formatApiErrorBody(body: unknown, status: number): string {
  if (body == null) return `API error: ${status}`;
  if (typeof body === "string") return body || `API error: ${status}`;
  if (typeof body !== "object") return String(body);

  const rec = body as Record<string, unknown>;
  const err = rec.error ?? rec.message;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const nested = err as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim()) return nested.message;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  if (typeof rec.message === "string" && rec.message.trim()) return rec.message;
  return `API error: ${status}`;
}

export async function fetchApi<T = any>(path: string, options?: FetchApiOptions): Promise<T> {
  const { timeoutMs = 30_000, signal, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const abortOnSignal = () => controller.abort(signal?.reason);
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abortOnSignal, { once: true });
  }

  try {
    const key = getApiKey();
    const res = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      credentials: "include",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        // Dual gate: send Bearer when we have an API key; otherwise rely on
        // the dashboard JWT httpOnly cookie (credentials: include).
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...fetchOptions.headers,
      },
    });

    if (!res.ok) {
      let message = `API error: ${res.status}`;
      try {
        const body = await res.json();
        message = formatApiErrorBody(body, res.status);
      } catch {
        const text = await res.text().catch(() => "");
        if (text) message = text;
      }
      throw new Error(message);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? JSON.parse(text) : (undefined as T);
  } catch (err) {
    if (isAbortError(err)) {
      const secs = timeoutMs > 0 ? Math.round(timeoutMs / 1000) : 0;
      throw new Error(
        timeoutMs > 0
          ? `Request timed out after ${secs}s. For bulk add/import the server may still be writing accounts — refresh the list. If this keeps happening, split into smaller batches.`
          : "Request was aborted.",
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortOnSignal);
  }
}

export function clampLimit(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPollingLoop(fn: () => Promise<void>, intervalMs: number, signal: AbortSignal) {
  while (!signal.aborted) {
    await fn().catch(() => {});
    await Promise.race([
      sleep(intervalMs),
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ]);
  }
}

export async function fetchDashboardStats(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats${qs ? `?${qs}` : ""}`);
}

export async function fetchAccounts() {
  return fetchApi("/api/accounts");
}

export async function fetchProviders() {
  return fetchApi("/api/stats/providers");
}

export async function fetchUsage(hours: number | null = 24, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null) params.set("hours", String(hours));
  if (range) params.set("range", range);
  params.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return fetchApi(`/api/stats/usage?${params.toString()}`);
}

export async function fetchModelUsage(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats/models${qs ? `?${qs}` : ""}`);
}

/**
 * Recent request logs from the DB (request_logs table, max 500).
 * Used to seed the Analytics "Recent Activity" feed on mount so a refresh
 * doesn't wipe it — without this the feed is live-only and goes blank on reload.
 */
export async function fetchRecentRequests(limit = 30) {
  return fetchApi(`/api/stats/requests?limit=${limit}`);
}

export async function refreshAccountQuota(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/refresh-quota`, {
    method: "POST",
  });
}

export async function warmupAccount(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/warmup`, {
    method: "POST",
  });
}

export async function warmupAccounts(accountIds: number[]) {
  return fetchApi("/api/auth/warmup-bulk", {
    method: "POST",
    body: JSON.stringify({ accountIds }),
  });
}

export async function warmupAllAccounts(options?: { providers?: string[]; statuses?: string[]; includePending?: boolean }) {
  return fetchApi("/api/auth/warmup-all", {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function fetchWarmupQueue() {
  return fetchApi("/api/accounts/warmup-queue");
}

/** Stop warmup hard: drops queued items AND aborts in-flight provider calls. */
export async function stopWarmup() {
  return fetchApi("/api/auth/warmup-stop", { method: "POST" });
}

export async function fetchWarmupEvents(limit: number = 300) {
  return fetchApi(`/api/auth/warmup-events?limit=${clampLimit(limit, 300, 1, 1000)}`);
}

export interface AutoWarmupStatus {
  running: boolean;
  intervalMinutes: number; // global default
  enabledProviders: string[];
  /** Per-provider interval overrides (only present for enabled providers). */
  providerIntervals?: Record<string, number>;
  /** Per-provider next-run timestamps (ISO strings). */
  providerNextRunAt?: Record<string, string | null>;
  /** Per-provider last-run timestamps (ISO strings). */
  providerLastRunAt?: Record<string, string | null>;
  /** Earliest next run across all enabled providers (backwards compat). */
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export async function fetchAutoWarmupStatus(): Promise<AutoWarmupStatus> {
  return fetchApi<AutoWarmupStatus>("/api/auth/warmup-schedule");
}

export async function fetchRequests(page: number = 1, limit: number = 50, provider?: string) {
  const safeLimit = clampLimit(limit, 50, 1, 500);
  const safePage = clampLimit(page, 1, 1, 1000);
  const offset = (safePage - 1) * safeLimit;
  const params = new URLSearchParams({ limit: String(safeLimit), offset: String(offset) });
  if (provider && provider !== "all") params.set("provider", provider);
  return fetchApi(`/api/stats/requests?${params.toString()}`);
}

/**
 * Fetch full detail (including heavy requestBody / responseBody) for a single
 * request log. Used by the Requests page detail drawer so the list endpoint
 * can stay lightweight.
 */
export async function fetchRequestDetail(id: number) {
  return fetchApi<{ data: unknown }>(`/api/stats/requests/${id}`);
}

export async function fetchModels() {
  return fetchApi("/v1/models");
}

/**
 * Full catalog with resolved USD pricing (baseline MODEL_PRICING + kv overrides).
 * Prefer this over /v1/models for the dashboard Models page — /v1/models is the
 * OpenAI client surface and does not attach pricing.
 */
export async function fetchModelsCatalog(): Promise<{ data: Array<Record<string, unknown>> }> {
  const res = (await fetchApi("/api/models/all")) as { models?: Array<Record<string, unknown>> };
  return { data: res.models || [] };
}

/**
 * Fetch ONLY models backed by an active+enabled account (with resolved pricing).
 * Response is normalized to `{ data }` for the dashboard.
 */
export async function fetchActiveModels(): Promise<{ data: Array<Record<string, unknown>> }> {
  const res = (await fetchApi("/api/models/active")) as {
    models?: Array<Record<string, unknown>>;
    data?: Array<Record<string, unknown>>;
  };
  return { data: res.data || res.models || [] };
}

// --- F15: dashboard-driven model catalog (custom / disabled / pricing CRUD) ---

export interface CustomModelSpec {
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
}
export interface CustomModelEntry {
  provider: string;
  displayName?: string;
  spec?: CustomModelSpec;
  /** Old catalog id this entry renames (catalog rename feature). */
  renameFrom?: string;
  /** Upstream API model name to send to the provider. */
  upstreamName?: string;
}
export type CustomModelsMap = Record<string, CustomModelEntry>;
export type DisabledModelsMap = Record<string, { provider: string; model: string; disabledAt?: number }>;
export interface ModelPricingEntry {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
  reasoningPer1M?: number;
  cacheCreationPer1M?: number;
}
export type PricingMap = Record<string, ModelPricingEntry>;

/** All dashboard-added custom models (kv(customModels)). */
export async function fetchCustomModels(): Promise<{ custom: CustomModelsMap }> {
  return fetchApi("/api/models/custom");
}

/** Add (or update) a custom model for a provider. Carries an optional spec override,
 *  and optional rename/upstream-name for catalog edits. */
export async function saveCustomModel(input: {
  model: string;
  provider: string;
  displayName?: string;
  spec?: CustomModelSpec;
  renameFrom?: string;
  upstreamName?: string;
}): Promise<{ success: boolean }> {
  return fetchApi("/api/models/custom", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Remove a custom model. */
export async function deleteCustomModel(model: string): Promise<{ success: boolean }> {
  return fetchApi(`/api/models/custom/${encodeURIComponent(model)}`, { method: "DELETE" });
}

/**
 * Resolve a provider-prefixed alias to its CANONICAL model name -- mirrors the
 * backend toCanonicalModelName (pricing.ts). The catalog (specs/pricing) is
 * keyed by canonical name, so edits/overrides must be stored under the model,
 * NOT the provider alias (cbc-/qd-/kp-/...), so they apply across providers.
 */
export function toCanonicalModelName(model: string | undefined | null): string {
  if (!model) return "";
  // Must stay in parity with backend src/proxy/pricing.ts toCanonicalModelName.
  let m = model.trim().toLowerCase();
  if (m.includes("/")) m = m.slice(m.lastIndexOf("/") + 1);
  if (m.startsWith("kp-") || m.startsWith("kp_")) {
    const rest = m.slice(3);
    m = /^(opus|sonnet|haiku|fable|mythos)[-_]/.test(rest) ? "claude-" + rest : rest;
  }
  if (m.startsWith("cbc-") || m.startsWith("cbc_")) m = m.slice(4);
  else if (m.startsWith("cb-") || m.startsWith("cb_")) m = m.slice(3);
  else if (m.startsWith("qd-") || m.startsWith("qd_")) m = m.slice(3);
  else if (m.startsWith("ym-") || m.startsWith("ym_")) m = m.slice(3);
  else if (m.startsWith("ali-") || m.startsWith("ali_")) m = m.slice(4);
  else if (m.startsWith("ag-") || m.startsWith("ag_")) m = m.slice(3);
  else if (m.startsWith("codex-") || m.startsWith("codex_")) m = m.slice(6);
  else if (m.startsWith("gitlab-duo:")) m = m.slice(11);
  m = m.replace(/[-_]thinking$/i, "");
  m = m.replace(/-1m$/i, "");
  // Lookup only: gpt_5.2 → gpt-5.2 for pricing/spec. Do not rewrite list ids.
  m = m.replace(/_/g, "-");
  if (/^(opus|sonnet|haiku|fable|mythos)-/.test(m) && !m.startsWith("claude-")) {
    m = "claude-" + m;
  }
  if (m === "kimi-k2.7") m = "kimi-k2.7-code";
  if (m === "deepseek-v3-2" || m === "deepseek-v3-2-volc") m = "deepseek-v3.2";
  if (m === "deepseek-r1") m = "deepseek-reasoner";
  if (m === "deepseek-v3") m = "deepseek-chat";
  m = m.replace(/^gemini-3\.0-/, "gemini-3-");
  if (m === "claude-3.5-sonnet") m = "claude-3-5-sonnet-20241022";
  if (m === "auto" || m === "auto-review") m = "gpt-5.5";
  if (m === "ultimate") m = "claude-opus-4.8";
  else if (m === "performance") m = "claude-sonnet-4.6";
  else if (m === "efficient") m = "claude-haiku-4.5";
  else if (m === "lite") m = "gpt-4o-mini";
  if (/^llama-3\.3-70b/.test(m) || m === "llama-v3p3-70b-instruct") m = "llama-3.3-70b-versatile";
  if (/^llama-3\.1-70b/.test(m) || /405b/.test(m)) m = "llama-3.1-70b-versatile";
  if (m === "qwen2p5-72b-instruct") m = "qwen-plus";
  if (m === "default") m = "gpt-5.5";
  return m;
}

/** All disabled models (kv(disabledModels), keyed provider:model). */
export async function fetchDisabledModels(): Promise<{ disabled: DisabledModelsMap }> {
  return fetchApi("/api/models/disabled");
}

/** Enable (disabled=false) or disable (disabled=true) a model. */
export async function setModelDisabled(
  provider: string,
  model: string,
  disabled: boolean,
): Promise<{ success: boolean }> {
  return fetchApi("/api/models/disabled", {
    method: "POST",
    body: JSON.stringify({ provider, model, disabled }),
  });
}

/** Probe a model's connectivity (1-token completion via the provider). */
export async function testModel(
  provider: string,
  model: string,
  accountId?: number,
): Promise<{ ok: boolean; error?: string; account?: { id: number; email: string; provider: string } }> {
  return fetchApi("/api/models/test", {
    method: "POST",
    body: JSON.stringify({ provider, model, accountId }),
  });
}

/** Per-model USD pricing (kv(pricing), $/1M tokens). */
export async function fetchModelPricing(): Promise<{ pricing: PricingMap }> {
  return fetchApi("/api/pricing");
}

/** Set per-model pricing. Any of the rate fields may be omitted to keep existing. */
export async function setModelPricing(
  model: string,
  rates: Omit<ModelPricingEntry, never>,
): Promise<{ success: boolean }> {
  return fetchApi("/api/pricing", {
    method: "POST",
    body: JSON.stringify({ model, ...rates }),
  });
}

export interface ModelMappingDTO {
  id?: number;
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label?: string | null;
}

export interface IntegrationData {
  enabled: boolean;
  mappings: ModelMappingDTO[];
  models?: { id: string; owned_by: string }[];
}

export async function fetchIntegration(): Promise<IntegrationData> {
  return fetchApi("/api/integration");
}

export async function saveIntegration(payload: { enabled?: boolean; mappings?: ModelMappingDTO[] }) {
  return fetchApi("/api/integration", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export interface ApplyConfigResult {
  success: boolean;
  path: string;
  config: Record<string, unknown>;
}

export async function applyIntegrationConfig(baseUrl: string): Promise<ApplyConfigResult> {
  return fetchApi("/api/integration/apply-config", {
    method: "POST",
    body: JSON.stringify({ baseUrl }),
  });
}

// ── Multi-Client Integration ─────────────────────────────────────

export interface ClientMetaDTO {
  id: string;
  name: string;
  description: string;
  cli: string;
  url: string;
  detected: boolean;
  configPaths: string[];
}

export interface IntegrationModelDTO {
  id: string;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
}

export interface IntegrationClientsData {
  clients: ClientMetaDTO[];
  models: IntegrationModelDTO[];
}

export interface ClientConfigPreviewDTO {
  client: string;
  success: boolean;
  preview?: Record<string, unknown>;
  paths: string[];
  backupPaths: string[];
  error?: string;
}

export interface ApplyClientResult {
  client: string;
  success: boolean;
  paths: string[];
  backupPaths: string[];
  error?: string;
}

export interface ApplyAllResult {
  success: boolean;
  results: ApplyClientResult[];
}

export async function fetchIntegrationClients(): Promise<IntegrationClientsData> {
  return fetchApi("/api/integration/clients");
}

export async function fetchClientConfigPreview(
  clientId: string,
  baseUrl: string,
  modelId?: string
): Promise<ClientConfigPreviewDTO> {
  return fetchApi(`/api/integration/clients/${clientId}/preview`, {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId }),
  });
}

export async function applyClientConfig(
  clientId: string,
  baseUrl: string,
  modelId?: string
): Promise<ApplyClientResult> {
  return fetchApi(`/api/integration/clients/${clientId}/apply`, {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId }),
  });
}

export async function applyAllClients(
  baseUrl: string,
  modelId?: string
): Promise<ApplyAllResult> {
  return fetchApi("/api/integration/apply-all", {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId }),
  });
}

export async function restoreClientConfig(
  clientId: string
): Promise<{ success: boolean; path?: string; restoredFrom?: string; error?: string }> {
  return fetchApi(`/api/integration/clients/${clientId}/restore`, {
    method: "POST",
  });
}

export async function fetchSettings() {
  return fetchApi("/api/settings");
}

export async function updateSettings(settings: Record<string, string>) {
  return fetchApi("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function fetchProviderList(): Promise<{ data: string[] }> {
  return fetchApi("/api/settings/providers");
}

export async function createAccount(account: { provider: string; email: string; password: string; browserEngine?: string; headless?: boolean }) {
  return fetchApi("/api/accounts", {
    method: "POST",
    body: JSON.stringify(account),
  });
}

export async function deleteAccount(id: number) {
  return fetchApi(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function bulkDeleteAccounts(ids: number[]): Promise<{
  success: boolean;
  requested: number;
  deleted: number;
  deletedIds: number[];
  providers: string[];
  notFound: number[];
}> {
  return fetchApi("/api/accounts/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
    timeoutMs: bulkTimeoutMs(ids.length, 500),
  });
}

export async function toggleAccountEnabled(id: number, enabled?: boolean) {
  return fetchApi<{ id: number; enabled: boolean; status: string; provider: string }>(
    `/api/accounts/${id}/toggle`,
    {
      method: "POST",
      body: JSON.stringify(typeof enabled === "boolean" ? { enabled } : {}),
    },
  );
}

export async function toggleAllAccounts(provider: string, enabled: boolean) {
  return fetchApi<{ provider: string; enabled: boolean; count: number }>(
    "/api/accounts/toggle-all",
    {
      method: "POST",
      body: JSON.stringify({ provider, enabled }),
    },
  );
}

export async function loginAccount(id: number, options?: { headless?: boolean }) {
  return fetchApi(`/api/auth/login/${id}`, {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function loginAccounts(accountIds: number[], options?: { headless?: boolean }) {
  return fetchApi("/api/auth/login-bulk", {
    method: "POST",
    body: JSON.stringify({ accountIds, ...(options || {}) }),
  });
}

export async function loginAllAccounts(options?: { headless?: boolean; concurrency?: number }) {
  return fetchApi("/api/auth/login-all", {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

/** Reveal the stored API key for key-based providers (byok, codebuddy-china, youmind). */
export async function revealApiKey(id: number) {
  return fetchApi<{ success: boolean; id: number; provider: string; apiKey: string }>(
    `/api/accounts/${id}/reveal`,
    { method: "POST" },
  );
}

export async function openPanel(id: number) {
  return fetchApi(`/api/accounts/${id}/open-panel`, { method: "POST" });
}

export async function stopAccount(id: number) {
  return fetchApi(`/api/auth/stop/${id}`, { method: "POST" });
}

export async function stopAllAccounts() {
  return fetchApi("/api/auth/stop-all", { method: "POST" });
}

/** Submit a manual-challenge answer (e.g. CAPTCHA) to a running antigravity manual login. */
export async function submitChallengeAnswer(accountId: number, answer: string) {
  return fetchApi(`/api/accounts/${accountId}/challenge-answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}

/** Cancel a running antigravity manual login (visible-frame) session. */
export async function cancelManualLogin(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/cancel-manual`, { method: "POST" });
}

export async function importAccounts(text: string, providers: string[], options?: { headless?: boolean; concurrency?: number; browserEngine?: string }) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  return fetchApi("/api/auth/import", {
    method: "POST",
    body: JSON.stringify({ text, providers, ...(options || {}) }),
    // Queue + DB inserts for large pastes; 30s default aborted mid-way.
    timeoutMs: bulkTimeoutMs(lines, 200),
  });
}

/** Instant-login / bulk refresh-token exchange (kiro-pro, codex, grok). */
export async function instantLoginTokens(
  tokens: string[],
  provider: string,
): Promise<{ success: number; failed: number; errors?: string[] }> {
  return fetchApi("/api/accounts/instant-login", {
    method: "POST",
    body: JSON.stringify({ tokens, provider }),
    // Per-token upstream exchange; 100 tokens easily exceeds 30s.
    timeoutMs: bulkTimeoutMs(tokens.length, 3_000),
  });
}

export async function fetchAuthQueue() {
  return fetchApi("/api/auth/queue");
}

export async function fetchAuthLogs(limit: number = 200) {
  return fetchApi(`/api/auth/logs?limit=${clampLimit(limit, 200, 1, 1000)}`);
}

export async function clearAuthLogs() {
  return fetchApi("/api/auth/logs", { method: "DELETE" });
}

export async function fetchApiKey() {
  return fetchApi("/api/keys");
}

export async function regenerateApiKey() {
  return fetchApi("/api/keys/regenerate", { method: "POST" });
}

export async function setApiKey(key: string) {
  return fetchApi("/api/keys/set", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

export async function testApiKey(key: string) {
  return fetchApi("/api/keys/test", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

// Proxy Pool
export async function fetchProxyPool() {
  return fetchApi("/api/proxy-pool/pool");
}

export async function addProxies(proxies: string[]) {
  return fetchApi("/api/proxy-pool/pool", {
    method: "POST",
    body: JSON.stringify({ proxies }),
  });
}

export async function updateProxy(id: number, data: { status?: string; label?: string }) {
  return fetchApi(`/api/proxy-pool/pool/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteProxy(id: number) {
  return fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
}

// ── Updates ────────────────────────────────────────────────────────────────

export interface UpdateStatus {
  currentCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  currentVersion: string;
  branch: string;
  lastCheckedAt: string | null;
  error?: string;
}

export interface ApplyStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ApplyResult {
  ok: boolean;
  steps: ApplyStep[];
  restarted: boolean;
  supervisor: string;
  manualCommand?: string;
}

export async function fetchUpdateStatus(force = false): Promise<{ data: UpdateStatus }> {
  const q = force ? "?force=1" : "";
  return fetchApi(`/api/update/status${q}`, { timeoutMs: 30_000 });
}

export async function applyUpdate(): Promise<{ data: ApplyResult }> {
  // Backend requires { confirm: true } (accidental-trigger guard). UI already
  // shows a confirm dialog before calling this. Apply can take a while
  // (git pull + dashboard build + migrate + restart).
  return fetchApi("/api/update/apply", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
    timeoutMs: 180_000,
  });
}

// ── Backup export / import (migrate install to another PC) ──────────────────

export type BackupStatusCounts = {
  accounts: number;
  settings: number;
  apiKeys: number;
  proxyPool: number;
  requestLogs: number;
  filterRules: number;
  combos: number;
  modelMappings: number;
  vccCards: number;
};

export type BackupExportResult = {
  dir: string;
  zipPath: string | null;
  downloadUrl: string | null;
  mode: "essential" | "full";
  createdAt: string;
  counts: Record<string, number>;
  databaseBytes: number;
  envBytes: number;
  hasJwtSecret: boolean;
  hint: string;
};

export async function fetchBackupStatus(): Promise<{ data: BackupStatusCounts }> {
  return fetchApi("/api/backup/status");
}

/** Create backup pack on server; download zip when available. */
export async function createAndDownloadBackup(
  mode: "essential" | "full" = "essential",
): Promise<BackupExportResult> {
  const res = await fetchApi<{ data: BackupExportResult }>("/api/backup/export", {
    method: "POST",
    body: JSON.stringify({ mode }),
    timeoutMs: 300_000,
  });
  const data = res.data;
  if (data.downloadUrl) {
    const key = getApiKey();
    const fileRes = await fetch(`${API_BASE}${data.downloadUrl}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!fileRes.ok) {
      throw new Error(`Download failed (${fileRes.status}). Pack is on disk: ${data.dir}`);
    }
    const blob = await fileRes.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      (data.zipPath && data.zipPath.split(/[/\\]/).pop()) ||
      `etteum-backup-${mode}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return data;
}

/** Upload a .zip backup (multipart). mode=merge appends accounts; replace wipes DB. */
export async function importBackupZip(
  file: File,
  mode: "merge" | "replace" = "merge",
): Promise<{
  data: {
    ok: true;
    mode?: "merge" | "replace";
    preImportBackupDir?: string;
    counts?: Record<string, number>;
    inserted?: number;
    updated?: number;
    skipped?: number;
    totalInPack?: number;
    needsRestart: boolean;
    message: string;
    errors?: string[];
  };
}> {
  const key = getApiKey();
  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  const qs =
    mode === "replace"
      ? "mode=replace&confirm=1"
      : "mode=merge";
  const res = await fetch(`${API_BASE}/api/backup/import?${qs}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text || `Import failed (${res.status})`;
    try {
      const j = JSON.parse(text) as { error?: string; hint?: string };
      if (j.error) msg = j.hint ? `${j.error} (${j.hint})` : j.error;
    } catch {
      /* raw text */
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function clearProxyPool() {
  return fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
}

export async function checkProxy(id: number) {
  return fetchApi(`/api/proxy-pool/pool/${id}/check`, { method: "POST" });
}

export async function checkAllProxies() {
  return fetchApi("/api/proxy-pool/pool/check-all", { method: "POST" });
}

export interface ProxyCountry {
  code: string;
  name: string;
}

export async function fetchProxyCountries(): Promise<{ countries: ProxyCountry[] }> {
  return fetchApi("/api/proxy-pool/scrape/countries");
}

export interface ScrapeProxyResult {
  scraped: number;
  verified: number;
  added: number;
  skipped: number;
}

export async function scrapeProxies(options: {
  source?: "proxyscrape" | "geonode" | "proxifly" | "all";
  country?: string;
  protocol?: "http" | "socks5" | "all";
  limit?: number;
  verify?: boolean;
}): Promise<ScrapeProxyResult> {
  return fetchApi("/api/proxy-pool/scrape", {
    method: "POST",
    body: JSON.stringify(options),
    timeoutMs: 120_000,
  });
}

// Image Studio
export interface AssistModelInfo {
  id: string;
  provider: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function fetchAssistModels(): Promise<{ data: AssistModelInfo[] }> {
  return fetchApi("/api/image-studio/assist-models");
}

export async function assistPrompt(payload: {
  message: string;
  history?: ChatMessage[];
  model?: string;
}): Promise<{ reply: string; options: string[]; finalPrompt: string | null }> {
  return fetchApi("/api/image-studio/assist", {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 90_000,
  });
}

export async function generateImage(payload: {
  prompt: string;
  type?: "image" | "video";
  /** Required model id to route (canva-image, canva-video, grok-image, …). */
  model?: string;
  aspectRatio?: string;
  n?: number;
  chatId?: number | null;
}): Promise<{
  id?: number;
  urls: string[];
  prompt: string;
  type: string;
  aspectRatio: string;
  n: number;
  creditsUsed: number;
  createdAt?: string;
  account: { id: number; email: string };
}> {
  return fetchApi("/api/image-studio/generate", {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 420_000,
  });
}

export interface StoredChat {
  id: number;
  title: string | null;
  messages: ChatMessage[];
  finalPrompt: string | null;
  options: string[];
  assistModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredResult {
  id: number;
  chatId: number | null;
  prompt: string;
  type: "image" | "video";
  aspectRatio: string;
  n: number;
  urls: string[];
  creditsUsed: number;
  createdAt: string;
}

export async function fetchChats(): Promise<{ data: StoredChat[] }> {
  return fetchApi("/api/image-studio/chats");
}

export async function fetchChat(id: number): Promise<StoredChat> {
  return fetchApi(`/api/image-studio/chats/${id}`);
}

export async function createChat(payload: {
  title?: string | null;
  messages?: ChatMessage[];
  finalPrompt?: string | null;
  options?: string[];
  assistModel?: string | null;
}): Promise<StoredChat> {
  return fetchApi("/api/image-studio/chats", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateChat(
  id: number,
  payload: {
    title?: string | null;
    messages?: ChatMessage[];
    finalPrompt?: string | null;
    options?: string[];
    assistModel?: string | null;
  },
): Promise<StoredChat> {
  return fetchApi(`/api/image-studio/chats/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteChat(id: number): Promise<{ ok: boolean }> {
  return fetchApi(`/api/image-studio/chats/${id}`, { method: "DELETE" });
}

export async function fetchResults(params?: {
  chatId?: number;
  limit?: number;
}): Promise<{ data: StoredResult[] }> {
  const qs = new URLSearchParams();
  if (params?.chatId !== undefined) qs.set("chatId", String(params.chatId));
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return fetchApi(`/api/image-studio/results${suffix}`);
}

export async function deleteResult(id: number): Promise<{ ok: boolean }> {
  return fetchApi(`/api/image-studio/results/${id}`, { method: "DELETE" });
}

export async function clearResults(chatId?: number): Promise<{ ok: boolean }> {
  const suffix = chatId !== undefined ? `?chatId=${chatId}` : "";
  return fetchApi(`/api/image-studio/results${suffix}`, { method: "DELETE" });
}

export interface CodexAuthorizeResponse {
  authUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  flowType: string;
  fixedPort: number;
  callbackPath: string;
}

export interface CodexOAuthStatusResponse {
  status: string;
  error?: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    workspace?: string | null;
    plan?: string | null;
  };
}

export async function getCodexAuthorize(redirectUri: string): Promise<CodexAuthorizeResponse> {
  return fetchApi(`/api/oauth/codex/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
}

export async function startCodexOAuthProxy(input: {
  appPort: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const params = new URLSearchParams({
    app_port: input.appPort,
    state: input.state,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
  return fetchApi(`/api/oauth/codex/start-proxy?${params.toString()}`);
}

export async function pollCodexOAuthStatus(state: string): Promise<CodexOAuthStatusResponse> {
  return fetchApi(`/api/oauth/codex/poll-status?state=${encodeURIComponent(state)}`);
}

export async function stopCodexOAuth(state?: string) {
  const suffix = state ? `?state=${encodeURIComponent(state)}` : "";
  return fetchApi(`/api/oauth/codex/stop-proxy${suffix}`);
}

export async function completeCodexOAuth(input: { code: string; state: string }) {
  return fetchApi<{ success: boolean; connection?: CodexOAuthStatusResponse["connection"] }>("/api/oauth/codex/complete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeCodexOAuthCallbackUrl(callbackUrl: string) {
  const url = new URL(callbackUrl.trim());
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || error;

  if (error) {
    throw new Error(errorDescription || error);
  }

  if (!code || !state) {
    throw new Error("Callback URL must include code and state");
  }

  return completeCodexOAuth({ code, state });
}

// BYOK (Bring Your Own Key) API functions
export interface ByokKeyInfo {
  id?: number;
  label: string;
  key?: string;
  status?: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
  lastUsedAt?: string | null;
  errorMessage?: string | null;
}

export interface ByokProvider {
  id: number;
  label: string;
  base_url: string;
  format: "openai" | "anthropic" | "auto";
  models: string[];
  model_prefix: string;
  headers?: Record<string, string>;
  status: string;
  enabled: boolean;
  available_models?: string[];
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  key_count?: number;
  active_key_count?: number;
  keys?: ByokKeyInfo[];
}

export async function fetchByokProviders(): Promise<{ providers: ByokProvider[] }> {
  return fetchApi("/api/accounts/byok");
}

export async function createByokProvider(data: {
  label: string;
  base_url: string;
  api_key?: string;
  api_keys?: ByokKeyInfo[];
  format?: "openai" | "anthropic" | "auto";
  models: string[];
  headers?: Record<string, string>;
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
}): Promise<{ success: boolean; id: number; label: string; models: string[]; key_count?: number }> {
  return fetchApi("/api/accounts/byok", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateByokProvider(
  id: number,
  data: {
    base_url?: string;
    api_key?: string;
    api_keys?: ByokKeyInfo[];
    format?: "openai" | "anthropic" | "auto";
    models?: string[];
    headers?: Record<string, string>;
    load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  }
): Promise<{ success: boolean; id: number; label: string; models: string[] }> {
  return fetchApi(`/api/accounts/byok/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteByokProvider(id: number): Promise<{ success: boolean; deleted: number }> {
  return fetchApi(`/api/accounts/byok/${id}`, { method: "DELETE" });
}

export async function addByokKeys(
  id: number,
  keys: Array<{ label?: string; key: string; enabled?: boolean }>
): Promise<{
  success: boolean;
  label: string;
  added: number;
  skipped: number;
  results: Array<{ label: string; status: "added" | "duplicate"; id?: number }>;
}> {
  return fetchApi(`/api/accounts/byok/${id}/keys`, {
    method: "POST",
    body: JSON.stringify({ api_keys: keys }),
  });
}

export async function revealByokKey(
  id: number
): Promise<{ success: boolean; id: number; label: string; key: string }> {
  return fetchApi(`/api/accounts/byok/${id}/reveal`, { method: "POST" });
}

// ── Managed / friend API keys ─────────────────────────────────────────────
export interface ManagedKey {
  id: number;
  /** Full secret — admin dashboard only (never on the public share board). */
  key: string;
  keyPreview: string;
  name: string | null;
  machineId: string | null;
  isActive: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  allowedModels: string[] | null;
  tokenQuota: number | null;
  tokensUsed: number;
  rateLimit: number | null;
  expiresAt: string | null;
}

export interface ManagedKeyInput {
  name?: string | null;
  machineId?: string | null;
  allowedModels?: string[] | null;
  tokenQuota?: number | null;
  rateLimit?: number | null;
  expiresAt?: string | null;
}

export async function fetchManagedKeys(): Promise<{ keys: ManagedKey[] }> {
  return fetchApi("/api/keys/managed");
}

export async function fetchAvailableModels(): Promise<{ models: Array<{ id: string; owned_by: string }> }> {
  return fetchApi("/api/keys/available-models");
}

export async function createManagedKey(input: ManagedKeyInput): Promise<{ id: number; key: string }> {
  return fetchApi("/api/keys/managed", { method: "POST", body: JSON.stringify(input) });
}

export async function updateManagedKey(id: number, input: ManagedKeyInput): Promise<{ success: boolean }> {
  return fetchApi(`/api/keys/managed/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function revokeManagedKey(id: number): Promise<{ success: boolean }> {
  return fetchApi(`/api/keys/managed/${id}/revoke`, { method: "POST" });
}

export async function activateManagedKey(id: number): Promise<{ success: boolean }> {
  return fetchApi(`/api/keys/managed/${id}/activate`, { method: "POST" });
}

export async function deleteManagedKey(id: number): Promise<{ success: boolean }> {
  return fetchApi(`/api/keys/managed/${id}`, { method: "DELETE" });
}

/** Pool info incl. the friend-status share URL + link-only flag (for building share links). */
export async function fetchPoolInfo(): Promise<{
  share?: { url: string | null; port: number; lock: boolean };
}> {
  return fetchApi("/api/info");
}

export async function testByokProvider(
  id: number,
  model?: string
): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  model?: string;
  format?: string;
  latency_ms?: number;
  auto_fixed?: boolean;
}> {
  return fetchApi(`/api/accounts/byok/${id}/test`, {
    method: "POST",
    body: JSON.stringify(model ? { model } : {})
  });
}

export async function fetchUpstreamModels(data: {
  base_url: string;
  api_key: string;
  format?: "openai" | "anthropic" | "auto";
}): Promise<{ models?: string[]; total?: number; error?: string; warning?: string }> {
  return fetchApi("/api/accounts/byok/fetch-models", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

