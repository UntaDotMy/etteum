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
  GROK_FARM_ENV_DEFAULTS,
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
  headless: true, // always headless in etteum
  activateWeb: true,
  // Align with scripts/auth/grok-farm/.env.example
  ...GROK_FARM_ENV_DEFAULTS,
};

function clampFarmConfig(partial: Partial<GrokFarmConfig>, base: GrokFarmConfig): GrokFarmConfig {
  const d = GROK_FARM_ENV_DEFAULTS;
  const n = (v: unknown, fb: number, min: number, max: number) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return fb;
    return Math.max(min, Math.min(max, x));
  };
  const b = (v: unknown, fb: boolean) =>
    typeof v === "boolean" ? v : v === undefined ? fb : Boolean(v);

  return {
    ...base,
    ...partial,
    mailMode: (partial.mailMode === "google" || partial.mailMode === "tempmail"
      ? partial.mailMode
      : base.mailMode) as GrokMailMode,
    maxAccounts: n(partial.maxAccounts ?? base.maxAccounts, 5, 1, 100),
    concurrent: n(partial.concurrent ?? base.concurrent, 1, 1, 8),
    headless: true,
    activateWeb: partial.activateWeb ?? base.activateWeb,
    accountPassword: (partial.accountPassword ?? base.accountPassword) || "",
    workerIsolation: b(partial.workerIsolation ?? base.workerIsolation, d.workerIsolation),
    spawnDelay: n(partial.spawnDelay ?? base.spawnDelay, d.spawnDelay, 0, 600),
    autoStagger: b(partial.autoStagger ?? base.autoStagger, d.autoStagger),
    autoSpawnDelay: n(partial.autoSpawnDelay ?? base.autoSpawnDelay, d.autoSpawnDelay, 0, 600),
    launchParallel: n(partial.launchParallel ?? base.launchParallel, d.launchParallel, 1, 16),
    tempmailBlockImages: b(
      partial.tempmailBlockImages ?? base.tempmailBlockImages,
      d.tempmailBlockImages,
    ),
    turnstileParallel: n(
      partial.turnstileParallel ?? base.turnstileParallel,
      d.turnstileParallel,
      1,
      256,
    ),
    uiRetries: n(partial.uiRetries ?? base.uiRetries, d.uiRetries, 0, 20),
    uiRetryBackoff: n(partial.uiRetryBackoff ?? base.uiRetryBackoff, d.uiRetryBackoff, 0, 60),
    probeRetries: n(partial.probeRetries ?? base.probeRetries, d.probeRetries, 0, 20),
    probeRetryBackoff: n(
      partial.probeRetryBackoff ?? base.probeRetryBackoff,
      d.probeRetryBackoff,
      0,
      60,
    ),
    otpTimeout:
      partial.otpTimeout != null || base.otpTimeout != null
        ? n(partial.otpTimeout ?? base.otpTimeout, 120, 10, 3600)
        : undefined,
    confirmTimeout:
      partial.confirmTimeout != null || base.confirmTimeout != null
        ? n(partial.confirmTimeout ?? base.confirmTimeout, 45, 5, 600)
        : undefined,
    completeTimeout:
      partial.completeTimeout != null || base.completeTimeout != null
        ? n(partial.completeTimeout ?? base.completeTimeout, 90, 10, 600)
        : undefined,
    accountTimeout:
      partial.accountTimeout != null || base.accountTimeout != null
        ? n(partial.accountTimeout ?? base.accountTimeout, 480, 60, 7200)
        : undefined,
    proxyPool: partial.proxyPool ?? base.proxyPool,
    proxyShuffle: partial.proxyShuffle ?? base.proxyShuffle,
    emailLocalLen:
      partial.emailLocalLen != null || base.emailLocalLen != null
        ? n(partial.emailLocalLen ?? base.emailLocalLen, 16, 6, 48)
        : undefined,
    captchaModel: partial.captchaModel ?? base.captchaModel,
  };
}

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
  const next = clampFarmConfig(
    {
      ...body,
      // Keep secrets if client sent masked placeholder
      imapPass:
        body.imapPass && body.imapPass !== "••••••••" ? body.imapPass : current.imapPass,
      captchaApiKey:
        body.captchaApiKey && body.captchaApiKey !== "••••••••"
          ? body.captchaApiKey
          : current.captchaApiKey,
    },
    current,
  );
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
  const cfg = clampFarmConfig(
    {
      ...body,
      imapPass:
        body.imapPass && body.imapPass !== "••••••••" ? body.imapPass : saved.imapPass,
      captchaApiKey:
        body.captchaApiKey && body.captchaApiKey !== "••••••••"
          ? body.captchaApiKey
          : saved.captchaApiKey,
    },
    saved,
  );

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
