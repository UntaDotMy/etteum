/**
 * Provider-card credit totals: remaining / package total.
 *
 * Working fleet = active + exhausted (error/pending excluded — often stale full
 * packages that are not usable and would paint a fake "full" bar).
 *
 * - remaining: sum of quotaRemaining for active + exhausted
 *   (exhausted at 0 correctly lowers remaining)
 * - limit: sum of quotaLimit for the same fleet
 * - weeklyPercentScale: all accounts that have a package are 0–100 (CLI weekly
 *   style). Accounts with limit 0 / unknown do not demote the label.
 */

export type CreditAccountRow = {
  enabled?: boolean;
  status?: string;
  quotaLimit?: number;
  quotaRemaining?: number;
};

export type ProviderCreditTotals = {
  limit: number;
  remaining: number;
  used: number;
  /** Accounts in the working fleet (active + exhausted, enabled). */
  fleetCount: number;
  /**
   * True when every account with a known package is CLI weekly % (0–100),
   * not absolute free-Build tokens (~2e6). Zero/unknown limits are ignored
   * for this flag so unprobed rows do not force the "Credits" label.
   */
  weeklyPercentScale: boolean;
};

function positiveLimit(n: number | undefined): number {
  const v = Number(n || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Non-negative remaining (0 is kept — exhausted must pull the average down). */
function nonNegRemaining(n: number | undefined): number {
  const v = Number(n || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Sum package capacity + remaining for dashboard Credits line.
 *
 * Exhausted accounts with remaining=0 are included so e.g.
 * 643×100 + 4×0 → avg ~99.4/100, not 100/100 from active-only.
 */
export function sumProviderFleetCredits(rows: CreditAccountRow[]): ProviderCreditTotals {
  const enabled = rows.filter((a) => a.enabled !== false);

  let limit = 0;
  let remaining = 0;
  let fleetCount = 0;
  let accountsWithLimit = 0;
  let percentScaleAccounts = 0;

  for (const a of enabled) {
    // Working fleet only — error/pending do not affect the bar.
    if (a.status !== "active" && a.status !== "exhausted") continue;

    const lim = positiveLimit(a.quotaLimit);
    const rem = nonNegRemaining(a.quotaRemaining);

    fleetCount++;
    if (lim > 0) {
      accountsWithLimit++;
      limit += lim;
      if (lim <= 100) percentScaleAccounts++;
      remaining += Math.min(rem, lim);
    } else {
      remaining += rem;
    }
  }

  if (limit > 0) remaining = Math.min(remaining, limit);

  return {
    limit,
    remaining,
    used: Math.max(0, limit - remaining),
    fleetCount,
    // Only packages with a known limit vote on scale. Unprobed 0/0 rows must
    // not flip a free-tier weekly fleet back to absolute "Credits".
    weeklyPercentScale:
      accountsWithLimit > 0 && percentScaleAccounts === accountsWithLimit,
  };
}

/**
 * Average remaining on the 0–100 weekly scale for display.
 * Uses remaining/limit so exhausted zeros lower the number (matches the bar).
 */
export function weeklyAverageRemaining(totals: ProviderCreditTotals): number {
  if (totals.limit <= 0) return 0;
  // remaining/limit is the fleet fill ratio; scale to 0–100 points.
  return (totals.remaining / totals.limit) * 100;
}
