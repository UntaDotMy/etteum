import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { constantTimeEqual, RateLimiter } from "../utils/security";

const API_KEY_SETTING = "api_key";
const API_KEY_CACHE_TTL_MS = 5_000;
const MIN_KEY_LENGTH = 16;

let activeApiKeyCache: { key: string; expiresAt: number } | null = null;

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

export async function isValidApiKey(token: string): Promise<boolean> {
  if (!token) return false;
  // Constant-time compare against both the env default and the DB-stored key.
  if (config.apiKey && constantTimeEqual(token, config.apiKey)) return true;
  const active = await getActiveApiKey();
  if (!active) return false;
  return constantTimeEqual(token, active);
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

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}