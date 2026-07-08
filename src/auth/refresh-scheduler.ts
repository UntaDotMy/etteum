/**
 * Proactive token auto-refresh scheduler (F7).
 *
 * Ported from the reference proxy's claudeAutoPing.js (setInterval 60s tick) +
 * oauthCredentialManager.shouldRefreshCredentials (expiry-lead check).
 *
 * Problem it solves (the F7 gap): tokens were refreshed only reactively on a
 * 401/expired error (router.ts) or via a manual button. With refresh-token
 * rotation, a 401-triggered refresh can race (F8 coordinator mitigates this),
 * and a token that expires mid-request fails the request before refresh can
 * help. This scheduler proactively refreshes tokens BEFORE they expire, so
 * requests hit a valid token on the first try.
 *
 * Mechanism:
 *   - 60s tick (setInterval, .unref() so it never keeps the process alive).
 *   - For each active account with an `expires_at` in its `tokens` JSONB:
 *       refresh when `expiresAt - now < refreshLeadMs(provider)`.
 *   - Per-provider refreshLeadMs (mirrors reference: codex 5d, others 5min default).
 *   - Uses the F8 coordinator (coordinatedRefresh) so concurrent ticks + router
 *     401s coalesce, and unrecoverable errors disable the account.
 *
 * Settings (dashboard-tunable, mirror warmup-scheduler):
 *   - `auto_refresh_enabled` (global on/off, default true)
 *   - `auto_refresh_lead_minutes` (global lead, default 5)
 */
import { db } from "../db/index";
import { accounts, settings } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { providers } from "../proxy/providers/registry";
import { coordinatedRefresh } from "./refresh-coordinator";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";

const TICK_INTERVAL_MS = 60_000;
const ENABLED_KEY = "auto_refresh_enabled";
const LEAD_MINUTES_KEY = "auto_refresh_lead_minutes";
const DEFAULT_LEAD_MINUTES = 5;

// Per-provider refresh lead (ms before expiry to trigger refresh).
// Mirrors reference REFRESH_LEAD_MS (tokenRefresh.js:47-49 + per-provider registry).
const PROVIDER_REFRESH_LEAD_MS: Record<string, number> = {
  codex: 5 * 24 * 60 * 60 * 1000, // 5 days — Codex tokens rotate on a long window
  kiro: 5 * 60 * 1000,             // 5 min
  antigravity: 5 * 60 * 1000,      // 5 min
  codebuddy: 5 * 60 * 1000,        // 5 min
  "codebuddy-china": 5 * 60 * 1000,
  qoder: 5 * 60 * 1000,
};

function getRefreshLeadMs(provider: string, globalLeadMinutes: number): number {
  return PROVIDER_REFRESH_LEAD_MS[provider] ?? globalLeadMinutes * 60 * 1000;
}

/**
 * Extract the token expiry as an epoch-ms timestamp from an account's `tokens`
 * JSONB. Providers store `expires_at` as epoch-seconds (string or number).
 * Returns null when unknown / already expired-as-parsed / unparseable.
 */
function extractExpiryMs(tokens: unknown): number | null {
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, any>;
  const raw = t.expires_at ?? t.expiresAt ?? t.expiresAtMs;
  if (raw == null) return null;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  // Heuristic: if the value is in seconds (< 10^12), multiply to ms.
  return num < 1e12 ? num * 1000 : num;
}

class AutoRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, TICK_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    // Run an initial tick shortly after boot (don't block startup).
    setTimeout(() => { void this.tick().catch(() => {}); }, 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private async getSettings(): Promise<{ enabled: boolean; leadMinutes: number }> {
    const rows = await db.select().from(settings).where(inArray(settings.key, [ENABLED_KEY, LEAD_MINUTES_KEY]));
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const enabled = map.get(ENABLED_KEY);
    const lead = map.get(LEAD_MINUTES_KEY);
    return {
      enabled: enabled == null ? true : enabled !== "false",
      leadMinutes: lead && Number.isFinite(Number(lead)) ? Number(lead) : DEFAULT_LEAD_MINUTES,
    };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // reentrancy guard (mirrors claudeAutoPing g.running)
    this.ticking = true;
    try {
      const { enabled, leadMinutes } = await this.getSettings();
      if (!enabled) return;

      const now = Date.now();
      // Active, enabled accounts only — exhausted/error/pending are skipped
      // (they need warmup/re-login, not a refresh).
      const acctRows = await db.select().from(accounts).where(
        and(eq(accounts.status, "active"), eq(accounts.enabled, true)),
      );

      for (const acct of acctRows) {
        const providerName = acct.provider as keyof typeof providers;
        const provider = providers[providerName];
        if (!provider) continue;

        const expiryMs = extractExpiryMs(acct.tokens);
        if (expiryMs == null) continue; // no expiry info → can't schedule proactively

        const leadMs = getRefreshLeadMs(acct.provider, leadMinutes);
        if (expiryMs - now >= leadMs) continue; // not yet within the lead window

        // Within the refresh lead window → proactively refresh via the
        // coordinator (dedup + lock + retry + classification).
        try {
          const result = await coordinatedRefresh(provider, acct);
          if (result.success && result.tokens) {
            await pool.updateTokens(acct.id, result.tokens);
          } else if (result.unrecoverable) {
            // Permanent failure (invalid_grant / reused token) → disable.
            await pool.markError(acct.id, result.error || "Token unrecoverable — re-login required");
            broadcast({ type: "refresh_unrecoverable", data: { accountId: acct.id, provider: acct.provider, email: acct.email } });
          }
          // transient failures: leave for the next tick / reactive path.
        } catch (err) {
          // never let one account's refresh crash the tick loop
          console.error(`[RefreshScheduler] refresh failed for ${acct.provider}:${acct.email}:`, err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

export const autoRefreshScheduler = new AutoRefreshScheduler();

export function isAutoRefreshSettingKey(key: string): boolean {
  return key === ENABLED_KEY || key === LEAD_MINUTES_KEY;
}
