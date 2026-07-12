/**
 * Grok farm automation API — config + job control for scripts/auth/grok-farm.
 */
import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  startGrokFarm,
  cancelGrokFarm,
  getGrokFarmJob,
  listGrokFarmJobs,
  validateGrokFarmSetup,
  type GrokFarmConfig,
  type GrokMailMode,
} from "../auth/automation/grokFarm";

export const grokFarmRouter = new Hono();

const SETTINGS_KEY = "grok_farm_config";

const DEFAULT_CONFIG: GrokFarmConfig = {
  mailMode: "tempmail",
  imapHost: "imap.gmail.com",
  imapPort: 993,
  emailMode: "domain",
  accountPassword: "",
  maxAccounts: 5,
  concurrent: 1,
  headless: false,
  activateWeb: true,
};

async function loadConfig(): Promise<GrokFarmConfig> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    if (!row?.value) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(row.value) as Partial<GrokFarmConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(cfg: GrokFarmConfig): Promise<void> {
  const value = JSON.stringify(cfg);
  const [existing] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  if (existing) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, SETTINGS_KEY));
  } else {
    await db.insert(settings).values({ key: SETTINGS_KEY, value });
  }
}

function sanitizeConfig(cfg: GrokFarmConfig): GrokFarmConfig {
  return {
    ...cfg,
    imapPass: cfg.imapPass ? "••••••••" : "",
    captchaApiKey: cfg.captchaApiKey ? "••••••••" : "",
  };
}

/** GET /api/grok-farm/setup — python + script readiness */
grokFarmRouter.get("/setup", (c) => c.json(validateGrokFarmSetup()));

/** GET /api/grok-farm/config */
grokFarmRouter.get("/config", async (c) => {
  const cfg = await loadConfig();
  return c.json({ config: sanitizeConfig(cfg) });
});

/** PUT /api/grok-farm/config */
grokFarmRouter.put("/config", async (c) => {
  const body = await c.req.json<Partial<GrokFarmConfig>>().catch(() => ({}));
  const current = await loadConfig();
  const next: GrokFarmConfig = {
    ...current,
    ...body,
    mailMode: (body.mailMode === "google" || body.mailMode === "tempmail"
      ? body.mailMode
      : current.mailMode) as GrokMailMode,
    // Keep secrets if client sent masked placeholder
    imapPass:
      body.imapPass && body.imapPass !== "••••••••" ? body.imapPass : current.imapPass,
    captchaApiKey:
      body.captchaApiKey && body.captchaApiKey !== "••••••••"
        ? body.captchaApiKey
        : current.captchaApiKey,
    maxAccounts: Math.max(1, Math.min(100, Number(body.maxAccounts ?? current.maxAccounts) || 5)),
    concurrent: Math.max(1, Math.min(8, Number(body.concurrent ?? current.concurrent) || 1)),
    headless: body.headless ?? current.headless,
    activateWeb: body.activateWeb ?? current.activateWeb,
    accountPassword: (body.accountPassword ?? current.accountPassword) || "",
  };
  await saveConfig(next);
  return c.json({ config: sanitizeConfig(next) });
});

/** GET /api/grok-farm/jobs */
grokFarmRouter.get("/jobs", (c) => c.json({ jobs: listGrokFarmJobs() }));

/** GET /api/grok-farm/jobs/latest */
grokFarmRouter.get("/jobs/latest", (c) => c.json({ job: getGrokFarmJob() }));

/** POST /api/grok-farm/start */
grokFarmRouter.post("/start", async (c) => {
  const body = await c.req.json<Partial<GrokFarmConfig> & { saveConfig?: boolean }>().catch(() => ({}));
  const saved = await loadConfig();
  const cfg: GrokFarmConfig = {
    ...saved,
    ...body,
    mailMode: (body.mailMode === "google" || body.mailMode === "tempmail"
      ? body.mailMode
      : saved.mailMode) as GrokMailMode,
    imapPass:
      body.imapPass && body.imapPass !== "••••••••" ? body.imapPass : saved.imapPass,
    captchaApiKey:
      body.captchaApiKey && body.captchaApiKey !== "••••••••"
        ? body.captchaApiKey
        : saved.captchaApiKey,
    maxAccounts: Math.max(1, Math.min(100, Number(body.maxAccounts ?? saved.maxAccounts) || 5)),
    concurrent: Math.max(1, Math.min(8, Number(body.concurrent ?? saved.concurrent) || 1)),
    accountPassword: (body.accountPassword ?? saved.accountPassword) || "",
  };

  if (body.saveConfig !== false) {
    await saveConfig(cfg);
  }

  try {
    const job = await startGrokFarm(cfg);
    return c.json({ job }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** POST /api/grok-farm/cancel */
grokFarmRouter.post("/cancel", (c) => {
  const ok = cancelGrokFarm();
  if (!ok) return c.json({ error: "No running Grok farm job" }, 404);
  return c.json({ success: true });
});
