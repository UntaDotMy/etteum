/**
 * Pure IP-ban helpers with zero module side effects.
 *
 * Kept separate from `ip-ban.ts` (which imports the DB) so unit tests can load
 * these without pulling Bun SQLite / config. Full-suite CI was failing with
 * "Export named 'isBannableIp' not found" when the DB-backed module was mid
 * circular evaluation under bun test load order.
 */

/** Pure: never ban loopback / unknown / empty — self-lockout guard. */
export function isLoopbackIpPure(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return (
    v === "127.0.0.1" ||
    v === "::1" ||
    v === "0:0:0:0:0:0:0:1" ||
    v.startsWith("127.")
  );
}

export const FRIEND_KEY_BAN_DAYS = 9999;

/** Pure: presenting this key scope on an admin surface trips the wire. */
export function shouldTripwire(scope: string | null | undefined): boolean {
  return scope === "managed";
}

/** Pure: never ban loopback / unknown / empty — self-lockout guard. */
export function isBannableIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim();
  if (!v || v.toLowerCase() === "unknown") return false;
  return !isLoopbackIpPure(v);
}
