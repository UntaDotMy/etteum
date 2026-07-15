/**
 * Provider-card credit totals: remaining / total for the working fleet.
 *
 * Error/pending rows often still hold a full import package (e.g. Grok free
 * Build 2M/2M) that cannot serve traffic. Summing them painted remaining=total
 * at "all accounts × package" even when only a few are Active.
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
 * - total (limit): sum of quotaLimit for enabled active + exhausted
 * - remaining: sum of quotaRemaining for enabled active only (capped per package)
 * - exhausted contribute 0 remaining but keep their package in the total
 */
export function sumProviderFleetCredits(rows: CreditAccountRow[]): ProviderCreditTotals {
  const enabled = rows.filter((a) => a.enabled !== false);
  const fleet = enabled.filter(
    (a) => a.status === "active" || a.status === "exhausted",
  );

  let limit = 0;
  let remaining = 0;
  for (const a of fleet) {
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
