/**
 * Local quota-debit policy: when to skip pool.decrementQuota after a request.
 *
 * Some providers own remaining on the server (rolling windows, percent pools).
 * Debiting our local estimate onto those columns false-parks accounts and
 * flips dashboard meters opposite of real usage.
 */

/**
 * True when the provider's remaining budget must NOT be reduced by local
 * token×rate estimates. Upstream probe / post-request refresh is the writer.
 *
 * - commandcode: 5h/weekly USD windows from /alpha/billing/credits
 * - grok weekly %: CLI creditUsagePercent scale (limit 0–100)
 */
export function shouldSkipLocalQuotaDebit(
  provider: string,
  quotaLimit?: number | null,
): boolean {
  if (provider === "commandcode") return true;
  if (provider === "grok") {
    const lim = Number(quotaLimit ?? 0);
    return Number.isFinite(lim) && lim > 0 && lim <= 100;
  }
  return false;
}

/**
 * True when dispatch must ignore local remaining<=0 (upstream is the gate).
 * Account status=exhausted / disabled is still enforced by the pool query.
 */
export function ignoresLocalRemainingForDispatch(provider: string): boolean {
  return provider === "commandcode";
}
