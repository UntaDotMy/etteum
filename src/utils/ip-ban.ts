/**
 * Admin-surface tripwire + IP ban store.
 *
 * Threat model: managed (friend) keys and wrong credentials on ADMIN surfaces
 * (/api/*, dashboard login, dashboard WS) mean the caller is probing where
 * they do not belong. Punish THAT IP only — ban for FRIEND_KEY_BAN_DAYS.
 * Never revoke the key: other IPs must keep using it on /v1 (models, anthropic
 * messages, chat completions, etc.).
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
import { ipBans, securityEvents } from "../db/schema";
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

/**
 * Best-effort client identity from request headers.
 * True PC hostname is only available if the client sends it (browsers usually
 * do not). Machine-id is present for managed-key clients that bind to a machine.
 */
export function clientIdentityFromHeaders(headers: Headers | null | undefined): {
  userAgent: string | null;
  machineId: string | null;
  clientHost: string | null;
} {
  if (!headers) {
    return { userAgent: null, machineId: null, clientHost: null };
  }
  const userAgent = headers.get("user-agent")?.trim() || null;
  const machineId =
    headers.get("x-machine-id")?.trim() ||
    headers.get("x-etteum-machine-id")?.trim() ||
    headers.get("x-9r-machine-id")?.trim() ||
    headers.get("x-client-machine-id")?.trim() ||
    null;
  // Optional client-supplied hostnames — never invent one.
  const clientHost =
    headers.get("x-client-hostname")?.trim() ||
    headers.get("x-hostname")?.trim() ||
    headers.get("x-pc-name")?.trim() ||
    headers.get("x-computer-name")?.trim() ||
    null;
  return { userAgent, machineId, clientHost };
}

function appendIdentityToDetail(
  base: string,
  identity: { userAgent: string | null; machineId: string | null; clientHost: string | null },
): string {
  const parts = [base];
  if (identity.userAgent) parts.push(`ua=${identity.userAgent.slice(0, 240)}`);
  if (identity.machineId) parts.push(`machine=${identity.machineId.slice(0, 120)}`);
  if (identity.clientHost) parts.push(`host=${identity.clientHost.slice(0, 120)}`);
  return parts.join(" | ");
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
export type SecuritySurface = "api" | "ws" | "dashboard-login";
export type SecurityAction =
  | "tripwire_ip_ban"
  | "tripwire_revoke_ban" // legacy label kept for old rows only
  | "login_pool_success"
  | "login_invalid"
  | "login_invalid_ban"
  | "unban";

export async function logSecurityEvent(entry: {
  ip?: string | null;
  surface: SecuritySurface;
  path?: string | null;
  keyPreview?: string | null;
  action: SecurityAction;
  detail?: string | null;
  userAgent?: string | null;
  machineId?: string | null;
  clientHost?: string | null;
}): Promise<void> {
  const detail = appendIdentityToDetail(entry.detail ?? "", {
    userAgent: entry.userAgent ?? null,
    machineId: entry.machineId ?? null,
    clientHost: entry.clientHost ?? null,
  }).replace(/^\s*\|\s*/, "").trim() || null;
  try {
    await db.insert(securityEvents).values({
      ip: entry.ip ?? null,
      surface: entry.surface,
      path: entry.path ?? null,
      keyPreview: entry.keyPreview ?? null,
      action: entry.action,
      detail,
    });
  } catch (err) {
    console.error("[Security] failed to log event:", err);
  }
  console.warn(
    `[Security] ${entry.action} surface=${entry.surface} ip=${entry.ip ?? "?"} path=${entry.path ?? "-"} key=${entry.keyPreview ?? "-"} host=${entry.clientHost ?? "-"} machine=${entry.machineId ?? "-"}`,
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
 * Friend-key tripwire: a managed key touched an admin surface.
 * 1. Ban the caller's IP for FRIEND_KEY_BAN_DAYS (loopback/unknown exempt).
 * 2. Write the audit event (key preview + client identity only).
 * 3. NEVER revoke the key — other IPs must keep using it on /v1.
 */
export async function triggerFriendKeyTripwire(args: {
  token: string;
  apiKeyId: number;
  surface: SecuritySurface;
  path?: string | null;
  ip: string;
  headers?: Headers | null;
}): Promise<{ revoked: false; banned: boolean; ip: string }> {
  const keyPreview = args.token.slice(0, 12) + "…";
  const identity = clientIdentityFromHeaders(args.headers ?? null);
  const detail = `managed key #${args.apiKeyId} (${keyPreview}) presented on ${args.surface}${args.path ? ` ${args.path}` : ""} — key left active; IP banned`;
  const { banned } = await banIp(args.ip, FRIEND_KEY_BAN_DAYS, "friend-key-on-admin-surface", appendIdentityToDetail(detail, identity));
  await logSecurityEvent({
    ip: args.ip,
    surface: args.surface,
    path: args.path ?? null,
    keyPreview,
    action: "tripwire_ip_ban",
    detail,
    userAgent: identity.userAgent,
    machineId: identity.machineId,
    clientHost: identity.clientHost,
  });
  return { revoked: false, banned, ip: args.ip };
}

/**
 * Wrong credential on dashboard login: ban that IP only.
 * No key is touched (there may not even be a valid key).
 */
export async function banInvalidLoginIp(args: {
  ip: string;
  path?: string | null;
  keyPreview?: string | null;
  headers?: Headers | null;
  detail?: string | null;
}): Promise<{ banned: boolean }> {
  const identity = clientIdentityFromHeaders(args.headers ?? null);
  const detail = args.detail ?? "invalid credential presented at dashboard login";
  const { banned } = await banIp(
    args.ip,
    FRIEND_KEY_BAN_DAYS,
    "invalid-dashboard-login",
    appendIdentityToDetail(detail, identity),
  );
  await logSecurityEvent({
    ip: args.ip,
    surface: "dashboard-login",
    path: args.path ?? "/api/dashboard-auth/login",
    keyPreview: args.keyPreview ?? null,
    action: banned ? "login_invalid_ban" : "login_invalid",
    detail,
    userAgent: identity.userAgent,
    machineId: identity.machineId,
    clientHost: identity.clientHost,
  });
  return { banned };
}
