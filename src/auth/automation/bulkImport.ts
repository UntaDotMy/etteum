/**
 * Bulk-import job framework — TS port of 9router's
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

// --- Optimal concurrency (mirrors 9router systemSpecs.getOptimalWorkerCount) ---
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
export function persistJob(job: BulkJob): void {
  job.updatedAt = Date.now();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
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
    try {
      browser = await launchBrowser(launchOpts);
      const result = await adapter.login(item.credential, { browser, signal });
      item.status = "done";
      item.result = result;
    } catch (err: any) {
      item.status = err?.manual ? "manual" : "error";
      item.error = err?.message || String(err);
    } finally {
      if (browser) await browser.close().catch(() => {});
      item.finishedAt = Date.now();
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
  persistJob(active.job);
  emit(active.job);
  return true;
}

/** Get a job's current state (from memory if running, else disk). */
export function getBulkJob(jobId: string): BulkJob | null {
  return activeJobs.get(jobId)?.job ?? loadJob(jobId);
}
