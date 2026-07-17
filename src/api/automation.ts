/**
 * Automation API — exposes the bulk-import job framework (F5).
 *
 * TS port of the reference proxy's `/api/oauth/[provider]/bulk-import/*` routes:
 *   POST   /api/automation/jobs                          — start a bulk-import job
 *   GET    /api/automation/jobs                          — list all jobs
 *   GET    /api/automation/jobs/latest                   — most recent job (optionally by provider)
 *   GET    /api/automation/jobs/:jobId                   — get job state (+preview)
 *   DELETE /api/automation/jobs/:jobId                   — delete a terminal job file
 *   POST   /api/automation/jobs/:jobId/cancel            — cancel a running job
 *   POST   /api/automation/jobs/:jobId/manual/:itemId    — reveal a captcha/manual session
 *   POST   /api/automation/jobs/:jobId/manual/:itemId/resume — answer + complete
 *
 * Wires the previously-dead startBulkJob / openManualSession / resumeManualSession
 * / handleManual to an HTTP surface so the dashboard can drive bulk import.
 */
import { Hono } from "hono";
import {
  startBulkJob,
  getBulkJob,
  getLatestJob,
  listJobs,
  cancelBulkJob,
  openManualSession,
  resumeManualSession,
  sanitizeJob,
  deleteJob,
  isAutoConcurrencyValue,
  type BulkJob,
} from "../auth/automation/bulkImport";
import { SERVICES, toBulkImportAdapter, type ProviderService } from "../auth/automation/services";
import type { ProviderId } from "../auth/automation/constants";
import type { BrowserEngine } from "../auth/automation/engine";
import type { ImportCredential } from "../auth/automation/bulkImport";
import {
  startCodebuddyCnFarm,
  cancelCodebuddyCnFarm,
  getCodebuddyCnFarmJob,
  listCodebuddyCnFarmJobs,
  type CodebuddyCnFarmConfig,
} from "../auth/automation/codebuddyCnFarm";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

export const automationRouter = new Hono();

const CBC_SETTINGS_KEY = "codebuddy_cn_farm_config";

interface StartJobBody {
  provider?: string;
  credentials?: ImportCredential[];
  concurrency?: number | "auto";
  engine?: "chromium" | "camoufox";
  headless?: boolean;
  proxyUrl?: string;
}

/** Resolve a provider id to its service + adapter, or null. */
function resolveAdapter(provider: string): { service: ProviderService; providerId: ProviderId } | null {
  const service = SERVICES[provider as ProviderId];
  if (!service) return null;
  return { service, providerId: provider as ProviderId };
}

/** POST /api/automation/jobs — start a bulk-import job. */
automationRouter.post("/jobs", async (c) => {
  const body = await c.req.json<StartJobBody>().catch(() => ({} as StartJobBody));
  if (!body.provider) return c.json({ error: "provider required" }, 400);
  if (!Array.isArray(body.credentials) || body.credentials.length === 0) {
    return c.json({ error: "credentials must be a non-empty array" }, 400);
  }
  for (const cred of body.credentials) {
    if (!cred || typeof cred.email !== "string") {
      return c.json({ error: "each credential needs an email" }, 400);
    }
  }
  const resolved = resolveAdapter(body.provider);
  if (!resolved) return c.json({ error: `Unknown provider: ${body.provider}` }, 400);

  const concurrency = body.concurrency ?? "auto";
  if (concurrency !== "auto" && (typeof concurrency !== "number" || concurrency < 1 || concurrency > 8)) {
    return c.json({ error: "concurrency must be 1-8 or 'auto'" }, 400);
  }

  const adapter = toBulkImportAdapter(resolved.service);
  const job = await startBulkJob({
    provider: body.provider,
    credentials: body.credentials,
    adapter,
    concurrency,
    engine: body.engine,
    headless: body.headless ?? true,
    proxyUrl: body.proxyUrl,
  });
  return c.json({ job: sanitizeJob(job) }, 201);
});

/** GET /api/automation/jobs — list all jobs. */
automationRouter.get("/jobs", (c) => {
  const jobs = listJobs().map(sanitizeJob);
  return c.json({ jobs });
});

/** GET /api/automation/jobs/latest — most recent job, optionally by provider. */
automationRouter.get("/jobs/latest", (c) => {
  const provider = c.req.query("provider");
  const job = getLatestJob(provider);
  if (!job) return c.json({ job: null });
  return c.json({ job: sanitizeJob(job) });
});

/** GET /api/automation/jobs/:jobId — get a job's current state (+ preview). */
automationRouter.get("/jobs/:jobId", (c) => {
  const job = getBulkJob(c.req.param("jobId"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ job: sanitizeJob(job) });
});

/** DELETE /api/automation/jobs/:jobId — delete a terminal job's persisted file. */
automationRouter.delete("/jobs/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = getBulkJob(jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status === "running" || job.status === "paused") {
    return c.json({ error: "Cannot delete a running job; cancel it first" }, 409);
  }
  deleteJob(jobId);
  return c.json({ success: true });
});

/** POST /api/automation/jobs/:jobId/cancel — cancel a running job. */
automationRouter.post("/jobs/:jobId/cancel", (c) => {
  const ok = cancelBulkJob(c.req.param("jobId"));
  if (!ok) return c.json({ error: "No active job with that id" }, 404);
  return c.json({ success: true });
});

/** POST /api/automation/jobs/:jobId/manual/:itemId — reveal a captcha/manual session. */
automationRouter.post("/jobs/:jobId/manual/:itemId", async (c) => {
  const result = await openManualSession(c.req.param("jobId"), c.req.param("itemId"));
  if (!result) return c.json({ error: "No manual session for that item" }, 404);
  return c.json(result);
});

/** POST /api/automation/jobs/:jobId/manual/:itemId/resume — answer a captcha + complete. */
automationRouter.post("/jobs/:jobId/manual/:itemId/resume", async (c) => {
  const body = await c.req.json<{ answer: string }>().catch(() => ({ answer: "" }));
  if (!body.answer) return c.json({ error: "answer required" }, 400);
  const result = await resumeManualSession(c.req.param("jobId"), c.req.param("itemId"), body.answer);
  if (!result.resolved) return c.json({ error: result.error || "Could not resume" }, 400);
  return c.json({ success: true });
});

// ── CodeBuddy CN phone farm (5sim → ck_* → codebuddy-china pool) ───────────

async function loadCbcConfig(): Promise<Partial<CodebuddyCnFarmConfig>> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, CBC_SETTINGS_KEY)).limit(1);
    if (!row?.value) return {};
    return JSON.parse(row.value) as Partial<CodebuddyCnFarmConfig>;
  } catch {
    return {};
  }
}

async function saveCbcConfig(cfg: Partial<CodebuddyCnFarmConfig>): Promise<void> {
  const value = JSON.stringify(cfg);
  const [existing] = await db.select().from(settings).where(eq(settings.key, CBC_SETTINGS_KEY)).limit(1);
  if (existing) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, CBC_SETTINGS_KEY));
  } else {
    await db.insert(settings).values({ key: CBC_SETTINGS_KEY, value });
  }
}

/** GET /api/automation/codebuddy-cn/config */
automationRouter.get("/codebuddy-cn/config", async (c) => {
  const cfg = await loadCbcConfig();
  return c.json({
    config: {
      fiveSimToken: cfg.fiveSimToken ? "••••••••" : "",
      count: cfg.count ?? 3,
      concurrent: cfg.concurrent ?? 1,
      country: cfg.country || "hongkong",
      headless: cfg.headless !== false,
      product: cfg.product || "codebuddy",
    },
  });
});

/** PUT /api/automation/codebuddy-cn/config */
automationRouter.put("/codebuddy-cn/config", async (c) => {
  const body = await c.req.json<Partial<CodebuddyCnFarmConfig>>().catch((): Partial<CodebuddyCnFarmConfig> => ({}));
  const cur = await loadCbcConfig();
  const next = {
    ...cur,
    ...body,
    fiveSimToken:
      body.fiveSimToken && body.fiveSimToken !== "••••••••"
        ? body.fiveSimToken
        : cur.fiveSimToken,
  };
  await saveCbcConfig(next);
  return c.json({
    config: {
      ...next,
      fiveSimToken: next.fiveSimToken ? "••••••••" : "",
    },
  });
});

/** GET /api/automation/codebuddy-cn/jobs/latest */
automationRouter.get("/codebuddy-cn/jobs/latest", (c) => {
  return c.json({ job: getCodebuddyCnFarmJob() });
});

/** GET /api/automation/codebuddy-cn/jobs */
automationRouter.get("/codebuddy-cn/jobs", (c) => {
  return c.json({ jobs: listCodebuddyCnFarmJobs() });
});

/** POST /api/automation/codebuddy-cn/start */
automationRouter.post("/codebuddy-cn/start", async (c) => {
  const body = await c.req.json<Partial<CodebuddyCnFarmConfig> & { saveConfig?: boolean }>().catch((): Partial<CodebuddyCnFarmConfig> & { saveConfig?: boolean } => ({}));
  const saved = await loadCbcConfig();
  const fiveSimToken =
    body.fiveSimToken && body.fiveSimToken !== "••••••••"
      ? body.fiveSimToken
      : saved.fiveSimToken || process.env.FIVE_SIM_TOKEN || "";
  const cfg: CodebuddyCnFarmConfig = {
    fiveSimToken,
    count: Math.max(1, Math.min(50, Number(body.count ?? saved.count) || 3)),
    concurrent: Math.max(1, Math.min(5, Number(body.concurrent ?? saved.concurrent) || 1)),
    country: String(body.country || saved.country || "hongkong"),
    headless: body.headless !== false,
    product: String(body.product || saved.product || "codebuddy"),
  };
  if (body.saveConfig !== false) {
    await saveCbcConfig({
      ...cfg,
      fiveSimToken: cfg.fiveSimToken,
    });
  }
  try {
    const job = await startCodebuddyCnFarm(cfg);
    return c.json({ job }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** POST /api/automation/codebuddy-cn/cancel */
automationRouter.post("/codebuddy-cn/cancel", (c) => {
  const ok = cancelCodebuddyCnFarm();
  if (!ok) return c.json({ error: "No running CodeBuddy CN farm job" }, 404);
  return c.json({ success: true });
});
