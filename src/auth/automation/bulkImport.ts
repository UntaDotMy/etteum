/**
 * Bulk-import job framework — TS port of the reference proxy's
 * src/lib/oauth/services/kiroBulkImportManager.js, 1:1 architecture.
 *
 * A durable job manager that imports N accounts using M concurrent browser
 * workers. Each worker pulls the next credential from a shared queue, launches
 * a (Camoufox) browser, runs the provider's login automation, and persists the
 * resulting tokens. Supports:
 *   - configurable concurrency (or auto = CPU-based optimal)
 *   - per-job persistence to disk (resume after restart)
 *   - cancel + manual-followup-resume (captcha round-trip)
 *   - preview capture (screenshot on completion)
 *   - live progress broadcast over WebSocket
 *
 * Provider services plug in via a BulkImportAdapter.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { broadcast } from "../../ws/index";
import { config } from "../../config";
import { launchBrowser, type BrowserEngine, type LaunchBrowserOptions } from "./engine";

export type JobStatus = "pending" | "running" | "paused" | "done" | "cancelled" | "failed";
export type ItemStatus = "queued" | "running" | "done" | "error" | "manual" | "skipped";

export interface ImportCredential {
  email: string;
  password?: string;
  [key: string]: unknown;
}

export interface ImportItem {
  id: string;
  credential: ImportCredential;
  status: ItemStatus;
  error?: string;
  result?: { tokens?: unknown; email?: string; quota?: unknown };
  previewPath?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface BulkJob {
  id: string;
  provider: string;
  status: JobStatus;
  items: ImportItem[];
  concurrency: number;
  engine: BrowserEngine;
  headless: boolean;
  proxyUrl?: string;
  createdAt: number;
  updatedAt: number;
  summary?: JobSummary;
  /** Base64 JPEG screenshot of the most-recently-active worker's page (rate-limited). Mirrors reference `job.lastPreview`. */
  lastPreview?: string;
  previewUpdatedAt?: number;
}

export interface JobSummary {
  total: number;
  done: number;
  error: number;
  manual: number;
  skipped: number;
}

/** Adapter a provider service implements to drive a single account import. */
export interface BulkImportAdapter {
  provider: string;
  /** Run login for one credential. Returns tokens/result or throws. */
  login(credential: ImportCredential, ctx: { browser: import("playwright").Browser; signal: AbortSignal }): Promise<{ tokens?: unknown; email?: string; quota?: unknown }>;
  /** Optional: handle a manual (captcha) challenge round-trip. */
  handleManual?: (item: ImportItem, answer: string) => Promise<void>;
}

// --- Optimal concurrency (mirrors the reference proxy systemSpecs.getOptimalWorkerCount) ---
export function isAutoConcurrencyValue(value: unknown): boolean {
  return value === "auto" || value === "Auto";
}
export function getOptimalWorkerCount(): number {
  const cpus = (typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency) || 4;
  // 1 worker per 2 cores, min 1, max 8 — keeps browser RAM in check.
  return Math.min(8, Math.max(1, Math.floor(cpus / 2)));
}

// --- Persistence ---
function jobsDir(): string {
  const base = config.databasePath ? path.dirname(config.databasePath) : "./data";
  const dir = path.join(base, "bulk-import-jobs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
function jobPath(jobId: string): string {
  return path.join(jobsDir(), `${jobId}.json`);
}
/**
 * Atomically persist a job to disk (temp file + rename) so a crash mid-write
 * never leaves a corrupt/truncated job file. Mirrors reference
 * kiroBulkImportManager.js writeJsonFile (temp + renameSync).
 */
export function persistJob(job: BulkJob): void {
  job.updatedAt = Date.now();
  const target = jobPath(job.id);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, target);
}
export function loadJob(jobId: string): BulkJob | null {
  try {
    return JSON.parse(readFileSync(jobPath(jobId), "utf8")) as BulkJob;
  } catch {
    return null;
  }
}
export function listJobs(): BulkJob[] {
  const dir = jobsDir();
  try {
    if (!existsSync(dir)) return [];
    const { readdirSync } = require("node:fs");
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => loadJob(f.replace(/\.json$/, "")))
      .filter(Boolean) as BulkJob[];
  } catch {
    return [];
  }
}
export function deleteJob(jobId: string): void {
  try { rmSync(jobPath(jobId)); } catch { /* noop */ }
}

// --- Active job registry (in-memory) ---
const activeJobs = new Map<string, { job: BulkJob; abort: AbortController; adapter: BulkImportAdapter }>();

// --- Manual-session registry (in-memory) ---
// When a login throws with `manual: true` (captcha/2FA), the worker keeps the
// browser+page alive and registers it here so `openManualSession` can reveal it
// to a human and `resumeManualSession` can drive the adapter's handleManual.
// Mirrors reference `account.manualSession` + `runManualFollowup`.
interface ManualSession {
  browser: import("playwright").Browser;
  context?: import("playwright").BrowserContext;
  page?: import("playwright").Page;
  opened: boolean;
  openedAt: number | null;
}
const manualSessions = new Map<string, ManualSession>(); // key = `${jobId}:${itemId}`

function manualKey(jobId: string, itemId: string): string {
  return `${jobId}:${itemId}`;
}

/** Preview-capture rate limit (ms). Mirrors reference PREVIEW_CAPTURE_INTERVAL_MS. */
const PREVIEW_CAPTURE_INTERVAL_MS = 1500;

/**
 * Capture a base64 JPEG screenshot of the currently-running item's page, if any.
 * Rate-limited per job. Failures are swallowed (preview is best-effort). Mirrors
 * reference kiroBulkImportManager.capturePreview.
 */
async function capturePreview(job: BulkJob, force = false): Promise<void> {
  if (!force && job.previewUpdatedAt && Date.now() - job.previewUpdatedAt < PREVIEW_CAPTURE_INTERVAL_MS) {
    return;
  }
  // Prefer the running item's page; fall back to a manual-awaiting page.
  const running = job.items.find((it) => it.status === "running");
  const target = running ?? job.items.find((it) => it.status === "manual");
  if (!target) return;
  const session = manualSessions.get(manualKey(job.id, target.id));
  const page = session?.page;
  if (!page) return;
  try {
    const buf = await Promise.race([
      page.screenshot({ type: "jpeg", quality: 55, timeout: 2500 } as any),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("preview timeout")), 2500)),
    ]);
    job.lastPreview = typeof buf === "string" ? buf : Buffer.from(buf as Uint8Array).toString("base64");
    job.previewUpdatedAt = Date.now();
  } catch {
    // best-effort — swallow
  }
}

/**
 * Reveal a manual-awaiting item's browser window to a human (captcha/2FA).
 * Returns the page so the caller (API route) can optionally drive it. The
 * browser stays alive until `resumeManualSession` or job completion closes it.
 */
export async function openManualSession(jobId: string, itemId: string): Promise<{ opened: boolean } | null> {
  const session = manualSessions.get(manualKey(jobId, itemId));
  if (!session) return null;
  session.opened = true;
  session.openedAt = Date.now();
  // Bring the page to the foreground. For headless launches we can't un-hide,
  // but we surface the preview so the operator can see + the API can relay
  // input. (A full headed relaunch is provider-specific; preview + handleManual
  // covers the captcha-answer round-trip.)
  try {
    await session.page?.bringToFront?.().catch(() => {});
  } catch { /* noop */ }
  return { opened: true };
}

/**
 * Drive a manual (captcha/2FA) item to completion using the adapter's
 * handleManual. Closes the browser afterwards. Mirrors reference
 * runManualFollowup resolving on the OAuth callback.
 */
export async function resumeManualSession(jobId: string, itemId: string, answer: string): Promise<{ resolved: boolean; error?: string }> {
  const active = activeJobs.get(jobId);
  const session = manualSessions.get(manualKey(jobId, itemId));
  if (!active || !session) return { resolved: false, error: "No active manual session for that item" };
  const item = active.job.items.find((it) => it.id === itemId);
  if (!item || item.status !== "manual") return { resolved: false, error: "Item is not awaiting manual input" };
  try {
    if (active.adapter.handleManual) {
      await active.adapter.handleManual(item, answer);
    }
    item.status = "done";
    item.error = undefined;
    item.finishedAt = Date.now();
    persistJob(active.job);
    emit(active.job);
    return { resolved: true };
  } catch (err: any) {
    item.status = "error";
    item.error = err?.message || String(err);
    item.finishedAt = Date.now();
    persistJob(active.job);
    emit(active.job);
    return { resolved: false, error: item.error };
  } finally {
    await session.browser.close().catch(() => {});
    manualSessions.delete(manualKey(jobId, itemId));
  }
}

/** Close any lingering manual session (e.g. on job cancel). */
async function closeManualSessions(jobId: string): Promise<void> {
  for (const [key, session] of manualSessions.entries()) {
    if (key.startsWith(`${jobId}:`)) {
      await session.browser.close().catch(() => {});
      manualSessions.delete(key);
    }
  }
}

function buildSummary(items: ImportItem[]): JobSummary {
  const s: JobSummary = { total: items.length, done: 0, error: 0, manual: 0, skipped: 0 };
  for (const it of items) {
    if (it.status === "done") s.done++;
    else if (it.status === "error") s.error++;
    else if (it.status === "manual") s.manual++;
    else if (it.status === "skipped") s.skipped++;
  }
  return s;
}

function emit(job: BulkJob): void {
  job.summary = buildSummary(job.items);
  broadcast({ type: "bulk_import_progress", data: sanitizeJob(job) });
}

/** Strip large/internal fields before broadcasting or returning to clients. */
export function sanitizeJob(job: BulkJob): BulkJob {
  return { ...job, items: job.items.map((it) => ({ ...it, credential: { email: it.credential.email } })) };
}

export function buildSummary_forItems(items: ImportItem[]): JobSummary {
  return buildSummary(items);
}

/** A job is terminal if it's done/cancelled/failed and not within a recent window. */
export function isRecentTerminalJob(job: BulkJob, windowMs = 60_000): boolean {
  if (job.status !== "done" && job.status !== "cancelled" && job.status !== "failed") return false;
  return Date.now() - (job.updatedAt || 0) < windowMs;
}

export function resolveFinishedJobStatus(job: BulkJob): JobStatus {
  const s = buildSummary(job.items);
  if (s.done === s.total) return "done";
  if (s.done > 0) return "done"; // partial success counts as done (reference behavior)
  if (s.error === s.total) return "failed";
  return job.status;
}

/**
 * Start a bulk-import job. Spawns `concurrency` workers, each pulling the next
 * queued item, launching a browser, and running the adapter's login.
 */
export async function startBulkJob(opts: {
  provider: string;
  credentials: ImportCredential[];
  adapter: BulkImportAdapter;
  concurrency?: number | "auto";
  engine?: BrowserEngine;
  headless?: boolean;
  proxyUrl?: string;
}): Promise<BulkJob> {
  const concurrency = isAutoConcurrencyValue(opts.concurrency) ? getOptimalWorkerCount() : (opts.concurrency as number) || getOptimalWorkerCount();
  const engine = opts.engine ?? "camoufox";
  const job: BulkJob = {
    id: randomUUID(),
    provider: opts.provider,
    status: "running",
    items: opts.credentials.map((c) => ({ id: randomUUID(), credential: c, status: "queued" as ItemStatus })),
    concurrency,
    engine,
    headless: opts.headless ?? true,
    proxyUrl: opts.proxyUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  persistJob(job);
  emit(job);

  const abort = new AbortController();
  activeJobs.set(job.id, { job, abort, adapter: opts.adapter });

  // Worker pool
  const queue = [...job.items];
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, job.items.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(runWorker(job, opts.adapter, queue, abort.signal, w));
  }
  void Promise.allSettled(workers).then(() => {
    job.status = abort.signal.aborted ? "cancelled" : resolveFinishedJobStatus(job);
    persistJob(job);
    emit(job);
    activeJobs.delete(job.id);
  });

  return job;
}

async function runWorker(job: BulkJob, adapter: BulkImportAdapter, queue: ImportItem[], signal: AbortSignal, workerIndex: number): Promise<void> {
  while (!signal.aborted) {
    const item = queue.shift();
    if (!item) return; // queue drained
    item.status = "running";
    item.startedAt = Date.now();
    emit(job);

    const launchOpts: LaunchBrowserOptions = {
      engine: job.engine,
      proxyUrl: job.proxyUrl,
      headless: job.headless,
      stealthSeed: workerIndex + 1,
    };
    let browser: import("playwright").Browser | null = null;
    let context: import("playwright").BrowserContext | null = null;
    let page: import("playwright").Page | null = null;
    try {
      browser = await launchBrowser(launchOpts);
      // Capture the active page/context so previews + manual takeover can use it.
      try {
        context = await browser.newContext?.().catch(() => null) ?? null;
        page = (context ? await context.newPage().catch(() => null) : null) ?? (await browser.newPage?.().catch(() => null)) ?? null;
      } catch { /* adapter may manage its own pages */ }
      const result = await adapter.login(item.credential, { browser, signal });
      item.status = "done";
      item.result = result;
    } catch (err: any) {
      item.status = err?.manual ? "manual" : "error";
      item.error = err?.message || String(err);
    } finally {
      // Keep the browser alive for manual (captcha) items so the operator can
      // take over via openManualSession/resumeManualSession. Close otherwise.
      if (item.status === "manual" && browser) {
        manualSessions.set(manualKey(job.id, item.id), {
          browser,
          context: context ?? undefined,
          page: page ?? undefined,
          opened: false,
          openedAt: null,
        });
        void capturePreview(job, true);
      } else if (browser) {
        await browser.close().catch(() => {});
      }
      item.finishedAt = item.status === "manual" ? undefined : Date.now();
      persistJob(job);
      emit(job);
    }
  }
}

/** Cancel a running job. */
export function cancelBulkJob(jobId: string): boolean {
  const active = activeJobs.get(jobId);
  if (!active) return false;
  active.abort.abort();
  active.job.status = "cancelled";
  // Close any lingering manual-session browsers for this job.
  void closeManualSessions(jobId);
  persistJob(active.job);
  emit(active.job);
  return true;
}

/** Get a job's current state (from memory if running, else disk). */
export function getBulkJob(jobId: string): BulkJob | null {
  const active = activeJobs.get(jobId)?.job;
  if (active) {
    // Refresh the preview opportunistically on read (best-effort).
    void capturePreview(active).then(() => emit(active)).catch(() => {});
    return active;
  }
  return loadJob(jobId);
}

/** Get the most recent job (by updatedAt) optionally filtered to a provider. */
export function getLatestJob(provider?: string): BulkJob | null {
  const jobs = listJobs();
  const filtered = provider ? jobs.filter((j) => j.provider === provider) : jobs;
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));
}

/**
 * Recover jobs left in a non-terminal state by a crash/restart. A crashed job
 * can't resume its in-flight browsers, so `running` items are marked `error`
 * and the job is moved to a terminal status. `manual`-awaiting items are also
 * marked `error` (their browsers are gone). Call once at boot.
 */
export function recoverJobsOnBoot(): void {
  try {
    for (const job of listJobs()) {
      if (job.status === "running" || job.status === "paused") {
        for (const item of job.items) {
          if (item.status === "running" || item.status === "manual") {
            item.status = "error";
            item.error = "Interrupted by server restart";
            item.finishedAt = Date.now();
          }
        }
        job.status = resolveFinishedJobStatus(job);
        persistJob(job);
      }
    }
  } catch (err) {
    console.error("[BulkImport] recoverJobsOnBoot failed:", err);
  }
}
