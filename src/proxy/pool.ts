import { db } from "../db/index";
import { accounts, settings } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";
import { config } from "../config";
import { getProviderForModel, type ProviderName } from "./providers/registry";

export type { ProviderName };

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
   * Get the next available account for a provider using configured method.
   */
  async getNextAccount(provider: ProviderName): Promise<Account | null> {
    const activeAccounts = await this.getActiveAccounts(provider);

    if (activeAccounts.length === 0) {
      return null;
    }

    const method = await this.getLoadBalancingMethod(provider);

    if (method === "sequential") {
      // Sequential: use first account with lowest in-flight, prefer order
      for (const account of activeAccounts) {
        if (this.getInFlightCount(account.id) === 0) return account;
      }
      return activeAccounts[0] || null;
    }

    // Round Robin (default)
    const startIdx = ((this.state.lastIndex.get(provider) || 0) + 1) % activeAccounts.length;
    let selected = activeAccounts[startIdx];
    let selectedIdx = startIdx;
    let selectedLoad = selected ? this.getInFlightCount(selected.id) : Number.POSITIVE_INFINITY;

    for (let i = 1; i < activeAccounts.length; i++) {
      const idx = (startIdx + i) % activeAccounts.length;
      const candidate = activeAccounts[idx];
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
   * Get the next available account for a specific model.
   * For Alibaba: filters by queryableModels to ensure account can actually query the model.
   * For other providers: falls back to standard getNextAccount.
   */
  async getNextAccountForModel(provider: ProviderName, model: string): Promise<Account | null> {
    // For Alibaba, filter by queryable models
    if (provider === "alibaba") {
      const activeAccounts = await this.getActiveAccounts(provider);
      if (activeAccounts.length === 0) return null;

      // Resolve model name (strip ali- prefix if present)
      const upstreamModel = model.startsWith("ali-") ? model.slice(4) : model;

      // Filter accounts that have this model in queryableModels
      const eligibleAccounts = activeAccounts.filter((account) => {
        const tokens = account.tokens as { queryableModels?: string[] } | null;
        if (!tokens?.queryableModels) return false;
        return tokens.queryableModels.includes(upstreamModel);
      });

      if (eligibleAccounts.length === 0) {
        // No eligible accounts - trigger auto-warmup to populate queryableModels
        // This happens when accounts are newly created or warmup hasn't run yet
        const needsWarmup = activeAccounts.filter((account) => {
          const tokens = account.tokens as { queryableModels?: string[] } | null;
          return !tokens?.queryableModels || tokens.queryableModels.length === 0;
        });

        if (needsWarmup.length > 0) {
          // Import warmupQueue dynamically to avoid circular dependency
          import("../auth/warmup-queue").then(({ warmupQueue }) => {
            for (const account of needsWarmup.slice(0, 10)) { // Limit to first 10 to avoid overwhelming
              warmupQueue.enqueue(account.id).catch(() => {});
            }
          }).catch(() => {});
        }

        return null;
      }

      // Apply load balancing to eligible accounts
      const method = await this.getLoadBalancingMethod(provider);

      if (method === "sequential") {
        for (const account of eligibleAccounts) {
          if (this.getInFlightCount(account.id) === 0) return account;
        }
        return eligibleAccounts[0] || null;
      }

      // Round Robin
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

    // For other providers, use standard routing
    return this.getNextAccount(provider);
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
      .returning({ quotaRemaining: accounts.quotaRemaining });

    return Number(account?.quotaRemaining || 0);
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
    return db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.status, "active"),
          eq(accounts.enabled, true),
        )
      );
  }

  /**
   * Get any available account across all providers that support the model.
   */
  async getAccountForModel(
    model: string,
    options: { excludeAccountIds?: Set<number> } = {}
  ): Promise<{ account: Account; provider: ProviderName } | null> {
    // Determine which provider handles this model
    const provider = this.getProviderForModel(model);
    if (!provider) return null;

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

    const account = await this.getNextAccount(provider);
    if (!account) return null;

    return { account, provider };
  }

  /**
   * Map model name to provider. Delegates to the provider registry, which asks
   * each provider's ownsModel() in priority order (single source of truth).
   */
  getProviderForModel(model: string): ProviderName | null {
    return getProviderForModel(model);
  }

  /**
   * Mark an account as used (update last_used_at)
   */
  async markUsed(accountId: number): Promise<void> {
    await db
      .update(accounts)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Mark an account as exhausted (also zeroes out quota remaining)
   */
  async markExhausted(accountId: number): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "exhausted",
        quotaRemaining: 0,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) {
      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: { id: accountId, status: "exhausted", provider: account.provider },
      });
    }
  }

  /**
   * Mark an account as errored
   */
  async markError(accountId: number, errorMessage: string): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "error",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "error", error: errorMessage },
    });
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "active",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "active", warning: errorMessage },
    });
  }

  /**
   * Update account tokens (stored as jsonb)
   */
  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    await db
      .update(accounts)
      .set({
        tokens,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
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
   * error, pending, disabled) plus quota totals summed ONLY over active &
   * enabled accounts — so error/exhausted/disabled accounts don't inflate
   * the displayed total credits.
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
          // Only count quota for active & enabled accounts — error/exhausted/
          // disabled accounts should not contribute to available credits.
          quotaLimit: sql<number>`COALESCE(SUM(CASE WHEN status = 'active' AND enabled = 1 THEN quota_limit ELSE 0 END), 0)`,
          quotaRemaining: sql<number>`COALESCE(SUM(CASE WHEN status = 'active' AND enabled = 1 THEN quota_remaining ELSE 0 END), 0)`,
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
