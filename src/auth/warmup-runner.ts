import { db } from "../db/index";
import { accounts, type Account } from "../db/schema";
import { eq } from "drizzle-orm";
import { providers } from "../proxy/router";
import { pool, type ProviderName } from "../proxy/pool";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import type { ProviderHealthKind, ProviderHealthResult, ProviderQuotaSnapshot } from "../proxy/providers/base";

type AccountStatus = "active" | "exhausted" | "error" | "pending" | string;

export interface WarmupResult {
  success: boolean;
  accountId: number;
  provider: string;
  email: string;
  previousStatus: AccountStatus;
  status: AccountStatus;
  kind: ProviderHealthKind;
  quota?: ProviderQuotaSnapshot;
  refreshedTokens?: boolean;
  retryable?: boolean;
  error?: string;
  message?: string;
}

interface AccountWarmupUpdate {
  status: AccountStatus;
  errorMessage: string | null;
  quotaLimit?: number;
  quotaRemaining?: number;
  quotaResetAt?: Date | null;
  freeLimit?: number;
  freeRemaining?: number;
  freeResetAt?: Date | null;
  tokens?: unknown;
  metadata: unknown;
}

// ============================================================================
// Qoder-specific tunables
// ============================================================================
// Qoder uses a custom daily-credit system (200 req/day) that lives in the
// `quotaLimit`/`quotaRemaining` columns. The Qoder server itself reports a
// *different* quota that we must NOT clobber those columns with — but we still
// want to observe it for drift, exhaustion, and debugging. These constants
// govern the safety nets around that observation.

/** How often we may run the qd-Lite inference probe per account. */
const QODER_PROBE_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/** How long a probe-passed quota override remains trusted before we re-probe. */
const QODER_QUOTA_OVERRIDE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Drift thresholds.
 * - vs server (`/quota/usage`): permissive — server commonly reports `0/0`
 *   sentinel for accounts it's not tracking, which would otherwise spam.
 * - vs activity (`/activity` per-model promo): strict — both sides are exact
 *   per-day counters, so meaningful drift implies real bookkeeping bug.
 */
const QODER_DRIFT_VS_SERVER_THRESHOLD = 50;
const QODER_DRIFT_VS_ACTIVITY_THRESHOLD = 5;

// ============================================================================
// Metadata helpers
// ============================================================================

function shortError(value?: string) {
  if (!value) return null;
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getWarmupMeta(account: Account): Record<string, unknown> {
  const meta = asObject(account.metadata);
  return asObject(meta.warmup);
}

/**
 * Build the next `metadata` blob for the account.
 *
 * Strategy:
 *  - Spread `existing` first so untouched fields survive.
 *  - Spread provider-supplied `health.metadata` next (e.g. inferenceProbe).
 *  - Then write our authoritative `warmup` and `serverQuota` blocks last so
 *    they always reflect the current tick.
 */
function mergeWarmupMetadata(
  account: Account,
  health: ProviderHealthResult,
  extras: { lastProbeAt?: string; quotaOverride?: { active: boolean; until: string } | null } = {},
) {
  const existing = asObject(account.metadata);
  const prevWarmup = asObject(existing.warmup);
  const now = new Date().toISOString();

  // Always preserve the *server's* view of the quota in metadata, even when we
  // intentionally skip writing the DB columns (Qoder custom-credit case).
  // This lets the dashboard surface drift between custom-daily vs server.
  const serverQuota = health.quota
    ? {
        limit: Number(health.quota.limit ?? 0) || 0,
        remaining: Number(health.quota.remaining ?? 0) || 0,
        used: Number(health.quota.used ?? 0) || 0,
        resetAt: health.quota.resetAt
          ? new Date(health.quota.resetAt as unknown as string | number | Date).toISOString()
          : null,
        source: health.quota.source ?? null,
        reportedExhausted: health.kind === "exhausted",
        reportedAt: now,
      }
    : (existing.serverQuota ?? null);

  // Carry quotaOverride forward unless explicitly replaced; expire if past TTL.
  let quotaOverride = extras.quotaOverride;
  if (quotaOverride === undefined) {
    const prev = asObject(prevWarmup.quotaOverride);
    if (prev.until && typeof prev.until === "string") {
      const until = Date.parse(prev.until);
      quotaOverride = Number.isFinite(until) && until > Date.now()
        ? (prev as { active: boolean; until: string })
        : null;
    } else {
      quotaOverride = null;
    }
  }

  // Hoist activityQuota explicitly so consumers (dashboard, drift detection)
  // get a typed top-level field instead of relying on `...health.metadata`
  // spread order. Carry forward the previous snapshot when this tick failed
  // to fetch — stale data is more useful than missing data, and the error
  // breadcrumb (`activityQuotaError`) flags freshness.
  const incomingActivity = (health.metadata as Record<string, unknown> | undefined)?.activityQuota;
  const activityQuota = incomingActivity != null ? incomingActivity : (existing.activityQuota ?? null);

  // Record which quota-reset boundary this tick probed so the 60s resetTick
  // does not re-enqueue the same account forever when quotaResetAt stays in
  // the past (common on Grok free Build after a billing period end).
  let lastPingedResetAt: string | null =
    (typeof prevWarmup.lastPingedResetAt === "string"
      ? prevWarmup.lastPingedResetAt
      : null) ?? null;
  if (account.quotaResetAt) {
    const resetMs = new Date(account.quotaResetAt).getTime();
    if (Number.isFinite(resetMs)) {
      lastPingedResetAt = new Date(resetMs).toISOString();
    }
  }

  // Grok throttled chat liveness: stamp from this tick when present, else keep.
  const healthMeta = asObject(health.metadata);
  const lastChatProbeAt =
    typeof healthMeta.lastChatProbeAt === "string"
      ? healthMeta.lastChatProbeAt
      : typeof prevWarmup.lastChatProbeAt === "string"
        ? prevWarmup.lastChatProbeAt
        : null;
  const chatProbe =
    typeof healthMeta.chatProbe === "string"
      ? healthMeta.chatProbe
      : typeof prevWarmup.chatProbe === "string"
        ? prevWarmup.chatProbe
        : null;

  return {
    ...existing,
    ...(health.metadata || {}),
    warmup: {
      lastCheckedAt: now,
      kind: health.kind,
      success: health.success,
      retryable: Boolean(health.retryable),
      quotaSource: health.quota?.source ?? null,
      authRefreshed: Boolean(health.tokens),
      lastError: shortError(health.error || health.message),
      lastProbeAt: extras.lastProbeAt ?? (prevWarmup.lastProbeAt as string | undefined) ?? null,
      quotaOverride: quotaOverride ?? null,
      lastPingedResetAt,
      lastChatProbeAt,
      chatProbe,
    },
    serverQuota,
    activityQuota,
    overage: health.quota?.overage || existing.overage || null,
  };
}

/**
 * Find the activity bucket that maps to a given upstream model key (e.g.
 * `qmodel_latest` → qd-Qwen3.7-Max). Used by drift detection and message
 * formatting; safe to return `null` when the activity payload is missing or
 * the model isn't covered by any promo.
 */
function findActivityForModelKey(
  activity: unknown,
  modelKey: string,
): { limit: number; remaining: number; used: number; eligible: boolean; resetAt: number | null } | null {
  const obj = asObject(activity);
  const list = Array.isArray(obj.activities) ? (obj.activities as unknown[]) : [];
  for (const entry of list) {
    const e = asObject(entry);
    const keys = Array.isArray(e.modelKeys) ? (e.modelKeys as unknown[]).map(String) : [];
    if (keys.includes(modelKey)) {
      const resetAtRaw = Number(e.resetAt);
      return {
        limit: Number(e.limit ?? 0) || 0,
        remaining: Number(e.remaining ?? 0) || 0,
        used: Number(e.used ?? 0) || 0,
        eligible: e.eligible === true,
        resetAt: Number.isFinite(resetAtRaw) && resetAtRaw > 0 ? resetAtRaw : null,
      };
    }
  }
  return null;
}

// ============================================================================
// Qoder-specific health policy
// ============================================================================

interface QoderPolicy {
  /** Skip writing `status`/`errorMessage` (preserve custom credit state). */
  skipStatusUpdate: boolean;
  /** Skip writing quota columns (preserve custom 200/day credits). */
  skipQuotaColumns: boolean;
}

/**
 * Qoder uses Qoder's own quota as the source of truth on every warmup. We
 * override DB counters with real data from `/quota/usage` (All) and
 * `/activity` bucket `qmodel_latest` (Free) every cycle.
 *
 * Status flip rules:
 *   - auth/session/banned: honored (require human).
 *   - probe-confirmed exhaustion: honored.
 *   - server "exhausted" alone: NOT honored unless probe agrees (Qoder
 *     OpenAPI sometimes reports 0/0 for accounts that still serve).
 *   - healthy: always allow status flip back to active (auto-recovery).
 */
function decideQoderPolicy(account: Account, health: ProviderHealthResult): QoderPolicy {
  if (account.provider !== "qoder") {
    return { skipStatusUpdate: false, skipQuotaColumns: false };
  }

  // Auth/session failures are always honored — they require human action.
  const isAuthFailure =
    health.kind === "session_expired" ||
    health.kind === "auth_error" ||
    health.kind === "banned" ||
    health.kind === "missing_tokens";
  if (isAuthFailure) {
    // Quota columns still get overridden when present (data is data).
    return { skipStatusUpdate: false, skipQuotaColumns: false };
  }

  const probe = (health.metadata as Record<string, unknown> | undefined)?.inferenceProbe;

  // Probe-confirmed exhaustion: trust it.
  if (probe === "quota_exhausted") {
    return { skipStatusUpdate: false, skipQuotaColumns: false };
  }

  // Server reports exhausted but probe didn't confirm — don't flip status
  // (false-exhaustion case), but still override quota columns with real data.
  if (health.kind === "exhausted" && probe !== "healthy") {
    return { skipStatusUpdate: true, skipQuotaColumns: false };
  }

  // Healthy or recoverable: full override allowed.
  return { skipStatusUpdate: false, skipQuotaColumns: false };
}

// ============================================================================
// Mapping health → DB update
// ============================================================================

export function mapHealthToAccountUpdate(account: Account, health: ProviderHealthResult): AccountWarmupUpdate {
  const policy = decideQoderPolicy(account, health);

  let status: AccountStatus = account.status;
  let errorMessage: string | null = account.errorMessage || null;

  switch (health.kind) {
    case "healthy":
      if (!policy.skipStatusUpdate) {
        status = "active";
        errorMessage = null;
      }
      break;
    case "exhausted":
      if (!policy.skipStatusUpdate) {
        status = "exhausted";
        errorMessage = "Quota exhausted";
      }
      break;
    case "banned":
      status = "error";
      errorMessage = health.error || "Account banned or disabled";
      break;
    case "session_expired":
      status = "error";
      errorMessage = health.error || "Session expired; re-login required";
      break;
    case "auth_error":
      status = "error";
      errorMessage = health.error || "Authentication error";
      break;
    case "missing_tokens":
      status = account.status === "pending" ? "pending" : "error";
      errorMessage = health.error || "No tokens available; login required";
      break;
    case "transient_error":
      status = account.status;
      errorMessage = health.error || health.message || account.errorMessage || "Transient warmup error";
      break;
    case "unsupported":
      status = account.status;
      errorMessage = health.message || health.error || account.errorMessage || null;
      break;
  }

  const update: AccountWarmupUpdate = {
    status,
    errorMessage,
    metadata: mergeWarmupMetadata(account, health),
  };

  if (!policy.skipQuotaColumns) {
    // ── Quota preservation policy ────────────────────────────────────────
    // The golden rule: **warmup must never INCREASE quotaRemaining above
    // the locally-tracked value, and must never clobber it with a worse
    // value from a transient failure.**
    //
    // The DB's quotaRemaining is decremented on every live request via
    // pool.decrementQuota(). It is the most accurate real-time view of
    // what the account has left. The upstream billing API may lag behind
    // (not yet synced), return stale data, or — for some providers like
    // codebuddy / codebuddy-china — return the FULL package capacity
    // instead of actual remaining when queried with an API key.
    //
    // Rules:
    //   1. Upstream remaining < DB remaining  → write upstream (server
    //      caught usage we missed, e.g. from another client).
    //   2. Upstream remaining >= DB remaining → keep DB value (server is
    //      stale or returns full capacity; our local tracking is more
    //      accurate because it decrements per-request).
    //   3. Fallback/stale quota source       → don't write at all.
    //   4. No quota info                     → don't write, unless
    //      genuinely exhausted (then remaining=0).
    //   5. quotaLimit                        → always write the upstream
    //      limit (it's the package size, doesn't change with usage).
    const quotaSource = String(health.quota?.source || "");
    // stored-farm-credits is a stale import snapshot — never authoritative for
    // warmup writes (would re-inflate every Grok account to full ~2M).
    const isFallbackQuota =
      quotaSource === "tracked" ||
      quotaSource === "" ||
      quotaSource.includes("fallback") ||
      quotaSource.includes("stale") ||
      quotaSource.includes("stored-farm");

    if (health.quota && !isFallbackQuota) {
      const rawLimit = Number(health.quota.limit);
      const rawRemaining = Number(health.quota.remaining);
      const isGrok = account.provider === "grok";
      // Free-Build absolute packages (~2e6) must never land in accounts.quota_*.
      // Dashboard free-tier truth is weekly 0–100 only.
      const isGrokFreeBuildAbsolute =
        isGrok &&
        Number.isFinite(rawLimit) &&
        rawLimit >= 500_000 &&
        !(
          quotaSource.includes("GetGrokCreditsConfig") ||
          quotaSource.includes("weekly-percent")
        );

      // Sentinel `-1` means "unknown / unlimited" — preserve whatever the
      // provider already wrote into the DB instead of clobbering it.
      // Free-Build absolute package size must not land in quota_limit, but
      // free-usage-exhausted chat probes still must zero remaining so the
      // account leaves the active pool before user traffic hits it.
      if (health.kind === "exhausted" && isGrokFreeBuildAbsolute) {
        update.quotaRemaining = 0;
      } else if (Number.isFinite(rawLimit) && rawLimit >= 0 && !isGrokFreeBuildAbsolute) {
        update.quotaLimit = rawLimit;

        // Compute the safe remaining: never let warmup increase
        // quotaRemaining beyond what we've been tracking locally.
        const dbRemaining = Number(account.quotaRemaining);
        const dbLimit = Number(account.quotaLimit);
        const upstreamRemaining = Number.isFinite(rawRemaining) ? Math.max(0, rawRemaining) : 0;

        // Scale change (e.g. Grok percent-pool 100 → absolute free Build ~2e6
        // tokens). Min-preserving against the old scale would pin remaining at
        // 100 forever even though the real budget is millions.
        const scaleChanged =
          Number.isFinite(dbLimit) &&
          dbLimit > 0 &&
          rawLimit > 0 &&
          (rawLimit / dbLimit >= 10 || dbLimit / rawLimit >= 10);

        // CLI weekly pool (0–100) is authoritative — always write upstream.
        const isGrokWeeklyPercent =
          isGrok &&
          (quotaSource.includes("GetGrokCreditsConfig") ||
            quotaSource.includes("weekly-percent") ||
            (rawLimit > 0 && rawLimit <= 100));
        const untrustedFullRemaining =
          isGrok &&
          !isGrokWeeklyPercent &&
          (quotaSource.includes("untrusted-full-remaining") ||
            (rawLimit > 1000 &&
              upstreamRemaining >= rawLimit &&
              health.kind !== "exhausted"));

        if (health.kind === "exhausted") {
          // Provider says exhausted — always zero out.
          update.quotaRemaining = 0;
        } else if (isGrokWeeklyPercent) {
          // Same surface as Grok CLI creditUsagePercent — trust live probe.
          update.quotaRemaining = upstreamRemaining;
        } else if (untrustedFullRemaining) {
          // Never seed free-Build absolute package into remaining.
          // (isGrokFreeBuildAbsolute already blocked limit write above.)
        } else if (scaleChanged) {
          update.quotaRemaining = upstreamRemaining;
        } else if (Number.isFinite(dbRemaining) && dbRemaining > 0) {
          // We have a local value — take the minimum. This prevents
          // the billing API from resetting quota to "full" when it
          // hasn't synced recent usage. If the upstream value is lower
          // (server caught usage from another client), use that.
          update.quotaRemaining = Math.min(dbRemaining, upstreamRemaining);
        } else {
          // No local value (first warmup, or was reset) — trust upstream.
          update.quotaRemaining = upstreamRemaining;
        }
      }
      if (health.quota.resetAt) {
        const resetAt = new Date(health.quota.resetAt);
        if (!Number.isNaN(resetAt.getTime())) update.quotaResetAt = resetAt;
      } else if (
        // Grok free Build probes often return no next reset window. A past
        // quotaResetAt (e.g. ended billing period) would keep the 60s reset
        // tick re-queuing forever. Clear it once we've probed healthy/exhausted
        // without a new future boundary.
        account.provider === "grok" &&
        (health.kind === "healthy" || health.kind === "exhausted") &&
        account.quotaResetAt &&
        new Date(account.quotaResetAt).getTime() <= Date.now()
      ) {
        update.quotaResetAt = null;
      }
    } else if (health.quota && isFallbackQuota) {
      // Fallback quota (e.g. "tracked" source) — this is the SAME data
      // already in the DB. Don't write it back (no-op). Only zero out
      // remaining if the provider is genuinely exhausted.
      if (health.kind === "exhausted") {
        update.quotaRemaining = 0;
      }
      // Preserve existing quotaLimit/quotaRemaining by not setting them.
    } else if (health.kind === "exhausted") {
      // No quota info but provider says exhausted — zero out remaining.
      update.quotaRemaining = 0;
    }
    // else: no quota info and not exhausted — preserve existing DB values.

    // Grok: if we never received a future reset window this tick, drop a
    // past quotaResetAt so the global 60s resetTick stops re-adding the row.
    // lastPingedResetAt is the primary guard; clearing is belt-and-suspenders
    // for free Build accounts that never get a real period end.
    if (
      account.provider === "grok" &&
      (health.kind === "healthy" || health.kind === "exhausted") &&
      update.quotaResetAt === undefined &&
      !health.quota?.resetAt &&
      account.quotaResetAt &&
      new Date(account.quotaResetAt).getTime() <= Date.now()
    ) {
      update.quotaResetAt = null;
    }

    // Free counter mirrors /activity bucket qmodel_latest.
    // Same preservation logic: never increase above DB value, only write
    // when we have real data.
    if (account.provider === "qoder") {
      const meta = (health.metadata as Record<string, unknown> | undefined) ?? {};
      const freeBucket = findActivityForModelKey(meta.activityQuota, "qmodel_latest");
      if (freeBucket) {
        update.freeLimit = freeBucket.limit;
        const dbFreeRemaining = Number(account.freeRemaining);
        const upstreamFree = Math.max(0, freeBucket.remaining);
        if (Number.isFinite(dbFreeRemaining) && dbFreeRemaining > 0) {
          update.freeRemaining = Math.min(dbFreeRemaining, upstreamFree);
        } else {
          update.freeRemaining = upstreamFree;
        }
        update.freeResetAt = freeBucket.resetAt != null ? new Date(freeBucket.resetAt) : null;
      }
      // Don't clobber free quota to 0 when we don't have activity data —
      // preserve whatever the DB already has.
    }
  }

  if (health.tokens) update.tokens = health.tokens;
  return update;
}

// ============================================================================
// Inference probes (kiro overage + qoder false-exhaustion)
// ============================================================================

type ProviderLike = (typeof providers)[keyof typeof providers];

/**
 * Run the kiro/kiro-pro overage probe, or the codex credit-override probe.
 * Mutates `health` in place when the probe determines the account can still
 * serve requests via PAYG overage (kiro) or pay-as-you-go credits (codex).
 *
 * Codex accounts report `overage.enabled` from healthCheck when their plan rate
 * window is full but a credit balance keeps them usable. Without this probe,
 * such an account would be benched as "exhausted" even though it can still
 * bill credits — the same false-exhaustion problem kiro has with overage.
 */
async function runKiroOverageProbe(provider: ProviderLike, account: Account, health: ProviderHealthResult): Promise<void> {
  if (health.kind !== "exhausted") return;
  if (!health.quota?.overage?.enabled) return;

  const isKiro = account.provider.startsWith("kiro");
  const isCodex = account.provider === "codex";
  if (!isKiro && !isCodex) return;

  try {
    const probeResult = await provider.chatCompletion(account, {
      model: isKiro
        ? (account.provider === "kiro-pro" ? "claude-sonnet-4.6" : "auto")
        : "codex-auto",
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 4,
    });
    if (probeResult.success) {
      health.kind = "healthy";
      health.success = true;
      health.metadata = { ...health.metadata, inferenceProbe: "passed", overageBudget: true };
    } else if (probeResult.quotaExhausted) {
      health.metadata = { ...health.metadata, inferenceProbe: "quota_exhausted" };
    } else {
      health.metadata = { ...health.metadata, inferenceProbe: "failed", probeError: probeResult.error?.slice(0, 100) };
    }
  } catch (e) {
    health.metadata = {
      ...health.metadata,
      inferenceProbe: "error",
      probeError: (e instanceof Error ? e.message : String(e)).slice(0, 100),
    };
  }
}

interface QoderProbeOutcome {
  ranProbe: boolean;
  probeAt?: string;
  override?: { active: boolean; until: string } | null;
}

/**
 * Run the Qoder false-exhaustion probe.
 *
 * The Qoder OpenAPI sometimes reports `userQuota.remaining=0` for accounts that
 * can still serve requests. We confirm with the cheapest model (qd-Lite,
 * price_factor=0). Throttled to once per `QODER_PROBE_THROTTLE_MS` per account
 * to avoid hammering the upstream.
 *
 * On success we set `quotaOverride` with a TTL so a stale "passed" verdict
 * cannot mask a real ban indefinitely — the next tick after the TTL expires
 * will re-probe.
 */
async function runQoderFalseExhaustionProbe(
  provider: ProviderLike,
  account: Account,
  health: ProviderHealthResult,
): Promise<QoderProbeOutcome> {
  if (health.kind !== "exhausted") return { ranProbe: false };
  if (account.provider !== "qoder") return { ranProbe: false };

  // Don't probe accounts that are GENUINELY dead — the false-exhaustion probe
  // exists to catch the server wrongly flagging a working account, not to
  // resurrect administratively-blocked ones. healthCheck only marks a Qoder
  // account exhausted when whitelistBlocked (NoLicense/AppDisable/LoginExpire/
  // NoIpPermission/...); a probe passing on a free model wouldn't unblock it.
  // (Note: zero-credit Community accounts are NOT exhausted — qd-Lite is
  // always-free and works without credits, so they stay healthy for free
  // models. paidCreditsExhausted in metadata tracks the paid-model state.)
  const meta = (health.metadata || {}) as Record<string, any>;
  if (meta.whitelistBlocked === true) {
    health.metadata = { ...health.metadata, inferenceProbe: "skipped_whitelist_blocked" };
    return { ranProbe: false };
  }

  const prevWarmup = getWarmupMeta(account);
  const lastProbeAt = typeof prevWarmup.lastProbeAt === "string" ? Date.parse(prevWarmup.lastProbeAt) : NaN;
  const throttled = Number.isFinite(lastProbeAt) && Date.now() - lastProbeAt < QODER_PROBE_THROTTLE_MS;

  // Honor an unexpired probe-passed override so we don't probe every tick.
  const prevOverride = asObject(prevWarmup.quotaOverride);
  const overrideValidUntil = typeof prevOverride.until === "string" ? Date.parse(prevOverride.until) : NaN;
  const overrideStillValid = prevOverride.active === true && Number.isFinite(overrideValidUntil) && overrideValidUntil > Date.now();

  if (throttled || overrideStillValid) {
    health.metadata = {
      ...health.metadata,
      inferenceProbe: overrideStillValid ? "skipped_override" : "skipped_throttle",
    };
    if (overrideStillValid) {
      // Override still trusted — flip back to healthy so downstream pool isn't poisoned.
      health.kind = "healthy";
      health.success = true;
    }
    return { ranProbe: false };
  }

  const probeAt = new Date().toISOString();
  try {
    const probeResult = await provider.chatCompletion(account, {
      model: "qd-Lite",
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 4,
    });
    if (probeResult.success) {
      health.kind = "healthy";
      health.success = true;
      const until = new Date(Date.now() + QODER_QUOTA_OVERRIDE_TTL_MS).toISOString();
      health.metadata = { ...health.metadata, inferenceProbe: "passed" };
      return { ranProbe: true, probeAt, override: { active: true, until } };
    }
    if (probeResult.quotaExhausted) {
      health.metadata = { ...health.metadata, inferenceProbe: "quota_exhausted" };
      return { ranProbe: true, probeAt, override: null };
    }
    health.metadata = {
      ...health.metadata,
      inferenceProbe: "failed",
      probeError: probeResult.error?.slice(0, 100),
    };
    return { ranProbe: true, probeAt };
  } catch (e) {
    health.metadata = {
      ...health.metadata,
      inferenceProbe: "error",
      probeError: (e instanceof Error ? e.message : String(e)).slice(0, 100),
    };
    return { ranProbe: true, probeAt };
  }
}

// ============================================================================
// Log message formatting
// ============================================================================

function eventTypeFor(kind: ProviderHealthKind) {
  if (kind === "healthy") return "warmup_success";
  if (kind === "exhausted") return "warmup_exhausted";
  if (kind === "transient_error") return "warmup_transient_error";
  if (kind === "unsupported") return "warmup_unsupported";
  return "warmup_auth_error";
}

function messageFor(result: WarmupResult, account: Account, healthMeta?: Record<string, unknown>): string {
  const isQoder = result.provider === "qoder";

  if (isQoder) {
    const dailyRem = account.quotaRemaining ?? "?";
    const dailyLim = account.quotaLimit ?? "?";
    const serverRem = result.quota?.remaining ?? "n/a";
    const serverLim = result.quota?.limit ?? "n/a";
    const probe = healthMeta?.inferenceProbe;
    const probeTag = typeof probe === "string" ? ` probe=${probe}` : "";

    // Free quota — surfaces the qmodel_latest promo bucket if present.
    const bucket = findActivityForModelKey(healthMeta?.activityQuota, "qmodel_latest");
    const freeTag = bucket
      ? `, free[qmodel_latest] ${bucket.remaining}/${bucket.limit}${bucket.eligible ? "" : " (ineligible)"}`
      : healthMeta?.activityQuotaError
        ? `, free=err`
        : "";

    if (result.kind === "healthy") {
      return `WarmUp healthy — daily ${dailyRem}/${dailyLim}, server ${serverRem}/${serverLim}${freeTag}${probeTag}`;
    }
    if (result.kind === "exhausted") {
      return `WarmUp exhausted — daily ${dailyRem}/${dailyLim}, server ${serverRem}/${serverLim}${freeTag}`;
    }
  }

  if (result.kind === "healthy") return `WarmUp healthy: ${result.quota?.remaining ?? "unknown"} credits remaining`;
  if (result.kind === "exhausted") return "WarmUp detected exhausted quota";
  if (result.kind === "transient_error") return `WarmUp transient error: ${result.error || result.message || "unknown"}`;
  if (result.kind === "unsupported") return result.message || "WarmUp unsupported for provider";
  return result.error || result.message || `WarmUp ${result.kind}`;
}

// ============================================================================
// Drift detection (Qoder)
// ============================================================================

/**
 * Drift detection for Qoder.
 *
 * Strategy:
 *   1. If `/activity` returned a per-model bucket matching our `qmodel_latest`
 *      mapping, compare DB daily-remaining against it (strict threshold).
 *      This is the preferred signal — both sides are exact per-day counters.
 *   2. Otherwise fall back to comparing against `/quota/usage` (lenient
 *      threshold), skipping the `0/0` sentinel.
 *
 * One log per drift source — both can fire if both sources exist and disagree.
 */
function emitQoderDriftWarningIfAny(account: Account, health: ProviderHealthResult): void {
  if (account.provider !== "qoder") return;
  const dailyRem = Number(account.quotaRemaining ?? NaN);
  if (!Number.isFinite(dailyRem)) return;

  // --- Activity-based drift (preferred) ---
  const activity = (health.metadata as Record<string, unknown> | undefined)?.activityQuota;
  // qmodel_latest is the upstream key we care about (qd-Qwen3.7-Max promo).
  const bucket = findActivityForModelKey(activity, "qmodel_latest");
  if (bucket && bucket.limit > 0) {
    const drift = dailyRem - bucket.remaining;
    if (Math.abs(drift) >= QODER_DRIFT_VS_ACTIVITY_THRESHOLD) {
      addAuthLog({
        type: "warmup_drift_warning",
        accountId: account.id,
        email: account.email,
        provider: account.provider,
        step: "drift_activity",
        message: `Qoder drift vs activity[qmodel_latest]: daily=${dailyRem}, activity=${bucket.remaining}, diff=${drift}`,
        data: {
          source: "activity",
          modelKey: "qmodel_latest",
          dailyRemaining: dailyRem,
          activityRemaining: bucket.remaining,
          activityLimit: bucket.limit,
          drift,
        },
      });
    }
  }

  // --- Server-quota drift (fallback / additional signal) ---
  if (health.quota) {
    const serverRem = Number(health.quota.remaining ?? NaN);
    if (Number.isFinite(serverRem)) {
      const serverLim = Number(health.quota.limit ?? 0) || 0;
      // 0/0 from /quota/usage is the "no data" sentinel — skip.
      const isSentinel = serverLim === 0 && serverRem === 0;
      if (!isSentinel) {
        const drift = dailyRem - serverRem;
        if (Math.abs(drift) >= QODER_DRIFT_VS_SERVER_THRESHOLD) {
          addAuthLog({
            type: "warmup_drift_warning",
            accountId: account.id,
            email: account.email,
            provider: account.provider,
            step: "drift_server",
            message: `Qoder drift vs server: daily=${dailyRem}, server=${serverRem}, diff=${drift}`,
            data: { source: "server", dailyRemaining: dailyRem, serverRemaining: serverRem, drift },
          });
        }
      }
    }
  }
}

// ============================================================================
// Public entry point
// ============================================================================

export async function warmupAccount(account: Account, signal?: AbortSignal): Promise<WarmupResult> {
  const provider = providers[account.provider as keyof typeof providers];
  if (!provider) {
    return {
      success: false,
      accountId: account.id,
      provider: account.provider,
      email: account.email,
      previousStatus: account.status,
      status: "error",
      kind: "unsupported",
      error: `Provider not configured: ${account.provider}`,
    };
  }

  // If the warmup was already stopped before this job started running, bail
  // out without hitting the network or touching the DB.
  if (signal?.aborted) {
    return {
      success: false,
      accountId: account.id,
      provider: account.provider,
      email: account.email,
      previousStatus: account.status,
      status: account.status,
      kind: "transient_error",
      retryable: false,
      error: "Warmup cancelled",
      message: "Warmup cancelled before start",
    };
  }

  const startLog = addAuthLog({
    type: "warmup_processing",
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    step: "checking",
    message: `WarmUp checking ${account.provider}/${account.email}`,
  });

  broadcast({
    type: "warmup_processing",
    data: {
      logId: startLog.id,
      id: account.id,
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      step: "checking",
      message: startLog.message,
      timestamp: startLog.timestamp,
    },
  });

  const health: ProviderHealthResult = await provider.healthCheck(account, signal);

  // The healthCheck is the long network call. If warmup was stopped mid-flight
  // (signal aborted), skip the probes + DB write so we don't leave partial
  // state or kick off extra inference calls for a job we're cancelling.
  if (signal?.aborted) {
    return {
      success: false,
      accountId: account.id,
      provider: account.provider,
      email: account.email,
      previousStatus: account.status,
      status: account.status,
      kind: health.kind,
      retryable: false,
      error: "Warmup cancelled",
      message: "Warmup cancelled mid-flight",
    };
  }

  // Probes — each may mutate `health` in place.
  await runKiroOverageProbe(provider, account, health);
  const qoderProbe = await runQoderFalseExhaustionProbe(provider, account, health);

  // Drift detection runs against the (now possibly probe-adjusted) `health`.
  emitQoderDriftWarningIfAny(account, health);

  // Build the DB update (status/quota policy lives inside this).
  const update = mapHealthToAccountUpdate(account, health);

  // Reconcile metadata with probe outcomes (lastProbeAt + quotaOverride).
  // We re-merge here so the metadata reflects probe bookkeeping, not just the
  // raw health response.
  if (account.provider === "qoder" && qoderProbe.ranProbe) {
    update.metadata = mergeWarmupMetadata(account, health, {
      lastProbeAt: qoderProbe.probeAt,
      quotaOverride: qoderProbe.override ?? null,
    });
  }

  const dbUpdate: Record<string, unknown> = {
    status: update.status,
    errorMessage: update.errorMessage,
    metadata: update.metadata,
    updatedAt: new Date(),
  };
  if (update.quotaLimit !== undefined) dbUpdate.quotaLimit = update.quotaLimit;
  if (update.quotaRemaining !== undefined) dbUpdate.quotaRemaining = update.quotaRemaining;
  if (update.quotaResetAt !== undefined) dbUpdate.quotaResetAt = update.quotaResetAt;
  if (update.freeLimit !== undefined) dbUpdate.freeLimit = update.freeLimit;
  if (update.freeRemaining !== undefined) dbUpdate.freeRemaining = update.freeRemaining;
  if (update.freeResetAt !== undefined) dbUpdate.freeResetAt = update.freeResetAt;
  if (update.tokens !== undefined) dbUpdate.tokens = update.tokens;

  await db.update(accounts).set(dbUpdate).where(eq(accounts.id, account.id));
  pool.invalidate(account.provider as ProviderName);

  const result: WarmupResult = {
    success: health.kind === "healthy" || health.kind === "exhausted",
    accountId: account.id,
    provider: account.provider,
    email: account.email,
    previousStatus: account.status,
    status: update.status,
    kind: health.kind,
    quota: health.quota,
    refreshedTokens: Boolean(health.tokens),
    retryable: Boolean(health.retryable),
    error: health.error,
    message: health.message,
  };

  const type = eventTypeFor(health.kind);
  const log = addAuthLog({
    type,
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    step: health.kind,
    message: messageFor(result, account, health.metadata as Record<string, unknown> | undefined),
    error: health.kind === "healthy" || health.kind === "exhausted" ? undefined : health.error,
    data: {
      kind: health.kind,
      status: update.status,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
      retryable: health.retryable,
      refreshedTokens: Boolean(health.tokens),
      // Qoder-only diagnostics
      ...(account.provider === "qoder"
        ? (() => {
            const meta = health.metadata as Record<string, unknown> | undefined;
            const bucket = findActivityForModelKey(meta?.activityQuota, "qmodel_latest");
            return {
              serverQuotaLimit: health.quota?.limit ?? null,
              serverQuotaRemaining: health.quota?.remaining ?? null,
              inferenceProbe: meta?.inferenceProbe ?? null,
              freeQuota: bucket
                ? {
                    modelKey: "qmodel_latest",
                    limit: bucket.limit,
                    remaining: bucket.remaining,
                    eligible: bucket.eligible,
                  }
                : null,
              activityQuotaError: meta?.activityQuotaError ?? null,
            };
          })()
        : {}),
    },
  });

  broadcast({
    type,
    data: {
      logId: log.id,
      id: account.id,
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      status: update.status,
      kind: health.kind,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
      retryable: health.retryable,
      refreshedTokens: Boolean(health.tokens),
      message: log.message,
      error: log.error,
      timestamp: log.timestamp,
    },
  });

  broadcast({
    type: "account_status",
    data: {
      id: account.id,
      status: update.status,
      provider: account.provider,
      error: update.errorMessage,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
    },
  });

  return result;
}
