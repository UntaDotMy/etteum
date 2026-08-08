import { db } from "../db/index";
import { accounts, settings } from "../db/schema";
import { eq, and, sql, or, isNull, isNotNull, lt, lte, asc, desc } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";
import { config } from "../config";
import { getProviderForModel, type ProviderName } from "./providers/registry";

export type { ProviderName };

/** Options for pool account selection (RR / sequential / sticky). */
export interface AccountSelectOptions {
  /** Skip these account ids (in-loop retry exclusion after exhaustion/fail). */
  excludeAccountIds?: Set<number>;
  /** Prefer this account when still dispatch-eligible (response-id stickiness). */
  preferredAccountId?: number;
}

/**
 * Can this active row be chosen for a new chat attempt without a known-dead
 * local package budget?
 *
 * status=exhausted is already excluded by fetchActiveAccounts. This catches
 * active rows with limit>0 and remaining<=0 (local debit drained, or not yet
 * marked exhausted) so round-robin does not pay a full upstream hop on a
 * credential that will only return free-usage-exhausted / 402.
 *
 * limit<=0 or non-finite remaining → treat as unknown budget (still eligible).
 */
export function isAccountEligibleForDispatch(account: Account): boolean {
  const limit = Number(account.quotaLimit);
  const remaining = Number(account.quotaRemaining);
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining <= 0) {
    return false;
  }
  return true;
}

/** Filter active accounts for dispatch: exclude ids + known-depleted packages. */
export function filterDispatchEligibleAccounts(
  list: Account[],
  excludeAccountIds?: Set<number> | null,
): Account[] {
  return list.filter((a) => {
    if (excludeAccountIds?.has(a.id)) return false;
    return isAccountEligibleForDispatch(a);
  });
}

/**
 * Pure: should an exhausted row whose quotaResetAt passed be reinstated, and
 * with what remaining budget? Returns the patch, or null to stay exhausted.
 *
 * Optimistic refill to the package limit: a wrong revive costs one fast
 * upstream 429 that re-parks the account with a fresh resetAt, and the next
 * warmup probe corrects the ledger. limit<=0 means "unknown budget" — revive
 * with remaining 0; the dispatch gate treats limit<=0 as eligible anyway.
 */
export function computeResetRevivePatch(
  row: { status: string; quotaResetAt: Date | string | null; quotaLimit: number | null },
  now: Date,
): { quotaRemaining: number } | null {
  if (row.status !== "exhausted") return null;
  if (!row.quotaResetAt) return null;
  const resetAt = row.quotaResetAt instanceof Date ? row.quotaResetAt : new Date(row.quotaResetAt);
  if (Number.isNaN(resetAt.getTime()) || resetAt.getTime() > now.getTime()) return null;
  const limit = Number(row.quotaLimit ?? 0);
  return { quotaRemaining: Number.isFinite(limit) && limit > 0 ? limit : 0 };
}

/** Pool-wide depletion snapshot used to build the typed all-exhausted 429. */
export interface PoolDepletion {
  /** Enabled rows for the provider (any status). */
  enabled: number;
  /** Enabled rows currently status=exhausted. */
  exhausted: number;
  /** Earliest future quotaResetAt among exhausted enabled rows, if any. */
  earliestResetAt: Date | null;
}

/** Pure: fold account rows into a PoolDepletion (DB wrapper below). */
export function summarizePoolDepletion(
  rows: Array<{ status: string; quotaResetAt: Date | string | null }>,
  nowMs: number,
): PoolDepletion {
  let exhausted = 0;
  let earliest: Date | null = null;
  for (const r of rows) {
    if (r.status !== "exhausted") continue;
    exhausted++;
    const t = r.quotaResetAt ? new Date(r.quotaResetAt) : null;
    if (t && !Number.isNaN(t.getTime()) && t.getTime() > nowMs && (!earliest || t < earliest)) {
      earliest = t;
    }
  }
  return { enabled: rows.length, exhausted, earliestResetAt: earliest };
}

// --- Routing resilience constants  ---
// Exponential backoff for transient failures: start at 2s, double each time,
// cap at 5 min. A transient blip cools an account briefly; sustained flakiness
// pushes it out longer. Auto-reinstates the moment cooldownUntil passes.
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
// Terminal-error hysteresis: require this many CONSECUTIVE hard auth/persistent
// errors before disabling an account. One transient 401 no longer kills it.
const TERMINAL_ERROR_THRESHOLD = 3;
// Sticky round-robin: an account is reused for up to this many consecutive
// requests before the selector rotates. Mirrors the reference proxy rotation.
const STICKY_MAX_CONSECUTIVE = 3;

interface PoolState {
  lastIndex: Map<ProviderName, number>;
}

interface ActiveAccountsCacheEntry {
  accounts: Account[];
  expiresAt: number;
  inFlight?: Promise<Account[]>;
}

class AccountPool {
  private state: PoolState = {
    lastIndex: new Map(),
  };

  private activeAccountsCache = new Map<ProviderName, ActiveAccountsCacheEntry>();
  private inFlightByAccountId = new Map<number, number>();
  private lbMethodCache: {
    global: string;
    perProvider: Map<ProviderName, string>;
    perByokPrefix: Map<string, string>;
    expiresAt: number;
  } | null = null;

  /**
   * Clear cached active accounts after account mutations or status changes.
   */
  invalidate(provider?: ProviderName): void {
    if (provider) {
      this.activeAccountsCache.delete(provider);
      return;
    }

    this.activeAccountsCache.clear();
  }

  async getLoadBalancingMethod(provider: ProviderName): Promise<string> {
    const now = Date.now();
    if (!this.lbMethodCache || this.lbMethodCache.expiresAt <= now) {
      try {
        const rows = await db.select().from(settings);
        const perProvider = new Map<ProviderName, string>();
        const perByokPrefix = new Map<string, string>();
        let global = "round_robin";
        for (const row of rows) {
          if (!row.value) continue;
          if (row.key === "load_balancing_method") {
            global = row.value;
            continue;
          }
          const byokMatch = row.key.match(/^byok_(.+)_lb_method$/);
          if (byokMatch && byokMatch[1]) {
            perByokPrefix.set(byokMatch[1], row.value);
            continue;
          }
          const match = row.key.match(/^provider_(.+)_lb_method$/);
          if (match && match[1]) perProvider.set(match[1] as ProviderName, row.value);
        }
        this.lbMethodCache = { global, perProvider, perByokPrefix, expiresAt: now + 10000 };
      } catch {
        this.lbMethodCache = {
          global: "round_robin",
          perProvider: new Map(),
          perByokPrefix: new Map(),
          expiresAt: now + 10000,
        };
      }
    }
    return this.lbMethodCache?.perProvider.get(provider) || this.lbMethodCache?.global || "round_robin";
  }

  async getByokLoadBalancingMethod(prefix: string): Promise<string> {
    await this.getLoadBalancingMethod("byok");
    return this.lbMethodCache?.perByokPrefix.get(prefix)
      || this.lbMethodCache?.perProvider.get("byok")
      || this.lbMethodCache?.global
      || "round_robin";
  }

  invalidateLoadBalancingCache(): void {
    this.lbMethodCache = null;
  }

  /**
   * Pick among already-filtered eligible accounts using sequential / sticky RR.
   * Eligibility (depleted skip + exclude ids) must be applied by the caller.
   */
  private async pickFromEligible(
    provider: ProviderName,
    eligibleAccounts: Account[],
    options: AccountSelectOptions = {},
  ): Promise<Account | null> {
    if (eligibleAccounts.length === 0) return null;

    // Response-id / sticky pin: only if still eligible (not depleted, not excluded).
    if (options.preferredAccountId) {
      const pref = eligibleAccounts.find((a) => a.id === options.preferredAccountId);
      if (pref) return pref;
    }

    const method = await this.getLoadBalancingMethod(provider);

    if (method === "sequential") {
      for (const account of eligibleAccounts) {
        if (this.getInFlightCount(account.id) === 0) return account;
      }
      return eligibleAccounts[0] || null;
    }

    // Round Robin (default)
    // Sticky: list ordered priority ASC, lastUsedAt DESC, so [0] is most recent.
    // Only sticky when still dispatch-eligible (depleted already filtered out).
    const stickyCandidate = eligibleAccounts[0];
    if (
      stickyCandidate &&
      Number(stickyCandidate.consecutiveUseCount || 0) < STICKY_MAX_CONSECUTIVE &&
      this.getInFlightCount(stickyCandidate.id) === 0
    ) {
      this.state.lastIndex.set(provider, 0);
      return stickyCandidate;
    }

    const startIdx = ((this.state.lastIndex.get(provider) || 0) + 1) % eligibleAccounts.length;
    let selected = eligibleAccounts[startIdx];
    let selectedIdx = startIdx;
    let selectedLoad = selected ? this.getInFlightCount(selected.id) : Number.POSITIVE_INFINITY;

    for (let i = 1; i < eligibleAccounts.length; i++) {
      const idx = (startIdx + i) % eligibleAccounts.length;
      const candidate = eligibleAccounts[idx];
      if (!candidate) continue;
      const load = this.getInFlightCount(candidate.id);
      if (load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    this.state.lastIndex.set(provider, selectedIdx);
    return selected || null;
  }

  /**
   * Get the next available account for a provider using configured method.
   * Skips known-depleted packages (limit>0 remaining<=0) and excludeAccountIds.
   */
  async getNextAccount(
    provider: ProviderName,
    options: AccountSelectOptions = {},
  ): Promise<Account | null> {
    const activeAccounts = await this.getActiveAccounts(provider);
    const eligible = filterDispatchEligibleAccounts(activeAccounts, options.excludeAccountIds);
    if (eligible.length > 0) {
      return this.pickFromEligible(provider, eligible, options);
    }
    // No active account: fall back to enabled `error`-status rows so a
    // transiently-bad key is retried (it self-heals on success via the
    // provider's post-request refresh / warmup), mirroring BYOK's fallback.
    // Excludes accounts in cooldown and rows already attempted this request.
    // Dispatch filter is intentionally NOT applied here: a stale local
    // remaining=0 (e.g. commandcode's upstream-driven window) must not block
    // retrying the key — the live request re-validates it.
    const fallback = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.status, "error"),
          eq(accounts.enabled, true),
          or(
            isNull(accounts.cooldownUntil),
            lt(accounts.cooldownUntil, new Date()),
          ),
        ),
      )
      .orderBy(asc(accounts.priority), desc(accounts.lastUsedAt));
    const eligibleFallback = options.excludeAccountIds?.size
      ? fallback.filter((a) => !options.excludeAccountIds!.has(a.id))
      : fallback;
    if (eligibleFallback.length === 0) return null;
    return this.pickFromEligible(provider, eligibleFallback, options);
  }

  /**
   * Get the next available account for a specific model.
   * For Alibaba: filters by queryableModels to ensure account can actually query the model.
   * For other providers: falls back to standard getNextAccount.
   * Supports excludeAccountIds so routeRequest retries never re-pay a dead credential.
   */
  async getNextAccountForModel(
    provider: ProviderName,
    model: string,
    options: AccountSelectOptions = {},
  ): Promise<Account | null> {
    // For Alibaba, rank by probe coverage + per-model quota (no hard drop).
    if (provider === "alibaba") {
      const activeAccounts = await this.getActiveAccounts(provider);
      if (activeAccounts.length === 0) return null;

      // Resolve model name (strip ali- prefix if present)
      const upstreamModel = model.startsWith("ali-") ? model.slice(4) : model;

      // why: rank probe-confirmed-and-funded first, un-probed next, drained
      // last; never drop. Filtering hid un-probed accounts and capped the pool.
      const ranked = activeAccounts
        .map((account, index) => {
          const tokens = account.tokens as {
            queryableModels?: string[];
            modelQuotas?: Record<string, { remaining: number }>;
          } | null;
          const probed = tokens?.queryableModels?.includes(upstreamModel) ?? false;
          const quota = tokens?.modelQuotas?.[upstreamModel];
          const hasQuota = !(quota && Number.isFinite(quota.remaining) && quota.remaining <= 0);
          // tier 0 = probe-confirmed with quota, 1 = un-probed/unknown, 2 = drained
          const tier = probed && hasQuota ? 0 : probed ? 2 : 1;
          return { account, index, tier };
        })
        .sort((a, b) => a.tier - b.tier || a.index - b.index)
        .map(({ account }) => account);

      const eligibleAccounts = filterDispatchEligibleAccounts(
        ranked,
        options.excludeAccountIds,
      );

      if (eligibleAccounts.length === 0) return null;

      return this.pickFromEligible(provider, eligibleAccounts, options);
    }

    // For other providers, use standard routing with same exclude/depleted filters
    return this.getNextAccount(provider, options);
  }

  getInFlightCount(accountId: number): number {
    return this.inFlightByAccountId.get(accountId) || 0;
  }

  trackRequestStart(accountId: number): void {
    this.inFlightByAccountId.set(accountId, this.getInFlightCount(accountId) + 1);
  }

  trackRequestEnd(accountId: number): void {
    const next = this.getInFlightCount(accountId) - 1;
    if (next > 0) this.inFlightByAccountId.set(accountId, next);
    else this.inFlightByAccountId.delete(accountId);
  }

  async decrementQuota(accountId: number, creditsUsed: number): Promise<number> {
    if (!Number.isFinite(creditsUsed) || creditsUsed <= 0) {
      const [account] = await db
        .select({ quotaRemaining: accounts.quotaRemaining })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      return Number(account?.quotaRemaining || 0);
    }

    const [account] = await db
      .update(accounts)
      .set({
        quotaRemaining: sql`MAX(0, COALESCE(${accounts.quotaRemaining}, 0) - ${creditsUsed})`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning({
        quotaRemaining: accounts.quotaRemaining,
        tokens: accounts.tokens,
        provider: accounts.provider,
        status: accounts.status,
        quotaLimit: accounts.quotaLimit,
      });

    const remaining = Number(account?.quotaRemaining || 0);

    // Keep tokens.credits_remaining (Grok OAuth farm blob) in lockstep with
    // quotaRemaining so the next healthCheck/warmup cannot re-inflate the
    // budget from a stale 2M import snapshot.
    await this.syncTokenCreditsRemaining(accountId, remaining, account?.tokens);

    // Realtime dashboard: remaining must update without a full page refresh.
    if (account) {
      broadcast({
        type: "account_status",
        data: {
          id: accountId,
          provider: account.provider,
          status: account.status,
          quotaRemaining: remaining,
          quotaLimit: Number(account.quotaLimit || 0),
        },
      });
    }

    return remaining;
  }

  /**
   * Write a live quota snapshot (e.g. Grok weekly pool after a request) and
   * broadcast account_status so the dashboard pool bar updates without waiting
   * for the next warmup tick. Does NOT invent values — caller supplies them.
   *
   * When remaining hits 0 with a positive limit, flips to exhausted (same as
   * markExhaustedIfQuotaDepleted). Never re-activates an error/pending row.
   */
  async applyQuotaSnapshot(
    accountId: number,
    snapshot: {
      quotaRemaining: number;
      quotaLimit?: number;
      quotaResetAt?: Date | null;
    },
  ): Promise<void> {
    if (!accountId || accountId <= 0) return;
    const remaining = Math.max(0, Math.floor(Number(snapshot.quotaRemaining)));
    if (!Number.isFinite(remaining)) return;

    const [existing] = await db
      .select({
        id: accounts.id,
        provider: accounts.provider,
        status: accounts.status,
        tokens: accounts.tokens,
        quotaLimit: accounts.quotaLimit,
        quotaRemaining: accounts.quotaRemaining,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!existing) return;

    const nextLimit =
      snapshot.quotaLimit !== undefined && Number.isFinite(Number(snapshot.quotaLimit))
        ? Math.max(0, Math.floor(Number(snapshot.quotaLimit)))
        : Number(existing.quotaLimit || 0);

    // No-op if nothing changed (avoid WS spam).
    const prevRem = Number(existing.quotaRemaining || 0);
    const prevLim = Number(existing.quotaLimit || 0);
    if (
      prevRem === remaining &&
      (snapshot.quotaLimit === undefined || prevLim === nextLimit) &&
      snapshot.quotaResetAt === undefined
    ) {
      return;
    }

    const patch: Record<string, unknown> = {
      quotaRemaining: remaining,
      updatedAt: new Date(),
    };
    if (snapshot.quotaLimit !== undefined) patch.quotaLimit = nextLimit;
    if (snapshot.quotaResetAt !== undefined) patch.quotaResetAt = snapshot.quotaResetAt;

    // Drain → exhausted (realtime, same as markExhausted path).
    let nextStatus = existing.status;
    if (nextLimit > 0 && remaining <= 0 && existing.status === "active") {
      patch.status = "exhausted";
      nextStatus = "exhausted";
    }

    await db.update(accounts).set(patch).where(eq(accounts.id, accountId));
    await this.syncTokenCreditsRemaining(accountId, remaining, existing.tokens);
    this.invalidate(existing.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: {
        id: accountId,
        provider: existing.provider,
        status: nextStatus,
        quotaRemaining: remaining,
        quotaLimit: snapshot.quotaLimit !== undefined ? nextLimit : prevLim,
      },
    });
  }

  /**
   * When the account tokens blob stores absolute free-Build credits
   * (`credits_remaining` / `credits_limit`), pin remaining to the live
   * quotaRemaining after a debit. No-op when those fields are absent.
   */
  private async syncTokenCreditsRemaining(
    accountId: number,
    remaining: number,
    tokens: unknown,
  ): Promise<void> {
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return;
    const t = tokens as Record<string, unknown>;
    if (typeof t.credits_remaining !== "number" || !Number.isFinite(t.credits_remaining)) return;

    const nextRemaining = Math.max(0, Math.floor(remaining));
    if (Math.floor(t.credits_remaining) === nextRemaining) return;

    await db
      .update(accounts)
      .set({
        tokens: { ...t, credits_remaining: nextRemaining } as Account["tokens"],
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  }

  /**
   * After a successful debit, flip the account to `exhausted` when a positive
   * quotaLimit is fully spent so it is excluded from getActiveAccounts.
   */
  async markExhaustedIfQuotaDepleted(accountId: number): Promise<void> {
    const [a] = await db
      .select({
        quotaLimit: accounts.quotaLimit,
        quotaRemaining: accounts.quotaRemaining,
        status: accounts.status,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!a) return;
    if (a.status === "exhausted") return;
    if (Number(a.quotaLimit) > 0 && Number(a.quotaRemaining) <= 0) {
      await this.markExhausted(accountId);
    }
  }

  /**
   * Decrement the Qoder Free counter (mirror of /activity qmodel_latest).
   * Used for requests routed to qd-Qwen3.7-Max (the only Free-promo model).
   * Returns new freeRemaining (clamped at 0).
   */
  async decrementFreeQuota(accountId: number, creditsUsed: number): Promise<number> {
    if (!Number.isFinite(creditsUsed) || creditsUsed <= 0) {
      const [account] = await db
        .select({ freeRemaining: accounts.freeRemaining })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      return Number(account?.freeRemaining || 0);
    }

    const [account] = await db
      .update(accounts)
      .set({
        freeRemaining: sql`MAX(0, COALESCE(${accounts.freeRemaining}, 0) - ${creditsUsed})`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning({ freeRemaining: accounts.freeRemaining });

    return Number(account?.freeRemaining || 0);
  }

  /**
   * Mark a Qoder account `exhausted` ONLY if both counters are depleted.
   *
   * Rules:
   *   - Free out: freeLimit > 0 AND freeRemaining <= 0
   *   - All out:  quotaLimit > 0 AND quotaRemaining <= 0
   *   - All not-applicable: quotaLimit <= 0 (Qoder /quota/usage sentinel "no data")
   *   - exhausted ⇔ Free out AND (All out OR All not-applicable)
   *     AND (Free not-applicable OR Free out) — i.e. at least one was applicable and is out
   *
   * If neither Free nor All has a positive limit at all, treat as not-applicable
   * (don't mark exhausted from this path — let the probe/warmup decide).
   */
  async markExhaustedIfFullyDepleted(accountId: number): Promise<void> {
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!a) return;

    const freeLim = Number(a.freeLimit ?? 0);
    const freeRem = Number(a.freeRemaining ?? 0);
    const allLim = Number(a.quotaLimit ?? 0);
    const allRem = Number(a.quotaRemaining ?? 0);

    const freeApplicable = freeLim > 0;
    const allApplicable = allLim > 0;
    const freeOut = freeApplicable && freeRem <= 0;
    const allOut = allApplicable && allRem <= 0;

    // Neither bucket applicable — nothing to decide here.
    if (!freeApplicable && !allApplicable) return;

    // Both applicable: need both depleted.
    if (freeApplicable && allApplicable) {
      if (freeOut && allOut) await this.markExhausted(accountId);
      return;
    }

    // Only one applicable: that one being out is sufficient.
    if (freeApplicable && freeOut) await this.markExhausted(accountId);
    else if (allApplicable && allOut) await this.markExhausted(accountId);
  }

  /**
   * Check and reset daily quota for Qoder accounts.
   * - If quotaLimit === 0: initialize with dailyLimit
   * - If quotaResetAt has passed: reset quotaRemaining to dailyLimit, set quotaResetAt to next midnight
   * - Reactivates exhausted accounts after reset (unless server-side rate limited)
   */
  async checkAndResetDailyQuota(accountId: number, dailyLimit: number): Promise<number> {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account) return 0;

    const now = new Date();
    const resetAt = account.quotaResetAt ? new Date(account.quotaResetAt) : null;
    const currentLimit = Number(account.quotaLimit || 0);

    // Check if account is server-side rate limited (exhausted within last 24 hours)
    const updatedAt = account.updatedAt ? new Date(account.updatedAt) : null;
    const hoursSinceUpdate = updatedAt ? (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60) : Infinity;
    const isServerRateLimited = account.status === "exhausted" && hoursSinceUpdate < 24;

    // Initialize or reset if:
    // 1. quotaLimit === 0 (first time setup)
    // 2. quotaResetAt has passed (daily reset) AND not server-side rate limited
    if (currentLimit === 0 || (!isServerRateLimited && (!resetAt || now >= resetAt))) {
      // Set next reset to tomorrow midnight
      const nextReset = new Date(now);
      nextReset.setDate(nextReset.getDate() + 1);
      nextReset.setHours(0, 0, 0, 0);

      const [updated] = await db.update(accounts)
        .set({
          quotaLimit: dailyLimit,
          quotaRemaining: dailyLimit,
          quotaResetAt: nextReset,
          status: "active", // Reactivate if was exhausted
          updatedAt: now,
        })
        .where(eq(accounts.id, accountId))
        .returning({ quotaRemaining: accounts.quotaRemaining });

      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: { id: accountId, status: "active", provider: account.provider, quotaReset: true },
      });

      return Number(updated?.quotaRemaining || dailyLimit);
    }

    return Number(account.quotaRemaining || 0);
  }

  private async getActiveAccounts(provider: ProviderName): Promise<Account[]> {
    const ttlMs = Math.max(0, config.accountCacheTtlMs);
    if (ttlMs === 0) return this.fetchActiveAccounts(provider);

    const now = Date.now();
    const cached = this.activeAccountsCache.get(provider);
    if (cached && cached.expiresAt > now) return cached.accounts;
    if (cached?.inFlight) return cached.inFlight;

    const fetchTime = now;
    const inFlight = this.fetchActiveAccounts(provider)
      .then((activeAccounts) => {
        this.activeAccountsCache.set(provider, {
          accounts: activeAccounts,
          expiresAt: fetchTime + ttlMs,
        });
        return activeAccounts;
      })
      .catch((error) => {
        this.activeAccountsCache.delete(provider);
        throw error;
      });

    this.activeAccountsCache.set(provider, {
      accounts: cached?.accounts || [],
      expiresAt: 0,
      inFlight,
    });

    return inFlight;
  }

  private async fetchActiveAccounts(provider: ProviderName): Promise<Account[]> {
    // Reset-window revive: exhausted rows whose quotaResetAt has passed come
    // back automatically — the same self-reinstating pattern cooldownUntil
    // uses, no cron and no manual re-enable. Refill is optimistic (limit);
    // a premature revive costs one fast upstream 429 that re-parks the row
    // with a fresh resetAt, and warmup probes true up the ledger.
    const now = new Date();
    const dueForRevive = await db
      .select({
        id: accounts.id,
        status: accounts.status,
        quotaLimit: accounts.quotaLimit,
        quotaResetAt: accounts.quotaResetAt,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.status, "exhausted"),
          eq(accounts.enabled, true),
          isNotNull(accounts.quotaResetAt),
          lte(accounts.quotaResetAt, now),
        ),
      );
    for (const row of dueForRevive) {
      const patch = computeResetRevivePatch(row, now);
      if (!patch) continue;
      await db
        .update(accounts)
        .set({
          status: "active",
          quotaRemaining: patch.quotaRemaining,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, row.id));
      broadcast({
        type: "account_status",
        data: { id: row.id, provider, status: "active", quotaRevived: true },
      });
    }

    // Cooldown reinstatement: an account with cooldownUntil in the future is
    // temporarily excluded. The moment that timestamp passes it is eligible
    // again automatically — no manual re-enable, no cron, no extra state.
    return db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.status, "active"),
          eq(accounts.enabled, true),
          or(
            isNull(accounts.cooldownUntil),
            lt(accounts.cooldownUntil, new Date()),
          ),
        )
      )
      // Provider-priority routing: lower priority = tried first. Enables
      // "paid first, free fallback" ordering of credentials within a provider.
      .orderBy(asc(accounts.priority), desc(accounts.lastUsedAt));
  }

  /**
   * Get any available account across all providers that support the model.
   */
  async getAccountForModel(
    model: string,
    options: { excludeAccountIds?: Set<number>; preferredAccountId?: number } = {}
  ): Promise<{ account: Account; provider: ProviderName } | null> {
    // Determine which provider handles this model
    const provider = this.getProviderForModel(model);
    if (!provider) return null;

    // Sticky/preferred-connection pinning : if a preferred account
    // id was passed (e.g. the account that served a previous_response_id),
    // return it first if it is eligible — preserves Codex session continuity.
    // Depleted packages (remaining<=0 with limit>0) are NOT preferred.
    if (options.preferredAccountId) {
      const [pref] = await db.select().from(accounts).where(eq(accounts.id, options.preferredAccountId)).limit(1);
      if (pref && pref.provider === provider && pref.status === "active" && pref.enabled &&
        !(options.excludeAccountIds?.has(pref.id)) &&
        (!pref.cooldownUntil || pref.cooldownUntil < new Date()) &&
        isAccountEligibleForDispatch(pref)) {
        return { account: pref, provider };
      }
    }

    // BYOK requires special handling - find account by prefix
    if (provider === "byok") {
      const { getByokProvider } = await import("./providers/registry");
      const byokProvider = getByokProvider();
      const prefix = byokProvider.findPrefixForModel(model);
      const account = await byokProvider.findAccountForModel(model, {
        excludeAccountIds: options.excludeAccountIds,
        loadBalancingMethod: prefix ? await this.getByokLoadBalancingMethod(prefix) : await this.getLoadBalancingMethod("byok"),
        getInFlightCount: (accountId) => this.getInFlightCount(accountId),
      });
      if (!account) return null;
      return { account, provider: "byok" };
    }

    const account = await this.getNextAccount(provider, {
      excludeAccountIds: options.excludeAccountIds,
      preferredAccountId: options.preferredAccountId,
    });
    if (!account) return null;

    return { account, provider };
  }

  /**
   * Active accounts for a model that are still dispatch-eligible
   * (not known-depleted). Used by tests and combo ranking.
   */
  async getDispatchEligibleAccountsForModel(model: string): Promise<Account[]> {
    const list = await this.getAccountsForModel(model);
    return filterDispatchEligibleAccounts(list);
  }

  /**
   * Get all active accounts for a model, sorted by capability match.
   * Used by combo.ts to build fallback chains ranked by capability.
   */
  async getAccountsForModel(model: string): Promise<Account[]> {
    const provider = this.getProviderForModel(model);
    if (!provider) return [];

    const activeAccounts = await this.getActiveAccounts(provider);
    if (activeAccounts.length === 0) return [];

    // why: rank by probe coverage instead of filtering. The old `?? false`
    // filter hid un-probed accounts and shrank the fleet to a handful.
    if (provider === "alibaba") {
      const upstreamModel = model.startsWith("ali-") ? model.slice(4) : model;
      return activeAccounts
        .map((account, index) => {
          const tokens = account.tokens as { queryableModels?: string[] } | null;
          const probed = tokens?.queryableModels?.includes(upstreamModel) ? 0 : 1;
          return { account, index, probed };
        })
        .sort((a, b) => a.probed - b.probed || a.index - b.index)
        .map(({ account }) => account);
    }

    return activeAccounts;
  }

  /**
   * Map model name to provider. Delegates to the provider registry, which asks
   * each provider's ownsModel() in priority order (single source of truth).
   */
  getProviderForModel(model: string): ProviderName | null {
    return getProviderForModel(model);
  }

  /**
   * Mark an account as used (update last_used_at). Also resets the routing-
   * resilience counters — a successful request proves the account is healthy,
   * so consecutive transient/auth failures and any active cooldown are cleared.
   */
  async markUsed(accountId: number, providerName: ProviderName): Promise<void> {
    // Reset siblings' sticky count so a rotated-away account starts fresh.
    // Scoped to non-zero rows: the unscoped form rewrote every sibling on every
    // successful request (499 writes at 500 accounts) against one SQLite writer.
    await db
      .update(accounts)
      .set({ consecutiveUseCount: sql`0` })
      .where(
        and(
          eq(accounts.provider, providerName),
          sql`${accounts.id} <> ${accountId}`,
          sql`${accounts.consecutiveUseCount} <> 0`,
        ),
      );

    await db
      .update(accounts)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
        consecutiveUseCount: sql`${accounts.consecutiveUseCount} + 1`,
        consecutiveTransientFailures: 0,
        nextBackoffMs: 0,
        consecutiveAuthErrors: 0,
        cooldownUntil: null,
        errorMessage: null,
      })
      .where(eq(accounts.id, accountId));

    this.invalidate(providerName);
  }

  /**
   * Mark an account as exhausted (also zeroes out quota remaining).
   *
   * `opts.resetAt` records when the upstream quota window rolls over so
   * fetchActiveAccounts can self-revive the row (same pattern as
   * cooldownUntil). Earlier-wins merge: a sooner reset is always more useful —
   * an existing future resetAt is only overwritten by an EARLIER one, and a
   * missing/past resetAt is always replaced. Never pass a value to push a
   * known reset further out.
   */
  async markExhausted(accountId: number, opts?: { resetAt?: Date | null }): Promise<void> {
    let nextResetAt: Date | undefined;
    if (opts?.resetAt && !Number.isNaN(opts.resetAt.getTime())) {
      const [cur] = await db
        .select({ quotaResetAt: accounts.quotaResetAt })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      const existing = cur?.quotaResetAt ? new Date(cur.quotaResetAt) : null;
      const existingMs =
        existing && !Number.isNaN(existing.getTime()) ? existing.getTime() : null;
      if (
        existingMs === null ||
        existingMs <= Date.now() ||
        opts.resetAt.getTime() < existingMs
      ) {
        nextResetAt = opts.resetAt;
      }
    }

    const [account] = await db
      .update(accounts)
      .set({
        status: "exhausted",
        quotaRemaining: 0,
        ...(nextResetAt ? { quotaResetAt: nextResetAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) {
      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: {
          id: accountId,
          status: "exhausted",
          provider: account.provider,
          quotaRemaining: 0,
          quotaLimit: Number(account.quotaLimit || 0),
          ...(nextResetAt ? { quotaResetAt: nextResetAt.toISOString() } : {}),
        },
      });
    }
  }

  /**
   * Pool depletion snapshot for the typed all-exhausted 429: how many enabled
   * rows the provider has, how many are exhausted, and the earliest reset
   * hint across them (drives Retry-After).
   */
  async getPoolDepletion(provider: ProviderName): Promise<PoolDepletion> {
    const rows = await db
      .select({ status: accounts.status, quotaResetAt: accounts.quotaResetAt })
      .from(accounts)
      .where(and(eq(accounts.provider, provider), eq(accounts.enabled, true)));
    return summarizePoolDepletion(rows, Date.now());
  }

  /**
   * Clear an error-status account back to active (after a successful request
   * served via the error fallback, or a successful re-validation).
   */
  async clearError(accountId: number): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "active",
        errorMessage: null,
        consecutiveAuthErrors: 0,
        cooldownUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();
    if (!account) return;
    this.invalidate(account.provider as ProviderName);
    broadcast({
      type: "account_status",
      data: { id: accountId, provider: account.provider, status: "active" },
    });
  }

  /**
   * Mark an account as errored. Terminal-error hysteresis: requires
   * TERMINAL_ERROR_THRESHOLD (3) CONSECUTIVE hard errors before disabling the
   * account. Below the threshold the account stays `active` with a short
   * cooldown, so a single transient 401/auth blip no longer permanently kills
   * it. A subsequent success resets the counter.
   *
   * Pass `{ terminal: true }` for permanent ban / Access denied so the row is
   * removed from the active pool immediately (no 3-strike stall on a dead
   * Build credential).
   */
  async markError(
    accountId: number,
    errorMessage: string,
    opts?: { terminal?: boolean },
  ): Promise<void> {
    if (opts?.terminal) {
      const [account] = await db
        .update(accounts)
        .set({
          status: "error",
          errorMessage,
          consecutiveAuthErrors: TERMINAL_ERROR_THRESHOLD,
          cooldownUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId))
        .returning();
      if (!account) return;
      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: {
          id: accountId,
          status: "error",
          error: errorMessage,
          consecutiveAuthErrors: TERMINAL_ERROR_THRESHOLD,
        },
      });
      return;
    }

    // Atomic increment: SET consecutive_auth_errors = consecutive_auth_errors + 1
    // in a single statement with RETURNING, so two concurrent failures can't
    // both read the same baseline and lose an increment (read-modify-write race).
    const [account] = await db
      .update(accounts)
      .set({
        // Increment atomically; SQLite applies SET col = col + 1 under its row lock.
        consecutiveAuthErrors: sql`${accounts.consecutiveAuthErrors} + 1`,
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (!account) return;
    const consecutive = account.consecutiveAuthErrors ?? 0;
    const terminal = consecutive >= TERMINAL_ERROR_THRESHOLD;
    if (terminal) {
      // Flip to terminal error state in a second (still-atomic) update.
      await db.update(accounts).set({
        status: "error",
        cooldownUntil: null,
        updatedAt: new Date(),
      }).where(eq(accounts.id, accountId));
    } else {
      await db.update(accounts).set({
        status: "active",
        cooldownUntil: new Date(Date.now() + 30_000),
        updatedAt: new Date(),
      }).where(eq(accounts.id, accountId));
    }

    this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: terminal ? "error" : "active", error: errorMessage, consecutiveAuthErrors: consecutive },
    });
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    // Exponential backoff: each consecutive transient failure doubles the
    // cooldown (2s, 4s, 8s, … capped at BACKOFF_MAX_MS). The account stays
    // `active` but is excluded from selection by cooldownUntil. Auto-reinstates
    // when the timestamp passes — no manual action, no permanent disable.
    //
    // ATOMIC: increment the failure counter AND double the backoff in a single
    // SQL statement with RETURNING, so concurrent transient failures can't both
    // read the same baseline and lose an increment / under-compute the backoff.
    // next_backoff_ms = min(coalesce(nullif(next_backoff_ms,0), <initial>)*2, <max>)
    const [account] = await db
      .update(accounts)
      .set({
        status: "active",
        errorMessage,
        consecutiveTransientFailures: sql`${accounts.consecutiveTransientFailures} + 1`,
        nextBackoffMs: sql`MIN(COALESCE(NULLIF(${accounts.nextBackoffMs}, 0), ${BACKOFF_INITIAL_MS}) * 2, ${BACKOFF_MAX_MS})`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (!account) return;
    const failures = account.consecutiveTransientFailures ?? 0;
    const delay = account.nextBackoffMs ?? BACKOFF_INITIAL_MS;
    const cooldownUntil = new Date(Date.now() + delay);
    // Set the cooldown timestamp from the atomically-computed delay.
    await db.update(accounts).set({ cooldownUntil, updatedAt: new Date() }).where(eq(accounts.id, accountId));

    this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "active", warning: errorMessage, cooldownUntil: cooldownUntil.toISOString() },
    });
  }

  /**
   * Mark an account as rate-limited (429). Honors the upstream reset time if
   * known: cools the account down until the real window resets (parsed from
   * `resetsAt`/`retryAfterMs`) rather than a synthetic backoff. Falls back to
   * the transient-failure backoff if the upstream gave no reset hint.
   */
  async markRateLimited(accountId: number, errorMessage: string, opts?: { resetsAt?: Date; retryAfterMs?: number }): Promise<void> {
    let cooldownUntil: Date;
    if (opts?.resetsAt && opts.resetsAt.getTime() > Date.now()) {
      cooldownUntil = opts.resetsAt;
    } else if (opts?.retryAfterMs && opts.retryAfterMs > 0) {
      cooldownUntil = new Date(Date.now() + opts.retryAfterMs);
    } else {
      // No upstream hint: use a short fixed cooldown (60s) — better than the
      // old behavior of immediately retrying and re-hitting the 429.
      cooldownUntil = new Date(Date.now() + 60_000);
    }

    const [account] = await db
      .update(accounts)
      .set({
        status: "active",
        errorMessage,
        cooldownUntil,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "active", warning: errorMessage, rateLimited: true, cooldownUntil: cooldownUntil.toISOString() },
    });
  }

  /**
   * Update account tokens (stored as jsonb).
   * Invalidates the active-account pool cache for that provider so the next
   * select does not keep serving a pre-rotation access/refresh token
   * (RFC 9700: rotated refresh tokens invalidate the previous RT).
   */
  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        tokens,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id, provider: accounts.provider });

    if (account?.provider) {
      this.invalidate(account.provider as ProviderName);
    }
  }

  /**
   * Toggle account enabled flag (user-controlled active/inactive).
   */
  async setEnabled(accountId: number, enabled: boolean): Promise<Account | null> {
    const [account] = await db
      .update(accounts)
      .set({
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (!account) return null;

    this.invalidate(account.provider as ProviderName);
    broadcast({
      type: "account_status",
      data: { id: accountId, enabled, provider: account.provider, status: account.status },
    });
    return account;
  }

  /**
   * Bulk toggle enabled flag for all accounts of a provider.
   */
  async setEnabledByProvider(provider: ProviderName, enabled: boolean): Promise<number> {
    const result = await db
      .update(accounts)
      .set({
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(accounts.provider, provider))
      .returning();

    const count = result.length;
    this.invalidate(provider);
    broadcast({
      type: "provider_toggled",
      data: { provider, enabled, count },
    });
    return count;
  }

  /**
   * Get pool statistics.
   *
   * Per-provider breakdown includes full status detail (active, exhausted,
   * error, pending, disabled). Package quotaLimit is summed over all enabled
   * accounts (including exhausted); remaining is summed over enabled remaining.
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    exhausted: number;
    error: number;
    pending: number;
    disabled: number;
    byProvider: Record<string, {
      active: number;
      total: number;
      exhausted: number;
      error: number;
      pending: number;
      disabled: number;
      quotaLimit: number;
      quotaRemaining: number;
    }>;
  }> {
    const [totals, providerRows] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
          exhausted: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
          error: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
          pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
          disabled: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
        })
        .from(accounts),
      db
        .select({
          provider: accounts.provider,
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
          exhausted: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
          error: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
          pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
          disabled: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
          // Package total = sum of limits for all enabled accounts (including
          // exhausted). Remaining = sum of remaining (exhausted contribute 0).
          // Do not drop package capacity when an account flips to exhausted.
          quotaLimit: sql<number>`COALESCE(SUM(CASE WHEN enabled = 1 AND quota_limit > 0 THEN quota_limit ELSE 0 END), 0)`,
          quotaRemaining: sql<number>`COALESCE(SUM(CASE WHEN enabled = 1 AND quota_remaining > 0 THEN quota_remaining ELSE 0 END), 0)`,
        })
        .from(accounts)
        .groupBy(accounts.provider),
    ]);

    const totalRow = totals[0];
    const byProvider: Record<string, {
      active: number;
      total: number;
      exhausted: number;
      error: number;
      pending: number;
      disabled: number;
      quotaLimit: number;
      quotaRemaining: number;
    }> = {};

    for (const row of providerRows) {
      byProvider[row.provider] = {
        active: row.active || 0,
        total: row.total || 0,
        exhausted: row.exhausted || 0,
        error: row.error || 0,
        pending: row.pending || 0,
        disabled: row.disabled || 0,
        quotaLimit: row.quotaLimit || 0,
        quotaRemaining: row.quotaRemaining || 0,
      };
    }

    return {
      total: totalRow?.total || 0,
      active: totalRow?.active || 0,
      exhausted: totalRow?.exhausted || 0,
      error: totalRow?.error || 0,
      pending: totalRow?.pending || 0,
      disabled: totalRow?.disabled || 0,
      byProvider,
    };
  }
}

export const pool = new AccountPool();
