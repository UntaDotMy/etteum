/**
 * Automation API — exposes the bulk-import job framework (F5).
 *
 * TS port of 9router's `/api/oauth/[provider]/bulk-import/*` routes:
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

export const automationRouter = new Hono();

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
