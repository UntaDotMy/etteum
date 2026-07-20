/**
 * Friend share-board payload builder (side-effect-free for testability).
 *
 * The full secret is included ONLY when `includeFullKey` is set — i.e. the
 * single-key deep link (/v1/share?key=…) where the caller already presented
 * the secret. The authless multi-key board (/v1/share/board) must never emit
 * full keys: anyone who can reach SHARE_PORT could harvest every friend key
 * and spend pool quota with them.
 */

import type { apiKeys } from "../db/schema";
import { parseAllowedModels, modelAllowed } from "./friend-keys";

export type ShareKeyRow = typeof apiKeys.$inferSelect;

export interface ShareKeySpeed {
  ttftMs: number | null;
  tokensPerSecond: number | null;
  sampleSize: number;
}

export interface ShareKeyPublicPayload {
  id: number;
  name: string | null;
  key?: string;
  keyPreview: string;
  status: string;
  isActive: boolean;
  createdAt: Date | null;
  lastUsedAt: Date | null;
  tokenQuota: number | null;
  tokensUsed: number;
  tokensLeft: number | null;
  rateLimit: number | null;
  expiresAt: Date | null;
  models: string[];
  baseUrl: string;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  sampleSize: number;
}

export function shareKeyPublic(
  row: ShareKeyRow,
  activeModelIds: string[],
  speed?: ShareKeySpeed,
  opts?: { includeFullKey?: boolean },
): ShareKeyPublicPayload {
  const allowlist = parseAllowedModels(row.allowedModels);
  const usable = activeModelIds.filter((id) => modelAllowed(allowlist, id));
  const tokenQuota = row.tokenQuota ?? null;
  const tokensUsed = row.tokensUsed ?? 0;
  const tokensLeft = tokenQuota != null ? Math.max(0, tokenQuota - tokensUsed) : null;
  const status = !row.isActive
    ? "inactive"
    : (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      ? "expired"
      : (tokenQuota != null && tokensLeft === 0)
        ? "exhausted"
        : "active";
  return {
    id: row.id,
    name: row.name || null,
    ...(opts?.includeFullKey ? { key: row.key } : {}),
    keyPreview: row.key.slice(0, 12) + "…",
    status,
    isActive: row.isActive,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    tokenQuota,
    tokensUsed,
    tokensLeft,
    rateLimit: row.rateLimit ?? null,
    expiresAt: row.expiresAt,
    models: usable,
    baseUrl: "/v1",
    ttftMs: speed?.ttftMs ?? null,
    tokensPerSecond: speed?.tokensPerSecond ?? null,
    sampleSize: speed?.sampleSize ?? 0,
  };
}
