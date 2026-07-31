/**
 * Friend share-board payload builder (side-effect-free for testability).
 *
 * The authless multi-key board always receives a preview-only payload. The
 * separate `shareKeyPresented` helper may echo a key only after the caller has
 * already presented that exact credential.
 */

import type { apiKeys } from "../db/schema";
import { parseAllowedModels, modelAllowed } from "./friend-keys";

/**
 * SHARE_LOCK=1 → the friend page is link-only, so the all-keys board is closed.
 *
 * Read per call (not captured at import) so restarts and tests pick it up.
 * Lives in this side-effect-free module rather than proxy/index.ts: importing
 * the proxy router just to read a flag drags its boot-time timers and the whole
 * provider graph into light callers, which broke module init under the suite.
 */
export function isShareLocked(): boolean {
  return process.env.SHARE_LOCK === "1";
}

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

export function shareKeyPresented(
  row: ShareKeyRow,
  activeModelIds: string[],
  speed?: ShareKeySpeed,
): ShareKeyPublicPayload & { key: string } {
  return { ...shareKeyPublic(row, activeModelIds, speed), key: row.key };
}
