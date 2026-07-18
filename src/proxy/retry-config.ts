/**
 * Runtime retry budget, tunable from the dashboard settings (persisted in the
 * `settings` table) with env-var fallbacks and hardcoded defaults.
 *
 * Two knobs bound the nested retry that previously amplified to ~3×3 upstream
 * hops per client request:
 *   - accountAttempts : how many DIFFERENT accounts routeRequest rotates across.
 *   - innerRetries    : how many times execute() re-hits the SAME account on a
 *                       retryable status (502/503/504) before giving up.
 *
 * Total upstream hops ≈ accountAttempts × (innerRetries + 1). Defaults preserve
 * the historical behavior (3 × 3) so nothing changes unless an operator tunes
 * it down from the dashboard.
 *
 * Resolution order per key: settings table → env var → default. Cached 5s and
 * invalidated immediately on dashboard write via invalidateRetryConfigCache().
 */

import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

export interface RetryBudgetConfig {
  /** Max distinct accounts tried per client request (routeRequest). */
  accountAttempts: number;
  /** Max retries against the SAME account inside execute(). */
  innerRetries: number;
}

const SETTING_ACCOUNT_ATTEMPTS = "retry_max_account_attempts";
const SETTING_INNER_RETRIES = "retry_max_inner_retries";

const DEFAULT_ACCOUNT_ATTEMPTS = 3;
const DEFAULT_INNER_RETRIES = 3;
const CACHE_TTL_MS = 5_000;

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

function fromEnv(): Partial<RetryBudgetConfig> {
  const a = Number(process.env.POOLPROX_MAX_ACCOUNT_ATTEMPTS);
  const r = Number(process.env.POOLPROX_MAX_INNER_RETRIES);
  return {
    ...(Number.isFinite(a) && a > 0 ? { accountAttempts: clampInt(a, 1, 10) } : {}),
    ...(Number.isFinite(r) && r >= 0 ? { innerRetries: clampInt(r, 0, 5) } : {}),
  };
}

function defaults(): RetryBudgetConfig {
  const env = fromEnv();
  return {
    accountAttempts: env.accountAttempts ?? DEFAULT_ACCOUNT_ATTEMPTS,
    innerRetries: env.innerRetries ?? DEFAULT_INNER_RETRIES,
  };
}

let cache: { value: RetryBudgetConfig; expiresAt: number } | null = null;

/** Read the current retry budget (settings → env → defaults), cached 5s. */
export async function getRetryBudget(): Promise<RetryBudgetConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const base = defaults();
  try {
    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTING_ACCOUNT_ATTEMPTS));
    const [inner] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTING_INNER_RETRIES));
    const aVal = Number(rows[0]?.value);
    const rVal = Number(inner?.value);
    const value: RetryBudgetConfig = {
      accountAttempts: Number.isFinite(aVal) && aVal > 0 ? clampInt(aVal, 1, 10) : base.accountAttempts,
      innerRetries: Number.isFinite(rVal) && rVal >= 0 ? clampInt(rVal, 0, 5) : base.innerRetries,
    };
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  } catch {
    return base;
  }
}

/** Drop the cached budget — called when a retry_* setting is written. */
export function invalidateRetryConfigCache(): void {
  cache = null;
}

/** True when a settings key controls the retry budget. */
export function isRetrySettingKey(key: string): boolean {
  return key === SETTING_ACCOUNT_ATTEMPTS || key === SETTING_INNER_RETRIES;
}
