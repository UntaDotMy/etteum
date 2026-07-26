import { db } from "../db/index";
import { settings } from "../db/schema";
import { inArray } from "drizzle-orm";
import { warmupQueue } from "./warmup-queue";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import { config } from "../config";
import { listProviderNames } from "../proxy/providers/registry";

const INTERVAL_KEY = "auto_warmup_interval_minutes"; // global default
const ENABLED_KEY_PREFIX = "auto_warmup_provider_";
const INTERVAL_KEY_PREFIX = "auto_warmup_interval_"; // per-provider override
const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
const WARMUP_STATUSES = ["active", "exhausted", "error"] as const;

/**
 * Max in-flight warmup jobs, persisted in the settings table so it's tunable
 * from the dashboard. 0 = unbounded. Falls back to config.warmupConcurrency
 * (env POOLPROX_WARMUP_CONCURRENCY, default 50) when unset/invalid.
 */
export const WARMUP_CONCURRENCY_KEY = "warmup_concurrency";

export function isAutoWarmupSettingKey(key: string): boolean {
  return (
    key === INTERVAL_KEY ||
    key === WARMUP_CONCURRENCY_KEY ||
    key.startsWith(ENABLED_KEY_PREFIX) ||
    key.startsWith(INTERVAL_KEY_PREFIX)
  );
}

interface ProviderSchedule {
  provider: string;
  intervalMinutes: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.floor(raw)));
}

class AutoWarmupScheduler {
  /** Global default interval (fallback for providers without a per-provider override). */
  private defaultIntervalMinutes: number = DEFAULT_INTERVAL_MINUTES;
  /** Per-provider schedules — only contains enabled providers. */
  private schedules = new Map<string, ProviderSchedule>();
  private running = false;
  /** F15: reset-window-aware tick timer. Probes accounts nearing their quota
   * reset boundary (mirrors reference lastPingedResetAt + refreshAheadMs) so an
   * exhausted account is reinstated as soon as its window rolls over, rather
   * than waiting for the next fixed-interval tick. */
  private resetTickTimer: ReturnType<typeof setInterval> | null = null;
  private resetTicking = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reload();
    // reset-window tick every 60s — queue only accounts due for reset.
    this.resetTickTimer = setInterval(() => { void this.resetTick().catch(() => {}); }, 60_000);
    if (this.resetTickTimer.unref) this.resetTickTimer.unref();
  }

  stop(): void {
    for (const sched of this.schedules.values()) {
      if (sched.timer) clearTimeout(sched.timer);
    }
    this.schedules.clear();
    if (this.resetTickTimer) clearInterval(this.resetTickTimer);
    this.resetTickTimer = null;
    this.running = false;
    this.broadcastStatus();
  }

  /** F15: probe accounts whose quota window is about to reset. */
  private async resetTick(): Promise<void> {
    if (this.resetTicking || !this.running) return;
    this.resetTicking = true;
    try {
      const count = await warmupQueue.queueAll({ onlyDueForReset: true, resetLeadMs: 5 * 60 * 1000 });
      if (count > 0) {
        addAuthLog({
          type: "warmup_reset_tick",
          message: `Reset-window warmup queued ${count} accounts due for quota reset`,
          data: { queued: count },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addAuthLog({ type: "warmup_auto_error", error: message });
    } finally {
      this.resetTicking = false;
    }
  }

  async reload(): Promise<void> {
    // Clear all existing timers
    for (const sched of this.schedules.values()) {
      if (sched.timer) clearTimeout(sched.timer);
    }
    this.schedules.clear();

    // Load all relevant settings in one query
    const keys = [
      INTERVAL_KEY,
      WARMUP_CONCURRENCY_KEY,
      // Registry-sourced: config.providers omits the OpenAI-compatible catalog
      // and dynamic compatible-nodes, so those could never be scheduled.
      ...listProviderNames().flatMap((p) => [
        `${ENABLED_KEY_PREFIX}${p}`,
        `${INTERVAL_KEY_PREFIX}${p}`,
      ]),
    ];
    const rows = await db.select().from(settings).where(inArray(settings.key, keys));
    const map = new Map(rows.map((row) => [row.key, row.value]));

    // Global default
    const rawDefault = Number(map.get(INTERVAL_KEY));
    this.defaultIntervalMinutes = Number.isFinite(rawDefault) && rawDefault > 0
      ? clampInterval(rawDefault)
      : DEFAULT_INTERVAL_MINUTES;

    // Warmup concurrency (0 = unbounded). Persisted in settings so the dashboard
    // can tune it; falls back to the env/config default when unset/invalid.
    const rawConcurrency = Number(map.get(WARMUP_CONCURRENCY_KEY));
    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 0
      ? Math.floor(rawConcurrency)
      : Number(config.warmupConcurrency) || 50;
    warmupQueue.setConcurrency(concurrency);

    // Build per-provider schedules for enabled providers
    for (const provider of listProviderNames()) {
      const enabled = map.get(`${ENABLED_KEY_PREFIX}${provider}`) === "true";
      if (!enabled) continue;

      const rawPerProvider = Number(map.get(`${INTERVAL_KEY_PREFIX}${provider}`));
      const intervalMinutes = Number.isFinite(rawPerProvider) && rawPerProvider > 0
        ? clampInterval(rawPerProvider)
        : this.defaultIntervalMinutes;

      this.schedules.set(provider, {
        provider,
        intervalMinutes,
        timer: null,
        nextRunAt: null,
        lastRunAt: null,
      });
    }

    // Schedule next run for each enabled provider
    if (this.running) {
      for (const sched of this.schedules.values()) {
        this.scheduleProvider(sched);
      }
    }

    this.broadcastStatus();
  }

  private scheduleProvider(sched: ProviderSchedule): void {
    if (sched.timer) clearTimeout(sched.timer);

    const delay = sched.intervalMinutes * 60_000;
    sched.nextRunAt = new Date(Date.now() + delay);
    sched.timer = setTimeout(() => {
      void this.tickProvider(sched);
    }, delay);
  }

  private async tickProvider(sched: ProviderSchedule): Promise<void> {
    sched.timer = null;
    sched.lastRunAt = new Date();
    sched.nextRunAt = null;

    try {
      const count = await warmupQueue.queueAll({
        providers: [sched.provider],
        statuses: [...WARMUP_STATUSES],
      });
      addAuthLog({
        type: "warmup_auto_tick",
        message: `Auto WarmUp queued ${count} accounts for ${sched.provider}`,
        data: { providers: [sched.provider], queued: count },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addAuthLog({
        type: "warmup_auto_error",
        error: message,
        message: `Auto WarmUp failed for ${sched.provider}: ${message}`,
      });
    }

    // Re-schedule if still running and still enabled
    if (this.running && this.schedules.has(sched.provider)) {
      this.scheduleProvider(sched);
    }

    this.broadcastStatus();
  }

  /**
   * Get the effective interval for a provider (per-provider override or global default).
   */
  getIntervalForProvider(provider: string): number {
    return this.schedules.get(provider)?.intervalMinutes ?? this.defaultIntervalMinutes;
  }

  getStatus() {
    const enabledProviders = [...this.schedules.keys()];
    const providerIntervals: Record<string, number> = {};
    const providerNextRunAt: Record<string, string | null> = {};
    const providerLastRunAt: Record<string, string | null> = {};

    for (const [provider, sched] of this.schedules) {
      providerIntervals[provider] = sched.intervalMinutes;
      providerNextRunAt[provider] = sched.nextRunAt ? sched.nextRunAt.toISOString() : null;
      providerLastRunAt[provider] = sched.lastRunAt ? sched.lastRunAt.toISOString() : null;
    }

    // For backwards compat: nextRunAt is the earliest across all providers
    const allNext = [...this.schedules.values()]
      .map((s) => s.nextRunAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    const nextRunAt = allNext[0] ? allNext[0].toISOString() : null;

    // For backwards compat: lastRunAt is the most recent across all providers
    const allLast = [...this.schedules.values()]
      .map((s) => s.lastRunAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime());
    const lastRunAt = allLast[0] ? allLast[0].toISOString() : null;

    return {
      running: this.running,
      intervalMinutes: this.defaultIntervalMinutes,
      enabledProviders,
      providerIntervals,
      providerNextRunAt,
      providerLastRunAt,
      nextRunAt,
      lastRunAt,
    };
  }

  private broadcastStatus(): void {
    broadcast({ type: "auto_warmup_status", data: this.getStatus() });
  }
}

export const autoWarmupScheduler = new AutoWarmupScheduler();
