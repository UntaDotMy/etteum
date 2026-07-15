/**
 * Provider-card credit totals: remaining / all-total.
 *
 * Display shape: <usable remaining> / <all package total>
 * - remaining: only Active accounts (Error rows often store full package but
 *   cannot serve — do not count them as usable remaining).
 * - total: package capacity of every enabled account that has a quotaLimit
 *   (active + exhausted + error + pending), so the bar denominator is the
 *   full pool package, not only the active slice.
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
};

function positive(n: number | undefined): number {
  const v = Number(n || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Sum package capacity + usable remaining for dashboard Credits line.
 *
 * - total (limit): sum of quotaLimit for all enabled accounts
 * - remaining: sum of quotaRemaining for enabled active only (capped per package)
 */
export function sumProviderFleetCredits(rows: CreditAccountRow[]): ProviderCreditTotals {
  const enabled = rows.filter((a) => a.enabled !== false);

  let limit = 0;
  let remaining = 0;
  for (const a of enabled) {
    const lim = positive(a.quotaLimit);
    limit += lim;
    if (a.status === "active") {
      const rem = positive(a.quotaRemaining);
      remaining += lim > 0 ? Math.min(rem, lim) : rem;
    }
  }
  if (limit > 0) remaining = Math.min(remaining, limit);

  return {
    limit,
    remaining,
    used: Math.max(0, limit - remaining),
  };
}
