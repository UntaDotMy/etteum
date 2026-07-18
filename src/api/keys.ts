import { Hono } from "hono";
import { db } from "../db/index";
import { settings, apiKeys } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { constantTimeEqual, RateLimiter } from "../utils/security";

const API_KEY_SETTING = "api_key";
const API_KEY_CACHE_TTL_MS = 5_000;
const MIN_KEY_LENGTH = 16;
/** Negative-cache TTL for unknown/revoked keys — kept short so a newly-added
 *  key or re-activated key is honored quickly even if it was just missed. */
const RESOLVE_MISS_TTL_MS = 2_000;
const RESOLVE_CACHE_MAX = 512;

let activeApiKeyCache: { key: string; expiresAt: number } | null = null;

// Per-request hot path: resolveApiKey ran a SQLite SELECT on EVERY /v1 call.
// Cache the multi-key row lookup (hit and miss) keyed by the raw token, with a
// short TTL and explicit invalidation on any managed-key mutation below.
type ResolvedKey =
  | { row: { id: number; isActive: boolean; machineId: string | null } }
  | { row: null };
const resolveKeyCache = new Map<string, { value: ResolvedKey; expiresAt: number }>();

function cacheResolvedKey(token: string, value: ResolvedKey, ttlMs: number) {
  if (resolveKeyCache.size >= RESOLVE_CACHE_MAX) resolveKeyCache.clear();
  resolveKeyCache.set(token, { value, expiresAt: Date.now() + ttlMs });
}

/** Drop cached multi-key resolutions. Called on create/revoke/activate/delete. */
export function invalidateResolvedApiKeys(): void {
  resolveKeyCache.clear();
}

export const keysRouter = new Hono();

// Rate-limit the brute-force-prone /test endpoint: 10 checks/min per IP.
const testLimiter = new RateLimiter(10, 10);

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk-pool-${token}`;
}

export async function getActiveApiKey(): Promise<string> {
  const now = Date.now();
  if (activeApiKeyCache && activeApiKeyCache.expiresAt > now) {
    return activeApiKeyCache.key;
  }

  const [row] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  // Only fall back to the env key if it is actually set; never to an empty
  // string (which would effectively disable auth).
  const key = row?.value || config.apiKey || "";
  activeApiKeyCache = { key, expiresAt: now + API_KEY_CACHE_TTL_MS };
  return key;
}

/**
 * Validate an API key against ALL active sources :
 *   1. The legacy single global key (settings.api_key / env) — preserved.
 *   2. Any active row in the api_keys table (named, machine-bound, revocable).
 * Returns the api_keys row id if matched (for per-key attribution), else null.
 */
/**
 * Resolve a presented API key against all active sources.
 * When a managed key has machineId set, the request must present a matching
 * machine identity via x-machine-id / x-etteum-machine-id / ?machine_id=.
 */
export async function resolveApiKey(
  token: string,
  opts?: { machineId?: string | null },
): Promise<{ valid: boolean; apiKeyId?: number; reason?: string }> {
  if (!token) return { valid: false };
  // 1. Legacy single-key (env or settings) — not machine-bound.
  if (config.apiKey && constantTimeEqual(token, config.apiKey)) return { valid: true };
  const active = await getActiveApiKey();
  if (active && constantTimeEqual(token, active)) return { valid: true };
  // 2. Multi-key table — cached (hit 5s / miss 2s), invalidated on mutation.
  let resolved = resolveKeyCache.get(token);
  if (!resolved || resolved.expiresAt <= Date.now()) {
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.key, token)).limit(1);
    const value: ResolvedKey = row
      ? { row: { id: row.id, isActive: row.isActive, machineId: row.machineId } }
      : { row: null };
    cacheResolvedKey(token, value, row ? API_KEY_CACHE_TTL_MS : RESOLVE_MISS_TTL_MS);
    resolved = resolveKeyCache.get(token)!;
  }
  const row = resolved.value.row;
  if (!row || !row.isActive) return { valid: false };
  // Enforce machine binding when configured on the key.
  if (row.machineId && row.machineId.trim()) {
    const presented = (opts?.machineId || "").trim();
    if (!presented || !constantTimeEqual(presented, row.machineId.trim())) {
      return { valid: false, reason: "machine_mismatch" };
    }
  }
  return { valid: true, apiKeyId: row.id };
}

/** Extract optional machine id from headers / query for machine-bound keys. */
export function extractMachineId(
  headers: Headers,
  query?: URLSearchParams | null,
): string {
  const h =
    headers.get("x-machine-id") ||
    headers.get("x-etteum-machine-id") ||
    headers.get("x-9r-machine-id");
  if (h) return h.trim();
  if (query) {
    const q = query.get("machine_id") || query.get("machineId");
    if (q) return q.trim();
  }
  return "";
}

export async function isValidApiKey(
  token: string,
  opts?: { machineId?: string | null },
): Promise<boolean> {
  return (await resolveApiKey(token, opts)).valid;
}

async function saveApiKey(key: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value: key, updatedAt: new Date() }).where(eq(settings.key, API_KEY_SETTING));
  } else {
    await db.insert(settings).values({ key: API_KEY_SETTING, value: key });
  }
  activeApiKeyCache = { key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS };
}

keysRouter.get("/", async (c) => {
  const key = await getActiveApiKey();
  return c.json({ key, source: key === config.apiKey ? "env" : "database" });
});

keysRouter.post("/regenerate", async (c) => {
  const key = generateApiKey();
  await saveApiKey(key);
  return c.json({ key, source: "database" });
});

keysRouter.post("/set", async (c) => {
  const body = await c.req.json<{ key: string }>();
  if (!body.key || body.key.length < MIN_KEY_LENGTH) {
    return c.json({ error: `API key must be at least ${MIN_KEY_LENGTH} characters` }, 400);
  }
  await saveApiKey(body.key);
  return c.json({ key: body.key, source: "database" });
});

/**
 * Validate an API key. Rate-limited per IP to prevent brute-forcing.
 *
 * NOTE: This endpoint is reached WITHOUT the global auth middleware (it is the
 * key-validation oracle itself), so it must self-rate-limit.
 */
keysRouter.post("/test", async (c) => {
  const ip = getClientIp(c);
  const rl = testLimiter.check(ip);
  if (!rl.allowed) {
    return c.json(
      { error: "Too many attempts. Try again later.", retryAfterMs: rl.retryAfterMs },
      429,
    );
  }
  const body = await c.req.json<{ key: string }>();
  const valid = await isValidApiKey(body.key || "");
  return c.json({ valid });
});

// 

/** List all managed API keys (never returns the key string — only a masked prefix). */
keysRouter.get("/managed", async (c) => {
  const rows = await db.select().from(apiKeys).orderBy(apiKeys.id);
  return c.json({
    keys: rows.map((k) => ({
      id: k.id,
      keyPreview: k.key.slice(0, 12) + "…",
      name: k.name,
      machineId: k.machineId,
      isActive: k.isActive,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    })),
  });
});

/** Create a new managed key. Returns the full key ONCE (not retrievable later). */
keysRouter.post("/managed", async (c) => {
  const body = await c.req.json<{ name?: string; machineId?: string }>().catch(() => ({ name: undefined, machineId: undefined }));
  const key = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      key,
      name: body.name || null,
      machineId: body.machineId || null,
      isActive: true,
    })
    .returning();
  invalidateResolvedApiKeys();
  return c.json({ id: row!.id, key, name: row!.name, machineId: row!.machineId });
});

/** Revoke (deactivate) a managed key by id. The key string stays unique but is
 *  no longer accepted by resolveApiKey. */
keysRouter.post("/managed/:id/revoke", async (c) => {
  const id = Number(c.req.param("id"));
  await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, id));
  invalidateResolvedApiKeys();
  return c.json({ success: true });
});

/** Reactivate a previously revoked managed key. */
keysRouter.post("/managed/:id/activate", async (c) => {
  const id = Number(c.req.param("id"));
  await db.update(apiKeys).set({ isActive: true }).where(eq(apiKeys.id, id));
  invalidateResolvedApiKeys();
  return c.json({ success: true });
});

/** Delete a managed key permanently. */
keysRouter.delete("/managed/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
  invalidateResolvedApiKeys();
  return c.json({ success: true });
});

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}