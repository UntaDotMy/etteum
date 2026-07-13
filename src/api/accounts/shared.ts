/**
 * Shared helpers for accounts API modules.
 */
import { db } from "../../db/index";
import { settings, requestLogs, vccCards, vccTransactions } from "../../db/schema";
import { eq, inArray } from "drizzle-orm";
import { pool, type ProviderName } from "../../proxy/pool";

/** Nullify/delete FK children of accounts.id before account row delete. */
export async function detachAccountDependents(
  executor: {
    update: typeof db.update;
    delete: typeof db.delete;
  },
  accountIds: number | number[],
): Promise<void> {
  const ids = (Array.isArray(accountIds) ? accountIds : [accountIds]).filter(
    (n) => Number.isInteger(n) && n > 0,
  );
  if (ids.length === 0) return;
  const whereId = ids.length === 1 ? eq(requestLogs.accountId, ids[0]!) : inArray(requestLogs.accountId, ids);
  const whereVccUsed =
    ids.length === 1 ? eq(vccCards.usedByAccountId, ids[0]!) : inArray(vccCards.usedByAccountId, ids);
  const whereVccTx =
    ids.length === 1 ? eq(vccTransactions.accountId, ids[0]!) : inArray(vccTransactions.accountId, ids);

  await executor.update(requestLogs).set({ accountId: null }).where(whereId);
  await executor.update(vccCards).set({ usedByAccountId: null }).where(whereVccUsed);
  await executor.delete(vccTransactions).where(whereVccTx);
}

/** Thrown inside a transaction to abort + surface an HTTP status to the client. */
export class HttpError extends Error {
  status: 400 | 404 | 409 | 500;
  constructor(status: 400 | 404 | 409 | 500, message: string) { super(message); this.status = status; }
}

export type ByokKeyInput = {
  id?: number;
  label?: string;
  key?: string;
  api_key?: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
};

export type ByokTokensShape = {
  base_url?: string;
  api_key?: string;
  format?: "openai" | "anthropic" | "auto";
  models?: string[];
  model_prefix?: string;
  headers?: Record<string, string>;
  key_label?: string;
  weight?: number;
  priority?: number;
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
};

export const BYOK_PREFIX_RE = /^[a-z0-9-]+$/;
export const BYOK_KEY_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function parseByokTokens(raw: unknown): ByokTokensShape {
  if (!raw) return {};
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as ByokTokensShape;
  } catch {
    return {};
  }
}

export function getByokPrefix(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  return tokens.model_prefix || account.email.split("#")[0] || account.email;
}

export function getByokKeyLabel(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  if (tokens.key_label) return tokens.key_label;
  const marker = account.email.indexOf("#");
  return marker >= 0 ? account.email.slice(marker + 1) || "default" : "default";
}

export function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(models.map((m) => String(m).trim()).filter(Boolean)));
}

export function normalizeByokKeys(apiKeys: unknown, legacyApiKey?: string): Array<{ label: string; key: string; weight?: number; priority?: number }> {
  const rawKeys = Array.isArray(apiKeys)
    ? apiKeys as ByokKeyInput[]
    : legacyApiKey
      ? [{ label: "default", key: legacyApiKey }]
      : [];

  const normalized: Array<{ label: string; key: string; weight?: number; priority?: number }> = [];
  const seen = new Set<string>();
  const seenKeys = new Set<string>();
  for (const [index, item] of rawKeys.entries()) {
    const label = String(item.label || `key-${index + 1}`).trim().toLowerCase();
    const key = String(item.key || item.api_key || "").trim();
    if (!key) continue;
    if (!BYOK_KEY_LABEL_RE.test(label)) {
      throw new Error("key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore");
    }
    if (seen.has(label)) throw new Error(`duplicate BYOK key label: ${label}`);
    if (seenKeys.has(key)) throw new Error(`duplicate BYOK key value for label: ${label}`);
    seen.add(label);
    seenKeys.add(key);
    normalized.push({
      label,
      key,
      weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index,
    });
  }
  return normalized;
}

export function buildByokEmail(prefix: string, keyLabel: string): string {
  return `${prefix}#${keyLabel}`;
}

export function byokLbSettingKey(prefix: string): string {
  return `byok_${prefix}_lb_method`;
}

export function normalizeByokLbMethod(value: unknown): "round_robin" | "sequential" | "least_inflight" {
  return value === "sequential" || value === "least_inflight" ? value : "round_robin";
}

export async function setByokLbMethod(prefix: string, method: string) {
  const key = byokLbSettingKey(prefix);
  const value = normalizeByokLbMethod(method);
  const existing = await db.select().from(settings).where(eq(settings.key, key));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
  pool.invalidateLoadBalancingCache();
}

export async function getByokLbMethods(prefixes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(prefixes.map(byokLbSettingKey));
  const rows = await db.select().from(settings);
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!wanted.has(row.key) || !row.value) continue;
    const prefix = row.key.replace(/^byok_/, "").replace(/_lb_method$/, "");
    result.set(prefix, normalizeByokLbMethod(row.value));
  }
  return result;
}

export async function refreshByokRuntime() {
  pool.invalidate("byok" as ProviderName);
  const { refreshByokModels } = await import("../../proxy/providers/registry");
  await refreshByokModels();
}
