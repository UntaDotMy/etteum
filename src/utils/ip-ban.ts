/**
 * Friend-key tripwire + IP ban store.
 *
 * Threat model: managed (friend) keys are /v1 client credentials. Presenting
 * one on an ADMIN surface (/api/*, dashboard login, dashboard WS) means the
 * key is being used by someone probing where it doesn't belong — so the key
 * is revoked on the spot and the caller's IP is banned from EVERY service
 * (requests included) for FRIEND_KEY_BAN_DAYS.
 *
 * IP identity: the unspoofable TCP peer (peerIpFromHonoContext) wins. When
 * the peer is loopback, the request arrived via the local share proxy — use
 * its stamped X-Forwarded-For instead (serve-share.ts overwrites XFF with the
 * real peer, so spoofed client XFF dies at the edge).
 *
 * Self-lockout guard: loopback / unidentified IPs are NEVER banned — local
 * operator work can't lock the operator out of their own box.
 */

import { desc, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/index";
import { apiKeys, ipBans, securityEvents } from "../db/schema";
import { invalidateResolvedApiKeys } from "../api/keys";
import {
  isLoopbackIp,
  peerIpFromHonoContext,
  realClientIp,
} from "./security";

export const FRIEND_KEY_BAN_DAYS = 9999;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure: presenting this key scope on an admin surface trips the wire. */
export function shouldTripwire(scope: string | null | undefined): boolean {
  return scope === "managed";
}

/** Pure: never ban loopback / unknown / empty — self-lockout guard. */
export function isBannableIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim();
  if (!v || v.toLowerCase() === "unknown") return false;
  return !isLoopbackIp(v);
}

/**
 * Best available client IP for ban decisions. Peer-first (unspoofable);
 * loopback peer means the local share proxy forwarded the request — trust
 * its stamped XFF. Falls back to header-derived IP only for TRUST_PROXY
 * deployments (realClientIp handles the env gate).
 */
export function effectiveClientIpFromParts(peerIp: string | null, headers: Headers): string {
  if (peerIp && !isLoopbackIp(peerIp)) return peerIp;
  if (peerIp) {
    const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (first) return first;
    return peerIp;
  }
  return realClientIp(headers);
}

/** Hono-context wrapper around effectiveClientIpFromParts. */
export function effectiveClientIp(c: any): string {
  return effectiveClientIpFromParts(
    peerIpFromHonoContext(c),
    c?.req?.raw?.headers ?? new Headers(),
  );
}

// ── Ban cache (small table; 10s TTL, writes update in-process immediately) ──
const banCache = new Map<string, number>(); // ip → expiresAt ms
let banCacheLoadedAt = 0;
const BAN_CACHE_TTL_MS = 10_000;

async function refreshBanCache(nowMs: number): Promise<void> {
  // Reap expired rows so the table stays small and stale bans self-heal.
  try {
    await db.delete(ipBans).where(lt(ipBans.expiresAt, new Date(nowMs)));
  } catch { /* best-effort */ }
  const rows = await db
    .select({ ip: ipBans.ip, expiresAt: ipBans.expiresAt })
    .from(ipBans)
    .where(gt(ipBans.expiresAt, new Date(nowMs)));
  banCache.clear();
  for (const r of rows) {
    const ms = r.expiresAt ? new Date(r.expiresAt).getTime() : 0;
    if (ms > nowMs) banCache.set(r.ip, ms);
  }
  banCacheLoadedAt = nowMs;
}

export async function isIpBanned(ip: string): Promise<boolean> {
  if (!ip || !isBannableIp(ip)) return false;
  const now = Date.now();
  if (now - banCacheLoadedAt > BAN_CACHE_TTL_MS) {
    try {
      await refreshBanCache(now);
    } catch {
      // DB hiccup: fail closed on cached data, open when empty.
    }
  }
  const exp = banCache.get(ip);
  if (!exp) return false;
  if (exp <= now) {
    banCache.delete(ip);
    return false;
  }
  return true;
}

/** Test-only: reset cache state between cases. */
export function __resetBanCacheForTests(): void {
  banCache.clear();
  banCacheLoadedAt = 0;
}

export async function banIp(
  ip: string,
  days: number,
  reason: string,
  detail?: string,
): Promise<{ banned: boolean; expiresAt: Date | null }> {
  if (!isBannableIp(ip)) return { banned: false, expiresAt: null };
  const now = Date.now();
  const expiresAt = new Date(now + days * DAY_MS);
  // Upsert: re-banning refreshes reason/expiry.
  const [existing] = await db.select({ id: ipBans.id }).from(ipBans).where(eq(ipBans.ip, ip)).limit(1);
  if (existing) {
    await db.update(ipBans).set({ reason, detail: detail ?? null, expiresAt }).where(eq(ipBans.id, existing.id));
  } else {
    await db.insert(ipBans).values({ ip, reason, detail: detail ?? null, expiresAt });
  }
  banCache.set(ip, expiresAt.getTime());
  banCacheLoadedAt = now;
  return { banned: true, expiresAt };
}

export async function unbanIp(ip: string): Promise<boolean> {
  const rows = await db.delete(ipBans).where(eq(ipBans.ip, ip)).returning({ id: ipBans.id });
  banCache.delete(ip);
  return rows.length > 0;
}

export async function listBans(): Promise<Array<{ ip: string; reason: string; detail: string | null; createdAt: Date | null; expiresAt: Date }>> {
  const rows = await db.select().from(ipBans).where(gt(ipBans.expiresAt, new Date()));
  return rows.map((r) => ({
    ip: r.ip,
    reason: r.reason,
    detail: r.detail,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt!,
  }));
}

// ── Security audit trail (previews only, never secrets) ────────────────────
export async function logSecurityEvent(entry: {
  ip?: string | null;
  surface: "api" | "ws" | "dashboard-login";
  path?: string | null;
  keyPreview?: string | null;
  action: "tripwire_revoke_ban" | "login_pool_success" | "login_invalid" | "unban";
  detail?: string | null;
}): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      ip: entry.ip ?? null,
      surface: entry.surface,
      path: entry.path ?? null,
      keyPreview: entry.keyPreview ?? null,
      action: entry.action,
      detail: entry.detail ?? null,
    });
  } catch (err) {
    console.error("[Security] failed to log event:", err);
  }
  console.warn(
    `[Security] ${entry.action} surface=${entry.surface} ip=${entry.ip ?? "?"} path=${entry.path ?? "-"} key=${entry.keyPreview ?? "-"}`,
  );
}

export async function listSecurityEvents(limit = 100): Promise<Array<Record<string, unknown>>> {
  const capped = Math.max(1, Math.min(limit, 500));
  const rows = await db
    .select()
    .from(securityEvents)
    .orderBy(desc(securityEvents.id))
    .limit(capped);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    ip: r.ip,
    surface: r.surface,
    path: r.path,
    keyPreview: r.keyPreview,
    action: r.action,
    detail: r.detail,
  }));
}

/**
 * THE tripwire: a managed key touched an admin surface.
 * 1. Revoke the key (is_active=false + resolution-cache flush).
 * 2. Ban the caller's IP for FRIEND_KEY_BAN_DAYS (loopback/unknown exempt).
 * 3. Write the audit event (key preview only).
 */
export async function triggerFriendKeyTripwire(args: {
  token: string;
  apiKeyId: number;
  surface: "api" | "ws" | "dashboard-login";
  path?: string | null;
  ip: string;
}): Promise<{ revoked: boolean; banned: boolean; ip: string }> {
  const keyPreview = args.token.slice(0, 12) + "…";

  await db
    .update(apiKeys)
    .set({ isActive: false })
    .where(eq(apiKeys.id, args.apiKeyId));
  invalidateResolvedApiKeys();

  const detail = `managed key #${args.apiKeyId} (${keyPreview}) presented on ${args.surface}${args.path ? ` ${args.path}` : ""}`;
  const { banned } = await banIp(args.ip, FRIEND_KEY_BAN_DAYS, "friend-key-on-admin-surface", detail);
  await logSecurityEvent({
    ip: args.ip,
    surface: args.surface,
    path: args.path ?? null,
    keyPreview,
    action: "tripwire_revoke_ban",
    detail,
  });
  return { revoked: true, banned, ip: args.ip };
}
