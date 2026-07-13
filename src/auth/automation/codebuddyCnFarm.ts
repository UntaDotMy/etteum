/**
 * CodeBuddy CN phone-farm — concurrent 5sim signup + API key mint → codebuddy-china pool.
 * Mirrors grokFarm job lifecycle: progress WS, browser sessions for Bot Logs frames.
 */
import { broadcast } from "../../ws/index";
import {
  registerSession,
  appendStep,
  updatePhase,
  updateFrame,
  getSession,
} from "../browserSession";
import { runCodeBuddyCnPhoneFlow } from "./codebuddy-cn-phone";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "../../utils/crypto";
import { pool, type ProviderName } from "../../proxy/pool";

export interface CodebuddyCnFarmConfig {
  fiveSimToken: string;
  count: number;
  concurrent: number;
  country: string;
  headless: boolean;
  product?: string;
}

export interface CodebuddyCnFarmJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  config: Omit<CodebuddyCnFarmConfig, "fiveSimToken"> & { fiveSimToken: string };
  imported: number;
  failed: number;
  errors: string[];
  lastMessage?: string;
  workerSessionIds: string[];
}

const jobs = new Map<string, CodebuddyCnFarmJob>();
let activeJobId: string | null = null;
const abortByJob = new Map<string, AbortController>();

function workerSessionId(jobId: string, n: number) {
  return `${jobId}-w${n}`;
}

function ensureWorker(job: CodebuddyCnFarmJob, n: number, email: string) {
  const sid = workerSessionId(job.id, n);
  if (!getSession(sid)) {
    registerSession({
      sessionId: sid,
      accountId: n,
      email,
      provider: "codebuddy-china",
      phase: "starting",
      lastMessage: "Starting CodeBuddy CN phone signup…",
      lastFrame: "",
      lastFrameFormat: "jpeg",
      lastFrameTime: 0,
      steps: [],
      challenge: null,
      terminal: false,
      proc: null,
      stdinWriter: null,
      cancelSignalFile: "",
      startedAt: Date.now(),
    });
    if (!job.workerSessionIds.includes(sid)) job.workerSessionIds.push(sid);
  }
  return sid;
}

function progress(job: CodebuddyCnFarmJob, sid: string, step: string, message: string) {
  job.lastMessage = message;
  appendStep(sid, step, message, "codebuddy-china");
  updatePhase(sid, step, message);
  broadcast({
    type: "login_progress",
    data: {
      provider: "codebuddy-china",
      step,
      message,
      jobId: job.id,
      sessionId: sid,
      email: getSession(sid)?.email || "CodeBuddy CN",
    },
  });
}

/** Upsert a ck_* key into the codebuddy-china provider pool. */
export async function upsertCodebuddyChinaApiKey(
  apiKey: string,
  label?: string,
): Promise<number> {
  const key = apiKey.trim();
  if (!key.startsWith("ck_")) throw new Error("CodeBuddy CN key must start with ck_");

  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.provider, "codebuddy-china"));

  for (const row of existing) {
    let plain = "";
    try {
      plain = decrypt(row.password);
    } catch {
      plain = row.password;
    }
    if (plain === key) {
      await db
        .update(accounts)
        .set({
          status: "active",
          enabled: true,
          tokens: { api_key: key },
          lastLoginAt: new Date(),
          errorMessage: null,
        })
        .where(eq(accounts.id, row.id));
      return row.id;
    }
  }

  const email = label || `cbc-account-${existing.length + 1}`;
  const inserted = await db
    .insert(accounts)
    .values({
      provider: "codebuddy-china",
      email,
      password: encrypt(key),
      status: "active",
      enabled: true,
      tokens: { api_key: key },
      quotaLimit: -1,
      quotaRemaining: -1,
      lastLoginAt: new Date(),
    })
    .returning();
  return inserted[0]!.id;
}

export function getCodebuddyCnFarmJob(id?: string): CodebuddyCnFarmJob | null {
  if (id) return jobs.get(id) ?? null;
  if (activeJobId) return jobs.get(activeJobId) ?? null;
  const all = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return all[0] ?? null;
}

export function listCodebuddyCnFarmJobs(): CodebuddyCnFarmJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
}

/** Drop finished farm jobs so Automation card progress clears with Browser Logs. */
export function clearFinishedCodebuddyCnFarmJobs(): { cleared: number } {
  let cleared = 0;
  for (const [id, job] of jobs) {
    if (job.status === "running") continue;
    jobs.delete(id);
    cleared++;
  }
  if (activeJobId && !jobs.has(activeJobId)) activeJobId = null;
  return { cleared };
}

export function cancelCodebuddyCnFarm(): boolean {
  if (!activeJobId) return false;
  const job = jobs.get(activeJobId);
  abortByJob.get(activeJobId)?.abort();
  if (job) {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    job.lastMessage = "cancelled by user";
    for (const sid of job.workerSessionIds) {
      updatePhase(sid, "cancelled", "cancelled by user");
    }
  }
  activeJobId = null;
  return true;
}

export async function startCodebuddyCnFarm(cfg: CodebuddyCnFarmConfig): Promise<CodebuddyCnFarmJob> {
  if (activeJobId && jobs.get(activeJobId)?.status === "running") {
    throw new Error("A CodeBuddy CN farm job is already running");
  }
  const token = cfg.fiveSimToken?.trim();
  if (!token) throw new Error("5sim API token is required");
  const count = Math.max(1, Math.min(50, Math.floor(cfg.count) || 1));
  const concurrent = Math.max(1, Math.min(5, Math.floor(cfg.concurrent) || 1));
  const country = (cfg.country || "hongkong").trim() || "hongkong";
  const headless = cfg.headless !== false;

  const id = `cbc-farm-${Date.now().toString(36)}`;
  const job: CodebuddyCnFarmJob = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    config: {
      fiveSimToken: "••••••••",
      count,
      concurrent,
      country,
      headless,
      product: cfg.product || "codebuddy",
    },
    imported: 0,
    failed: 0,
    errors: [],
    workerSessionIds: [],
    lastMessage: "Starting CodeBuddy CN phone farm…",
  };
  jobs.set(id, job);
  activeJobId = id;
  const abort = new AbortController();
  abortByJob.set(id, abort);

  // Fire-and-forget workers
  void runFarm(job, { ...cfg, fiveSimToken: token, count, concurrent, country, headless }, abort.signal).finally(() => {
    abortByJob.delete(id);
    if (activeJobId === id) activeJobId = null;
  });

  broadcast({
    type: "login_progress",
    data: {
      provider: "codebuddy-china",
      step: "farm",
      message: `CodeBuddy CN farm started: ${count} account(s), concurrent ${concurrent}`,
      jobId: id,
    },
  });

  return job;
}

async function runFarm(
  job: CodebuddyCnFarmJob,
  cfg: CodebuddyCnFarmConfig,
  signal: AbortSignal,
): Promise<void> {
  let next = 1;
  const total = cfg.count;
  const limit = Math.min(cfg.concurrent, total);

  const runOne = async (slot: number) => {
    while (!signal.aborted) {
      const n = next++;
      if (n > total) return;
      const email = `cbc-farm-${job.id.slice(-6)}-w${n}`;
      const sid = ensureWorker(job, n, email);
      progress(job, sid, "starting", `Worker #${n}: launching browser…`);

      let browser: import("playwright").Browser | null = null;
      let frameTimer: ReturnType<typeof setInterval> | null = null;
      try {
        const { launchBrowser } = await import("./engine");
        browser = await launchBrowser({
          engine: "chromium",
          headless: cfg.headless,
          stealthSeed: n,
        });
        progress(job, sid, "browser", `Worker #${n}: browser ready`);

        // Frame relay: screenshot any open page periodically
        frameTimer = setInterval(async () => {
          try {
            const pages = browser?.contexts().flatMap((c) => c.pages()) || [];
            const page = pages[pages.length - 1];
            if (!page || page.isClosed()) return;
            const buf = await page.screenshot({ type: "jpeg", quality: 50 });
            const b64 = Buffer.from(buf).toString("base64");
            updateFrame(sid, b64, "jpeg");
            broadcast({
              type: "browser_frame",
              data: { sessionId: sid, provider: "codebuddy-china", format: "jpeg" },
            });
          } catch {
            /* ignore frame errors */
          }
        }, 1500);

        progress(job, sid, "phone", `Worker #${n}: 5sim + codebuddy.cn phone login…`);
        const result = await runCodeBuddyCnPhoneFlow(browser, {
          token: cfg.fiveSimToken,
          country: cfg.country,
          product: cfg.product || "codebuddy",
        });

        if (result.error || !result.apiKey) {
          throw new Error(result.error || "phone farm failed");
        }

        const label = result.phone
          ? `cbc-${result.phone.replace(/\D/g, "").slice(-8)}`
          : email;
        progress(job, sid, "import", `Worker #${n}: importing API key…`);
        await upsertCodebuddyChinaApiKey(result.apiKey, label);
        job.imported++;
        progress(job, sid, "success", `Worker #${n}: imported ${label}`);
        updatePhase(sid, "complete", `imported ${label}`);
        broadcast({
          type: "login_success",
          data: {
            provider: "codebuddy-china",
            jobId: job.id,
            sessionId: sid,
            email: label,
            message: `CodeBuddy CN account ${label} ready`,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        job.failed++;
        job.errors.push(`#${n}: ${msg}`);
        progress(job, sid, "error", `Worker #${n}: ${msg}`);
        updatePhase(sid, "failed", msg);
        broadcast({
          type: "login_failed",
          data: {
            provider: "codebuddy-china",
            jobId: job.id,
            sessionId: sid,
            email,
            error: msg,
          },
        });
      } finally {
        if (frameTimer) clearInterval(frameTimer);
        try {
          await browser?.close();
        } catch {
          /* */
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: limit }, (_, i) => runOne(i + 1)));
  } finally {
    if (job.status === "running") {
      job.status = job.imported > 0 ? "completed" : "failed";
    }
    job.finishedAt = new Date().toISOString();
    job.lastMessage =
      job.status === "cancelled"
        ? "cancelled"
        : `Farm done: ${job.imported} imported, ${job.failed} failed`;
    pool.invalidate("codebuddy-china" as ProviderName);
    broadcast({
      type: job.imported > 0 ? "login_success" : "login_failed",
      data: {
        provider: "codebuddy-china",
        jobId: job.id,
        message: job.lastMessage,
        imported: job.imported,
        failed: job.failed,
      },
    });
    broadcast({ type: "accounts_updated", data: { provider: "codebuddy-china", count: job.imported } });
  }
}
