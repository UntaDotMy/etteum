/** Cap for long bulk API calls (instant-login, large imports). */
export const BULK_API_TIMEOUT_MS = 15 * 60_000;

/**
 * Scale client fetch timeout with item count (min 2m, max BULK_API_TIMEOUT_MS).
 * Prevents default 30s AbortController from aborting mid-bulk while the server
 * still finishes writing accounts.
 */
export function bulkTimeoutMs(itemCount: number, perItemMs = 2_500): number {
  const n = Math.max(1, Math.floor(itemCount) || 1);
  return Math.min(BULK_API_TIMEOUT_MS, Math.max(120_000, n * perItemMs));
}
