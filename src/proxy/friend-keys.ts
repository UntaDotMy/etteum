import { db } from "../db/index";
import { apiKeys } from "../db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Friend-key limit helpers.
 *
 * A "friend key" is a managed row in api_keys that may carry four optional
 * limits: a model allowlist, a total token quota, a per-key requests/minute
 * cap, and an expiry. The legacy single env/settings key is never limited —
 * only rows in api_keys (identified by apiKeyId) are.
 */

export type KeyAccess =
  | { allowed: true; row: typeof apiKeys.$inferSelect }
  | { allowed: false; reason: "not_found" | "inactive" | "expired" | "quota_exhausted" };

/** Parse the JSON model allowlist. null/empty array = unrestricted. */
export function parseAllowedModels(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) return arr.filter((x): x is string => typeof x === "string");
  } catch {
    /* malformed JSON -> treat as unrestricted rather than failing closed oddly */
  }
  return null;
}

/** True when the parsed allowlist permits `model`. A null allowlist permits all. */
export function modelAllowed(allowlist: string[] | null, model: string): boolean {
  if (!allowlist) return true;
  return allowlist.includes(model);
}

/** True when the key is past its expiry (no expiry configured = false). */
export function isExpired(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() <= Date.now();
}

/**
 * Load a managed key and evaluate whether it may currently serve a request.
 * Checks active flag, expiry, and token quota — but NOT the per-model allowlist
 * (that needs the requested model, done separately via modelAllowed).
 */
export async function checkKeyAccess(apiKeyId: number): Promise<KeyAccess> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId)).limit(1);
  if (!row) return { allowed: false, reason: "not_found" };
  if (!row.isActive) return { allowed: false, reason: "inactive" };
  if (isExpired(row.expiresAt)) return { allowed: false, reason: "expired" };
  if (row.tokenQuota != null && (row.tokensUsed ?? 0) >= row.tokenQuota) {
    return { allowed: false, reason: "quota_exhausted" };
  }
  return { allowed: true, row };
}

/**
 * Atomically add `tokens` to a key's consumed counter. Uses a direct SQL
 * increment (api_keys.tokens_used = tokens_used + N) so concurrent requests
 * can't lose updates through a read-modify-write race.
 */
export async function recordKeyTokens(apiKeyId: number | null | undefined, tokens: number): Promise<void> {
  if (!apiKeyId || !Number.isFinite(tokens) || tokens <= 0) return;
  try {
    await db.run(
      sql`UPDATE api_keys SET tokens_used = COALESCE(tokens_used, 0) + ${Math.round(tokens)} WHERE id = ${apiKeyId}`,
    );
  } catch (err) {
    console.error("[FriendKeys] Failed to debit tokens for key", apiKeyId, err);
  }
}
