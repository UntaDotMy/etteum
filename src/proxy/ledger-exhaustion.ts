/**
 * Ledger-zero confirmation (quota P2).
 *
 * pool.decrementQuota() drives quotaRemaining to 0 from LOCAL accounting —
 * estimates, and usage that happened outside this proxy (CLI, other clients),
 * make the ledger drift from the upstream truth. Parking the account as
 * exhausted on ledger-zero alone shrinks the pool falsely; trusting the
 * ledger the other way keeps dead accounts dispatchable.
 *
 * So before parking, ask the provider's cheap credit probe (healthCheck) once:
 *   - probe says healthy with budget remaining → restore remaining (bounded to
 *     the account's existing limit scale — free-Build absolute numbers must
 *     never land in weekly-percent columns).
 *   - probe agrees (exhausted) / is inconclusive / fails → park as before.
 *
 * Upstream-429 exhaustion (router looksExhausted path) is authoritative and
 * stays instant-park — this helper is ONLY for ledger-driven zero crossings.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { pool } from "./pool";
import { resolveProviderInstance, type ProviderName } from "./providers/registry";

const PROBE_TIMEOUT_MS = 10_000;

export type LedgerZeroDecision =
  | { action: "restore"; remaining: number }
  | { action: "park" };

/**
 * Pure decision for testability. `quotaLimit` is the account's CURRENT limit
 * (any scale); the restored remaining never exceeds it, and never exceeds 100
 * when no positive limit exists (weekly-percent scale guard).
 */
export function resolveLedgerZeroAction(args: {
  probeHealthy: boolean;
  probeRemaining: number | null;
  quotaLimit: number;
}): LedgerZeroDecision {
  if (!args.probeHealthy) return { action: "park" };
  const rem = args.probeRemaining;
  if (rem === null || !Number.isFinite(rem) || rem <= 0) return { action: "park" };
  const cap = args.quotaLimit > 0 ? args.quotaLimit : 100;
  return { action: "restore", remaining: Math.max(1, Math.min(Math.floor(rem), cap)) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("ledger-zero probe timeout")), ms);
    }),
    // why: without the clear, a fast probe still left a live 10s timer per call.
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Confirm a ledger-driven quota-zero before parking. Fire-and-forget safe:
 * after the debit, remaining<=0 + limit>0 already excludes the account from
 * dispatch, so the probe window cannot serve traffic from a dead row.
 */
export async function confirmLedgerExhaustion(
  providerName: string,
  accountId: number,
): Promise<void> {
  if (!accountId || accountId <= 0) return;
  // Only Grok has a cheap authoritative credit probe today; every other
  // provider keeps the legacy park-on-zero behavior.
  if (providerName !== "grok") {
    await pool.markExhaustedIfQuotaDepleted(accountId);
    return;
  }

  try {
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!account) return;

    const provider = resolveProviderInstance(providerName as ProviderName);
    if (!provider || typeof provider.healthCheck !== "function") {
      await pool.markExhaustedIfQuotaDepleted(accountId);
      return;
    }

    const health = await withTimeout(provider.healthCheck(account), PROBE_TIMEOUT_MS);
    const probeRemaining = Number(health?.quota?.remaining);
    const decision = resolveLedgerZeroAction({
      probeHealthy: health?.kind === "healthy",
      probeRemaining: Number.isFinite(probeRemaining) ? probeRemaining : null,
      quotaLimit: Number(account.quotaLimit ?? 0),
    });

    if (decision.action === "restore") {
      const resetAt = health?.quota?.resetAt ? new Date(health.quota.resetAt) : null;
      await pool.applyQuotaSnapshot(account.id, {
        quotaRemaining: decision.remaining,
        ...(resetAt && !Number.isNaN(resetAt.getTime()) ? { quotaResetAt: resetAt } : {}),
      });
      return;
    }
  } catch {
    // Probe failed/timeout — fall through to the legacy park.
  }

  await pool.markExhaustedIfQuotaDepleted(accountId);
}
