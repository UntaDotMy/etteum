import { db } from "../db/index";
import { accounts } from "../db/schema";
import { and, eq, inArray, lte, isNotNull } from "drizzle-orm";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import { warmupAccount, type WarmupResult } from "./warmup-runner";
import { config } from "../config";

type WarmupStatus = "queued" | "processing" | "retrying" | "completed" | "failed";

type QueueItem = {
  accountId: number;
  retries: number;
  status: WarmupStatus;
  addedAt: Date;
};

export interface ProviderProgress {
  total: number;
  completed: number;
  active: number;
}

export interface WarmupAllOptions {
  providers?: string[];
  statuses?: string[];
  includePending?: boolean;
  /**
   * F15: when true, only queue accounts whose quotaResetAt is within the reset
   * lead window (about to reset) OR has just passed (already due). Mirrors the
   * reference's reset-window-aware warmup (lastPingedResetAt + refreshAheadMs):
   * warmup right around the provider's reset boundary so an exhausted account
   * is reinstated + re-probed as soon as its window rolls over, instead of
   * waiting for the next fixed-interval tick.
   *
   * Accounts already probed for the same reset boundary (metadata.warmup
   * lastPingedResetAt >= quotaResetAt) are skipped so past reset timestamps
   * do not re-enqueue forever every 60s (Grok free Build often leaves a past
   * period-end with no next window).
   */
  onlyDueForReset?: boolean;
  /** Reset lead window in ms (only used when onlyDueForReset). Default 5 min. */
  resetLeadMs?: number;
}

/**
 * True when an account should be selected by the reset-window tick.
 * Pure helper — unit-tested without the DB/queue singleton.
 *
 * @param quotaResetAt account.quotaResetAt
 * @param metadata account.metadata (object or JSON string)
 * @param nowMs current time ms
 * @param leadMs how far ahead of resetAt to start probing (default 5 min)
 */
export function isAccountDueForResetWarmup(
  quotaResetAt: Date | string | number | null | undefined,
  metadata: unknown,
  nowMs: number = Date.now(),
  leadMs: number = 5 * 60 * 1000,
): boolean {
  if (quotaResetAt == null || quotaResetAt === "") return false;
  const resetMs = new Date(quotaResetAt as string | number | Date).getTime();
  if (!Number.isFinite(resetMs)) return false;
  // Not yet inside the lead window.
  if (resetMs > nowMs + leadMs) return false;

  let meta: Record<string, unknown> | null = null;
  if (typeof metadata === "string" && metadata.trim()) {
    try {
      meta = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  } else if (metadata && typeof metadata === "object") {
    meta = metadata as Record<string, unknown>;
  }
  const warmup =
    meta && typeof meta.warmup === "object" && meta.warmup
      ? (meta.warmup as Record<string, unknown>)
      : null;
  const lastPingedRaw = warmup?.lastPingedResetAt;
  if (typeof lastPingedRaw === "string" && lastPingedRaw.trim()) {
    const pingedMs = Date.parse(lastPingedRaw);
    // Already probed this same reset boundary (or a later one) → skip.
    // 1s slack for ISO round-trip / sqlite second precision.
    if (Number.isFinite(pingedMs) && pingedMs >= resetMs - 1000) {
      return false;
    }
  }
  return true;
}

class WarmupQueue {
  private queue: QueueItem[] = [];
  private activeJobs = 0;
  private processing = false;
  // 0 = unbounded (no cap). Configured via POOLPROX_WARMUP_CONCURRENCY.
  // Previously hard-capped at 20, which bottlenecked pools of 500+ accounts.
  private concurrency = Math.max(0, Number(config.warmupConcurrency) || 0);
  private readonly maxRetries = 2;
  private readonly historyLimit = 200;

  // Event-driven wakeup: instead of polling every 100ms when slots are full,
  // the loop awaits this promise and is resolved the instant a job finishes
  // (or concurrency is raised). Eliminates up-to-100ms latency per freed slot.
  private slotFreed: (() => void) | null = null;

  // Per-provider progress tracking (survives queue pruning)
  private progressByProvider: Record<string, { total: number; completed: number }> = {};

  // Abort controller for the current "generation" of jobs. stop() aborts it,
  // which (a) drops queued items + prevents retries and (b) signals every
  // in-flight warmupAccount() to abort its provider HTTP call mid-flight.
  // New enqueues after a stop lazily create a fresh controller so warmup can
  // run again — stop is a one-shot cancel, not a permanent disable.
  private stopController: AbortController | null = null;

  /** Per-account abort so delete account stops that job without killing all warmups. */
  private accountAbort = new Map<number, AbortController>();

  /** The signal in-flight jobs should observe. Never null once work is running. */
  private stopSignal(): AbortSignal {
    if (!this.stopController) this.stopController = new AbortController();
    return this.stopController.signal;
  }

  private accountSignal(accountId: number): AbortSignal {
    let c = this.accountAbort.get(accountId);
    if (!c || c.signal.aborted) {
      c = new AbortController();
      this.accountAbort.set(accountId, c);
    }
    return c.signal;
  }

  private combinedSignal(accountId: number): AbortSignal {
    const global = this.stopSignal();
    const local = this.accountSignal(accountId);
    if (typeof AbortSignal !== "undefined" && typeof (AbortSignal as { any?: Function }).any === "function") {
      return AbortSignal.any([global, local]);
    }
    // Older runtimes: pass local; processItem also checks global abort flag.
    return local;
  }

  /**
   * Drop queued warmup for deleted accounts and abort in-flight probes.
   * Called from account delete paths so warmup does not continue after delete.
   */
  cancelAccounts(accountIds: number | number[]): { cancelled: number } {
    const ids = new Set(
      (Array.isArray(accountIds) ? accountIds : [accountIds]).filter(
        (n) => Number.isInteger(n) && n > 0,
      ),
    );
    if (ids.size === 0) return { cancelled: 0 };

    let cancelled = 0;
    for (const item of this.queue) {
      if (!ids.has(item.accountId)) continue;
      if (item.status === "completed" || item.status === "failed") continue;
      if (item.status === "queued" || item.status === "retrying") {
        item.status = "failed";
        cancelled++;
        const provider = this.getCachedAccountProvider(item.accountId);
        if (provider && this.progressByProvider[provider]) {
          this.progressByProvider[provider]!.completed = Math.min(
            this.progressByProvider[provider]!.total,
            this.progressByProvider[provider]!.completed + 1,
          );
        }
      } else if (item.status === "processing") {
        // Abort HTTP; processItem marks failed when signal aborts.
        this.accountAbort.get(item.accountId)?.abort();
        cancelled++;
      }
    }

    for (const id of ids) {
      this.accountAbort.get(id)?.abort();
      this.accountAbort.delete(id);
      this.accountProviderCache.delete(id);
    }

    this.queue = this.queue.filter(
      (item) =>
        !(ids.has(item.accountId) && (item.status === "failed" || item.status === "completed")),
    );

    if (cancelled > 0) {
      broadcast({
        type: "warmup_accounts_cancelled",
        data: { accountIds: [...ids], cancelled },
      });
    }
    return { cancelled };
  }

  async enqueue(accountId: number): Promise<void> {
    this.pruneTerminalItems();
    if (this.queue.some((item) => item.accountId === accountId && item.status !== "completed" && item.status !== "failed")) {
      return;
    }
    // Fresh abort controller if this id was cancelled earlier.
    this.accountAbort.delete(accountId);

    const item: QueueItem = { accountId, retries: 0, status: "queued", addedAt: new Date() };
    this.queue.push(item);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    const provider = account?.provider;

    if (provider) {
      if (!this.progressByProvider[provider]) {
        this.progressByProvider[provider] = { total: 0, completed: 0 };
      }
      this.progressByProvider[provider].total++;
    }

    const log = addAuthLog({
      type: "warmup_queue_added",
      accountId,
      message: `Account #${accountId} queued for WarmUp`,
    });
    broadcast({
      type: "warmup_queue_added",
      data: { logId: log.id, accountId, provider, message: log.message, timestamp: log.timestamp },
    });

    this.process();
  }

  async enqueueBulk(accountIds: number[]): Promise<void> {
    this.pruneTerminalItems();

    const existingIds = new Set(
      this.queue
        .filter((item) => item.status !== "completed" && item.status !== "failed")
        .map((item) => item.accountId)
    );
    const newIds = accountIds.filter((id) => !existingIds.has(id));
    if (newIds.length === 0) return;

    // Batch-load accounts to avoid N+1 queries
    const rows = await db.select().from(accounts).where(inArray(accounts.id, newIds));
    const accountMap = new Map(rows.map((a) => [a.id, a]));

    // Reset progress for providers that are being enqueued for the first
    // time in this batch so each auto-tick shows fresh counters. Providers
    // that still have in-flight work from a previous batch are left alone —
    // their active/completed counters survive the reset so the dashboard
    // doesn't jump to 0% mid-warmup.
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.provider)) continue;
      seen.add(row.provider);
      const existing = this.progressByProvider[row.provider];
      if (!existing || existing.completed >= existing.total) {
        this.progressByProvider[row.provider] = { total: 0, completed: 0 };
      }
    }

    // Add all items to queue
    for (const id of newIds) {
      this.accountAbort.delete(id);
      const account = accountMap.get(id);
      const item: QueueItem = { accountId: id, retries: 0, status: "queued", addedAt: new Date() };
      this.queue.push(item);

      if (account?.provider) {
        if (!this.progressByProvider[account.provider]) {
          this.progressByProvider[account.provider] = { total: 0, completed: 0 };
        }
        this.progressByProvider[account.provider]!.total++;
      }

      const log = addAuthLog({
        type: "warmup_queue_added",
        accountId: id,
        message: `Account #${id} queued for WarmUp`,
      });
      broadcast({
        type: "warmup_queue_added",
        data: { logId: log.id, accountId: id, provider: account?.provider, message: log.message, timestamp: log.timestamp },
      });
    }

    this.process();
  }

  async queueAll(options: WarmupAllOptions = {}): Promise<number> {
    // Use all known providers from config as the default.
    // Previously this was a hardcoded ["kiro", "kiro-pro", "codebuddy"] list
    // that silently excluded codebuddy-china, canva, codex, qoder, gitlab-duo,
    // youmind, and byok — their accounts never got warmed up, sessions expired,
    // and live requests hit dead accounts → 503 "All accounts failed".
    const providers = options.providers?.length
      ? options.providers
      : [...config.providers];
    const statuses = options.statuses?.length
      ? options.statuses
      : options.includePending
        ? ["active", "exhausted", "error", "pending"]
        : ["active", "exhausted", "error"];

    const conditions = [
      inArray(accounts.provider, providers),
      inArray(accounts.status, statuses),
    ];

    // reset-window-aware selection. When onlyDueForReset is set, limit to
    // accounts whose quotaResetAt is within the lead window (about to reset) —
    // so warmup runs right around the provider's reset boundary and an
    // exhausted account is reinstated + re-probed as soon as its window rolls
    // over, rather than on a fixed interval. lastPingedResetAt filters out
    // accounts already probed for that same boundary (stops infinite re-queue).
    if (options.onlyDueForReset) {
      const leadMs = options.resetLeadMs ?? 5 * 60 * 1000;
      const horizon = new Date(Date.now() + leadMs);
      conditions.push(isNotNull(accounts.quotaResetAt));
      conditions.push(lte(accounts.quotaResetAt, horizon));

      const rows = await db
        .select({
          id: accounts.id,
          quotaResetAt: accounts.quotaResetAt,
          metadata: accounts.metadata,
        })
        .from(accounts)
        .where(and(...conditions));

      const nowMs = Date.now();
      const ids = rows
        .filter((row) =>
          isAccountDueForResetWarmup(row.quotaResetAt, row.metadata, nowMs, leadMs),
        )
        .map((row) => row.id);
      await this.enqueueBulk(ids);
      return ids.length;
    }

    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(...conditions));

    const ids = rows.map((row) => row.id);
    await this.enqueueBulk(ids);
    return ids.length;
  }

  getStatus() {
    this.pruneTerminalItems();
    return {
      queued: this.queue.filter((item) => item.status === "queued").length,
      active: this.activeJobs,
      processing: this.processing,
      concurrency: this.concurrency,
      items: this.queue.map((item) => ({ ...item, addedAt: item.addedAt.toISOString() })),
    };
  }

  /**
   * Get warmup progress per provider.
   * Uses progressByProvider as the source of truth (survives queue pruning).
   * Active count comes from items currently in queue.
   */
  getProgressByProvider(): Record<string, ProviderProgress> {
    // Count active (processing/retrying) items per provider from the queue
    const activeByProvider: Record<string, number> = {};
    for (const item of this.queue) {
      if (item.status === "processing" || item.status === "retrying") {
        const account = this.getCachedAccountProvider(item.accountId);
        if (account) {
          activeByProvider[account] = (activeByProvider[account] || 0) + 1;
        }
      }
    }

    const result: Record<string, ProviderProgress> = {};
    for (const [provider, progress] of Object.entries(this.progressByProvider)) {
      if (progress.total > 0) {
        result[provider] = {
          total: progress.total,
          completed: progress.completed,
          active: activeByProvider[provider] || 0,
        };
      }
    }

    return result;
  }

  clear(): void {
    this.queue = this.queue.filter((item) => item.status === "processing" || item.status === "retrying");
    this.progressByProvider = {};
    broadcast({ type: "warmup_queue_cleared", data: {} });
  }

  /**
   * Stop warmup hard: drop every queued item, prevent retries of in-flight
   * jobs, and abort all running provider HTTP calls mid-flight. Unlike
   * clear() (which only drops queued items and lets running jobs finish),
   * stop() cancels active work too. One-shot: subsequent enqueue() calls
   * create a fresh stop controller, so warmup can be started again normally.
   */
  stop(): { dropped: number; active: number } {
    // Count queued/retrying items we're about to drop.
    const dropped = this.queue.filter(
      (item) => item.status === "queued" || item.status === "retrying"
    ).length;

    // Mark queued/retrying as failed so the loop won't pick them up and the
    // retry path won't resurrect them. In-flight (processing) items are left
    // as-is — they'll be aborted via the signal and settle on their own.
    for (const item of this.queue) {
      if (item.status === "queued" || item.status === "retrying") {
        item.status = "failed";
      }
    }

    // Abort the current generation. In-flight jobs that observe the signal
    // bail out of healthCheck/probes/DB-write. A fresh controller is created
    // lazily on the next enqueue(), so warmup remains usable afterwards.
    if (this.stopController) {
      this.stopController.abort();
    }
    this.stopController = new AbortController();

    this.progressByProvider = {};
    broadcast({ type: "warmup_stopped", data: { dropped, active: this.activeJobs } });
    return { dropped, active: this.activeJobs };
  }

  setConcurrency(concurrency: number): void {
    // 0 = unbounded. No hard upper clamp — the cap is now governed by
    // config.warmupConcurrency / POOLPROX_WARMUP_CONCURRENCY so operators can
    // tune it per deployment without a code change.
    this.concurrency = Math.max(0, Math.floor(concurrency) || 0);
    // If the loop is parked waiting for a slot, raising the cap may have
    // freed one — wake it immediately rather than waiting up to 100ms.
    if (this.slotFreed) {
      const wake = this.slotFreed;
      this.slotFreed = null;
      wake();
    }
    this.process();
  }

  // ── Private ──────────────────────────────────────────────────────

  // Cache of accountId → provider to avoid repeated DB lookups
  private accountProviderCache = new Map<number, string>();

  private getCachedAccountProvider(accountId: number): string | undefined {
    return this.accountProviderCache.get(accountId);
  }

  private setCachedAccountProvider(accountId: number, provider: string): void {
    this.accountProviderCache.set(accountId, provider);
  }

  private process(): void {
    if (this.processing) return;
    this.processing = true;
    void this.processLoop();
  }

  private async processLoop(): Promise<void> {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Re-check concurrency each iteration (may have changed via setConcurrency).
        // concurrency === 0 means unbounded — never park on slots.
        const atCap = this.concurrency > 0 && this.activeJobs >= this.concurrency;
        if (atCap) {
          // Event-driven wait: wake the instant a job finishes (or the cap is
          // raised via setConcurrency), instead of polling every 100ms.
          // 5s safety timeout guards against a missed wakeup so the loop can
          // never deadlock if a slot-free signal is dropped.
          await new Promise<void>((resolve) => {
            this.slotFreed = resolve;
            setTimeout(resolve, 5000);
          });
          this.slotFreed = null;
          continue;
        }
        const item = this.queue.find((entry) => entry.status === "queued");
        if (!item) break;
        item.status = "processing";
        this.activeJobs++;
        void this.processItem(item).finally(async () => {
          this.activeJobs--;
          // Wake the loop immediately if it's parked waiting for a slot.
          if (this.slotFreed) {
            const wake = this.slotFreed;
            this.slotFreed = null;
            wake();
          }
          // Add inter-job delay to prevent network saturation when warming 100+ accounts.
          // This gives the network stack breathing room between probe requests.
          if (config.warmupDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, config.warmupDelayMs));
          }
          this.process();
        });
      }
    } finally {
      this.processing = false;
      this.pruneTerminalItems();

      // Check if all work is done
      if (this.activeJobs === 0 && !this.queue.some(
        (item) => item.status === "queued" || item.status === "processing" || item.status === "retrying"
      )) {
        // Broadcast completion for each provider that had work
        for (const provider of Object.keys(this.progressByProvider)) {
          broadcast({
            type: "warmup_complete",
            data: { provider, ...this.progressByProvider[provider] },
          });
        }
        // Clear progress after completion so next fetch doesn't get stale data
        this.progressByProvider = {};
      }
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    // Combined stop (global) + per-account delete abort.
    const stopSignal = this.combinedSignal(item.accountId);
    const isCancelled = () =>
      stopSignal.aborted ||
      this.accountAbort.get(item.accountId)?.signal.aborted === true ||
      this.stopController?.signal.aborted === true;

    const [account] = await db.select().from(accounts).where(eq(accounts.id, item.accountId));
    if (!account) {
      item.status = "failed";
      this.accountAbort.delete(item.accountId);
      return;
    }

    this.setCachedAccountProvider(account.id, account.provider);

    const log = addAuthLog({
      type: "warmup_processing",
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      step: "queued_check",
      message: `WarmUp processing ${account.provider}/${account.email}`,
    });
    broadcast({
      type: "warmup_processing",
      data: {
        logId: log.id,
        accountId: account.id,
        id: account.id,
        email: account.email,
        provider: account.provider,
        attempt: item.retries + 1,
        remaining: this.queue.filter((entry) => entry.status === "queued").length,
        message: log.message,
        timestamp: log.timestamp,
      },
    });

    try {
      const result = await warmupAccount(account, stopSignal);

      if (isCancelled()) {
        item.status = "failed";
        return;
      }

      // Account deleted mid-warmup: do not write status back.
      const [stillThere] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, item.accountId))
        .limit(1);
      if (!stillThere) {
        item.status = "failed";
        return;
      }

      if (result.retryable && item.retries < this.maxRetries) {
        item.retries++;
        item.status = "retrying";
        await this.delay(this.backoffMs(item.retries));
        if (isCancelled()) {
          item.status = "failed";
          return;
        }
        item.status = "queued";
        return;
      }

      const success =
        result.success || result.kind === "unsupported" || result.kind === "transient_error";
      item.status = success ? "completed" : "failed";

      const provProgress = this.progressByProvider[account.provider];
      if (provProgress) {
        provProgress.completed++;
      }
    } catch (error) {
      if (isCancelled()) {
        item.status = "failed";
        return;
      }
      if (item.retries < this.maxRetries) {
        item.retries++;
        item.status = "retrying";
        await this.delay(this.backoffMs(item.retries));
        if (isCancelled()) {
          item.status = "failed";
          return;
        }
        item.status = "queued";
        return;
      }

      item.status = "failed";
      const catchProgress = this.progressByProvider[account.provider];
      if (catchProgress) {
        catchProgress.completed++;
      }

      const message = error instanceof Error ? error.message : String(error);
      const failLog = addAuthLog({
        type: "warmup_auth_error",
        accountId: account.id,
        email: account.email,
        provider: account.provider,
        error: message,
        message,
      });
      broadcast({
        type: "warmup_auth_error",
        data: {
          logId: failLog.id,
          accountId: account.id,
          id: account.id,
          email: account.email,
          provider: account.provider,
          error: message,
          timestamp: log.timestamp,
        },
      });
    } finally {
      this.accountAbort.delete(item.accountId);
    }
  }

  private backoffMs(retries: number): number {
    const base = Math.min(10000, 2000 * 2 ** Math.max(0, retries - 1));
    return base + Math.floor(Math.random() * 500);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private pruneTerminalItems(): void {
    const active = this.queue.filter((item) => item.status !== "completed" && item.status !== "failed");
    const terminal = this.queue
      .filter((item) => item.status === "completed" || item.status === "failed")
      .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
      .slice(0, this.historyLimit);
    this.queue = [...active, ...terminal];
  }
}

export const warmupQueue = new WarmupQueue();
