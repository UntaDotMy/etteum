/**
 * Grok farm automation — runs vendored scripts/auth/grok-farm/farm.py and
 * imports finished accounts into the Grok provider pool.
 *
 * Farm remains the producer (signup + OIDC). Etteum owns config (UI → env),
 * process lifecycle, progress events, and account persistence.
 */
import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { broadcast } from "../../ws/index";
import { config } from "../../config";
import {
  registerSession,
  appendStep,
  updatePhase,
  updateFrame,
  getSession,
} from "../browserSession";

export type GrokMailMode = "tempmail" | "google";

export interface GrokFarmConfig {
  mailMode: GrokMailMode;
  /** google IMAP path */
  imapUser?: string;
  imapPass?: string;
  imapHost?: string;
  imapPort?: number;
  emailMode?: "domain" | "plus_trick";
  emailDomain?: string;
  gmailBase?: string;
  /** shared xAI account password for farmed signups */
  accountPassword: string;
  maxAccounts: number;
  concurrent: number;
  headless: boolean;
  activateWeb: boolean;
  proxyFile?: string;
  captchaApiKey?: string;
  captchaProxyUrl?: string;
  captchaModel?: string;
  /**
   * Advanced farm knobs (map 1:1 to GROK_* env — see scripts/auth/grok-farm/.env.example).
   * Defaults match the standalone farm .env.example so UI and CLI stay aligned.
   */
  workerIsolation?: boolean;
  /** Seconds between each worker *start* (worker N waits delay × (N-1)). 0 = auto-stagger only. */
  spawnDelay?: number;
  autoStagger?: boolean;
  autoSpawnDelay?: number;
  /** Max simultaneous Camoufox boots (not total workers). */
  launchParallel?: number;
  tempmailBlockImages?: boolean;
  turnstileParallel?: number;
  uiRetries?: number;
  uiRetryBackoff?: number;
  probeRetries?: number;
  probeRetryBackoff?: number;
  otpTimeout?: number;
  confirmTimeout?: number;
  completeTimeout?: number;
  accountTimeout?: number;
  proxyShuffle?: boolean;
  proxyPool?: string;
  emailLocalLen?: number;
}

export interface GrokFarmJobState {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  config: GrokFarmConfig;
  logTail: string[];
  imported: number;
  failed: number;
  errors: string[];
  batchDir?: string;
  pid?: number;
  lastMessage?: string;
  /** Per-worker Bot Logs session ids: jobId-w{N} */
  workerSessionIds: string[];
}

const jobs = new Map<string, GrokFarmJobState>();
let activeProc: ChildProcessWithoutNullStreams | null = null;
let activeJobId: string | null = null;

function workerSessionId(jobId: string, workerId: number): string {
  return `${jobId}-w${workerId}`;
}

function ensureWorkerSession(
  job: GrokFarmJobState,
  workerId: number,
  email?: string,
): string {
  const sid = workerSessionId(job.id, workerId);
  const label = (email && email.trim()) || `Grok worker #${workerId}`;
  const existing = getSession(sid);
  if (!existing) {
    registerSession({
      sessionId: sid,
      accountId: workerId,
      email: label,
      provider: "grok",
      phase: "starting",
      lastMessage: "Worker starting…",
      lastFrame: "",
      lastFrameFormat: "jpeg",
      lastFrameTime: 0,
      steps: [],
      challenge: null,
      terminal: false,
      proc: activeProc,
      stdinWriter: null,
      cancelSignalFile: "",
      startedAt: Date.now(),
    });
    if (!job.workerSessionIds.includes(sid)) job.workerSessionIds.push(sid);
    // Parent job process is the cancel target for every worker card.
    const parent = getSession(job.id);
    if (parent?.proc) {
      const w = getSession(sid);
      if (w) w.proc = parent.proc;
    }
  } else if (email && email.trim() && existing.email.startsWith("Grok worker")) {
    existing.email = email.trim();
  }
  return sid;
}

function forEachWorkerSession(job: GrokFarmJobState, fn: (sid: string) => void) {
  const ids = new Set<string>([job.id, ...job.workerSessionIds]);
  for (const sid of ids) fn(sid);
}

/** Cache import checks — spawning Python+camoufox is multi-second and was re-run on every modal open. */
const camoufoxOkCache = new Map<string, { ok: boolean; at: number }>();
const CAMOUFOX_CACHE_MS = 120_000;
let resolvePythonCache: { python: string | null; at: number } | null = null;
const RESOLVE_PYTHON_CACHE_MS = 60_000;

/** True if this interpreter can import camoufox (farm requirement). */
function pythonHasCamoufox(pythonExe: string): boolean {
  const key = pythonExe;
  const hit = camoufoxOkCache.get(key);
  if (hit && Date.now() - hit.at < CAMOUFOX_CACHE_MS) return hit.ok;
  try {
    execFileSync(
      pythonExe,
      ["-c", "import camoufox; import playwright"],
      { encoding: "utf8", timeout: 12_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    camoufoxOkCache.set(key, { ok: true, at: Date.now() });
    return true;
  } catch {
    camoufoxOkCache.set(key, { ok: false, at: Date.now() });
    return false;
  }
}

/**
 * Use etteum's existing Python surface — same as Camoufox auth / canva worker:
 *   1. config.pythonPath  (scripts/auth/.venv or PYTHON_PATH)
 *   2. ETTEUM_PYTHON / BATCHER_PYTHON
 *   3. Any PATH/system python that already has camoufox
 *   4. Optional farm-local .venv only as last resort (not required)
 */
function resolvePython(): string | null {
  if (resolvePythonCache && Date.now() - resolvePythonCache.at < RESOLVE_PYTHON_CACHE_MS) {
    return resolvePythonCache.python;
  }

  const candidates: string[] = [];

  const push = (p: string | null | undefined) => {
    if (!p) return;
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    // bare name like "python.exe" — keep as-is for PATH lookup later
    if (path.basename(p) === p || existsSync(abs) || existsSync(p)) {
      if (!candidates.includes(p) && !candidates.includes(abs)) {
        candidates.push(existsSync(abs) ? abs : p);
      }
    }
  };

  // Official etteum interpreter first (scripts/auth/.venv via config.pythonPath).
  // Prefer these before expensive PATH probes — usually the right answer.
  push(config.pythonPath);
  push(process.env.PYTHON_PATH);
  push(process.env.ETTEUM_PYTHON);
  push(process.env.BATCHER_PYTHON);

  const authVenv =
    process.platform === "win32"
      ? path.join(config.authScriptCwd, ".venv", "Scripts", "python.exe")
      : path.join(config.authScriptCwd, ".venv", "bin", "python");
  push(authVenv);

  // Fast path: first existing candidate with camoufox (auth venv usually).
  for (const c of candidates) {
    if (path.basename(c) === c) {
      if (pythonHasCamoufox(c)) {
        resolvePythonCache = { python: c, at: Date.now() };
        return c;
      }
      continue;
    }
    if (existsSync(c) && pythonHasCamoufox(c)) {
      resolvePythonCache = { python: c, at: Date.now() };
      return c;
    }
  }

  // System installs that commonly have camoufox when install.ps1 ran pip global.
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || "";
    if (home) {
      for (const ver of ["Python312", "Python311", "Python310"]) {
        push(path.join(home, "AppData", "Local", "Programs", "Python", ver, "python.exe"));
      }
    }
  }

  // PATH lookup only if preferred paths failed (each where/which + import is costly).
  const whichCmds =
    process.platform === "win32"
      ? [["where", "python"], ["where", "python3"], ["where", "py"]]
      : [["which", "python3"], ["which", "python"]];
  for (const [cmd, arg] of whichCmds) {
    try {
      const out = execFileSync(cmd, [arg], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (out && !out.toLowerCase().includes("windowsapps\\python")) push(out);
    } catch { /* next */ }
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("py", ["-3", "-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).trim();
      push(out);
    } catch { /* */ }
  }

  // Prefer any candidate that already has camoufox+playwright.
  for (const c of candidates) {
    if (path.basename(c) === c) {
      if (pythonHasCamoufox(c)) {
        resolvePythonCache = { python: c, at: Date.now() };
        return c;
      }
      continue;
    }
    if (existsSync(c) && pythonHasCamoufox(c)) {
      resolvePythonCache = { python: c, at: Date.now() };
      return c;
    }
  }

  // Farm-local venv only if someone created it (optional, not required).
  const farmVenv =
    process.platform === "win32"
      ? path.join(farmRoot(), ".venv", "Scripts", "python.exe")
      : path.join(farmRoot(), ".venv", "bin", "python");
  if (existsSync(farmVenv) && pythonHasCamoufox(farmVenv)) {
    resolvePythonCache = { python: farmVenv, at: Date.now() };
    return farmVenv;
  }

  // Fall back to etteum pythonPath even without camoufox so the error message
  // from farm.py / our validate is clear and points at scripts/auth deps.
  const fallback = config.pythonPath || candidates[0] || null;
  resolvePythonCache = { python: fallback, at: Date.now() };
  return fallback;
}

function farmRoot(): string {
  const root = process.env.ETTEUM_ROOT || process.cwd();
  return path.join(root, "scripts", "auth", "grok-farm");
}

function farmScript(): string {
  return path.join(farmRoot(), "farm.py");
}

export function getGrokFarmJob(id?: string): GrokFarmJobState | null {
  if (id) return jobs.get(id) ?? null;
  if (activeJobId) return jobs.get(activeJobId) ?? null;
  const all = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return all[0] ?? null;
}

export function listGrokFarmJobs(): GrokFarmJobState[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
}

/**
 * Drop finished/cancelled farm jobs from memory so Automation card progress
 * disappears when Browser Logs is cleared. Does not touch a still-running job.
 */
export function clearFinishedGrokFarmJobs(): { cleared: number } {
  let cleared = 0;
  for (const [id, job] of jobs) {
    if (job.status === "running") continue;
    jobs.delete(id);
    cleared++;
  }
  if (activeJobId && !jobs.has(activeJobId)) activeJobId = null;
  return { cleared };
}

function pushLog(job: GrokFarmJobState, line: string) {
  const raw = line.replace(/\r/g, "").trimEnd();
  if (!raw) return;

  // Farm → host event bus (ETTEUM_JSON:…). Frames + per-worker progress.
  // Concurrency N → N Bot Logs sessions (jobId-w{N}); job.id is the overview card.
  if (raw.startsWith("ETTEUM_JSON:")) {
    try {
      const payload = JSON.parse(raw.slice("ETTEUM_JSON:".length)) as {
        type?: string;
        base64?: string;
        format?: string;
        workerId?: number;
        email?: string;
        step?: string;
        message?: string;
        ok?: boolean;
        error?: string;
      };
      const wid =
        typeof payload.workerId === "number" && Number.isFinite(payload.workerId)
          ? Math.floor(payload.workerId)
          : null;

      if (payload.type === "frame" && payload.base64) {
        const sid = wid != null ? ensureWorkerSession(job, wid, payload.email) : job.id;
        updateFrame(sid, payload.base64, payload.format || "jpeg");
        broadcast({
          type: "browser_frame",
          data: {
            sessionId: sid,
            provider: "grok",
            format: payload.format || "jpeg",
            workerId: wid ?? undefined,
          },
        });
        return; // never put multi-KB base64 into logTail
      }

      if (payload.type === "worker_start" && wid != null) {
        const sid = ensureWorkerSession(job, wid, payload.email);
        const msg = payload.message || "SPAWN worker browser…";
        updatePhase(sid, "starting", msg);
        appendStep(sid, "spawn", msg, "grok");
        // Per-worker only — never fan out to siblings.
        broadcast({
          type: "login_progress",
          data: {
            provider: "grok",
            step: "starting",
            message: msg,
            jobId: job.id,
            email: payload.email || `Grok worker #${wid}`,
            sessionId: sid,
            workerId: wid,
          },
        });
        return;
      }

      // EXIT worker (browsers killed) before a NEW spawn on the same slot.
      if (payload.type === "worker_exit" && wid != null) {
        const sid = ensureWorkerSession(job, wid, payload.email);
        const msg = payload.message || "EXIT worker → NEW spawn";
        updatePhase(sid, "cleanup", msg);
        appendStep(sid, "exit", msg, "grok");
        job.lastMessage = `[#${wid}] ${msg}`.slice(0, 300);
        appendStep(job.id, "exit", `[#${wid}] ${msg}`, "grok");
        updatePhase(job.id, "farming", job.lastMessage);
        broadcast({
          type: "login_progress",
          data: {
            provider: "grok",
            step: "cleanup",
            message: msg,
            jobId: job.id,
            email: payload.email || `Grok worker #${wid}`,
            sessionId: sid,
            workerId: wid,
          },
        });
        return;
      }

      if (payload.type === "progress" && wid != null) {
        const sid = ensureWorkerSession(job, wid, payload.email);
        const step = payload.step || "progress";
        const msg = payload.message || step;
        appendStep(sid, step, msg, "grok");
        updatePhase(sid, step, msg);
        job.lastMessage = `[#${wid}] ${msg}`.slice(0, 300);
        // Mirror short progress on the job overview card (no frame).
        appendStep(job.id, step, `[#${wid}] ${msg}`, "grok");
        updatePhase(job.id, "farming", job.lastMessage);
        broadcast({
          type: "login_progress",
          data: {
            provider: "grok",
            step,
            message: msg,
            jobId: job.id,
            email: payload.email || `Grok worker #${wid}`,
            sessionId: sid,
            workerId: wid,
          },
        });
        return;
      }

      if (payload.type === "worker_done" && wid != null) {
        const sid = ensureWorkerSession(job, wid, payload.email);
        const ok = payload.ok !== false;
        const msg = payload.message || payload.error || (ok ? "done" : "failed");
        updatePhase(sid, ok ? "complete" : "failed", msg);
        appendStep(sid, ok ? "success" : "error", msg, "grok");
        broadcast({
          type: ok ? "login_success" : "login_failed",
          data: {
            provider: "grok",
            jobId: job.id,
            email: payload.email || `Grok worker #${wid}`,
            sessionId: sid,
            workerId: wid,
            message: msg,
            error: ok ? undefined : msg,
          },
        });
        return;
      }
    } catch {
      /* fall through as normal log */
    }
  }

  const msg = raw;
  job.logTail.push(msg);
  if (job.logTail.length > 200) job.logTail.splice(0, job.logTail.length - 200);
  job.lastMessage = msg.slice(0, 300);

  // Process-wide stdout (non-ETTEUM_JSON) belongs on the job overview only.
  // Never fan the same line/phase onto every worker card — that made all
  // concurrent workers show identical status/messages. Per-worker progress
  // arrives as ETTEUM_JSON with workerId (progress / worker_start / worker_done).
  const sid = job.id;
  const isErr = /error|failed|traceback|exception|sys\.exit|ModuleNotFound|ImportError/i.test(msg);
  appendStep(sid, isErr ? "error" : "farm", job.lastMessage, "grok");
  updatePhase(sid, isErr ? "error" : "farming", job.lastMessage);
  broadcast({
    type: "login_progress",
    data: {
      provider: "grok",
      step: isErr ? "error" : "farm",
      message: job.lastMessage,
      jobId: job.id,
      email: "Grok Farm",
      sessionId: sid,
    },
  });
}

/** Prefer a concrete farm ERROR/traceback line over the generic batch-missing message. */
function bestFarmErrorMessage(job: GrokFarmJobState, fallback: string): string {
  const lines = job.logTail || [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] || "";
    if (/^ERROR:/i.test(l.trim()) || /camoufox not installed/i.test(l)) {
      return l.trim().slice(0, 400);
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] || "";
    if (/traceback|modulenotfound|importerror|error:/i.test(l) && !/no new farm batch/i.test(l)) {
      return l.trim().slice(0, 400);
    }
  }
  // Last non-empty process line that isn't just our placeholder
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] || "").trim();
    if (l && !/waiting for farm worker/i.test(l) && !/^\[etteum\] starting/i.test(l)) {
      if (/\[etteum\]|error|fail|exit/i.test(l)) return l.slice(0, 400);
    }
  }
  return fallback;
}

/** Defaults aligned with scripts/auth/grok-farm/.env.example (standalone farm). */
export const GROK_FARM_ENV_DEFAULTS = {
  workerIsolation: true,
  spawnDelay: 15,
  autoStagger: true,
  autoSpawnDelay: 15,
  launchParallel: 2,
  tempmailBlockImages: true,
  turnstileParallel: 64,
  uiRetries: 3,
  uiRetryBackoff: 2,
  probeRetries: 5,
  probeRetryBackoff: 2.5,
} as const;

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  return fallback;
}

function buildEnv(cfg: GrokFarmConfig): NodeJS.ProcessEnv {
  const resultsDir = path.join(farmRoot(), "results");
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(path.join(farmRoot(), "screenshots"), { recursive: true });

  const d = GROK_FARM_ENV_DEFAULTS;
  const workerIsolation = bool(cfg.workerIsolation, d.workerIsolation);
  const spawnDelay = num(cfg.spawnDelay, d.spawnDelay, 0, 600);
  const autoStagger = bool(cfg.autoStagger, d.autoStagger);
  const autoSpawnDelay = num(cfg.autoSpawnDelay, d.autoSpawnDelay, 0, 600);
  const launchParallel = num(cfg.launchParallel, d.launchParallel, 1, 16);
  const tempmailBlockImages = bool(cfg.tempmailBlockImages, d.tempmailBlockImages);
  const turnstileParallel = num(cfg.turnstileParallel, d.turnstileParallel, 1, 256);
  const uiRetries = num(cfg.uiRetries, d.uiRetries, 0, 20);
  const uiRetryBackoff = num(cfg.uiRetryBackoff, d.uiRetryBackoff, 0, 60);
  const probeRetries = num(cfg.probeRetries, d.probeRetries, 0, 20);
  const probeRetryBackoff = num(cfg.probeRetryBackoff, d.probeRetryBackoff, 0, 60);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Mark host-owned config so farm.py .env load does not clobber these.
    ETTEUM_FARM_HOST: "1",
    GROK_UI: "log",
    GROK_VERBOSE: "true",
    GROK_MAIL_MODE: cfg.mailMode === "tempmail" ? "tempmail" : "google",
    GROK_PASSWORD: cfg.accountPassword,
    GROK_MAX_ACCOUNTS: String(cfg.maxAccounts),
    GROK_CONCURRENT: String(cfg.concurrent),
    // Headless OS window (no popup) — frames still stream via screenshot relay.
    GROK_HEADLESS: cfg.headless === false ? "false" : "true",
    ETTEUM_FRAME_RELAY: "true",
    ETTEUM_FRAME_INTERVAL: "1.5",
    GROK_ACTIVATE_WEB: cfg.activateWeb ? "true" : "false",
    GROK_RESULTS_DIR: resultsDir,
    GROK_USED_EMAILS_FILE: path.join(resultsDir, "used_emails.txt"),
    GROK_SCREENSHOTS: "false",
    // Worker / launch (standalone .env.example)
    GROK_WORKER_ISOLATION: workerIsolation ? "true" : "false",
    GROK_SPAWN_DELAY: String(spawnDelay),
    GROK_AUTO_STAGGER: autoStagger ? "true" : "false",
    GROK_AUTO_SPAWN_DELAY: String(autoSpawnDelay),
    GROK_LAUNCH_PARALLEL: String(launchParallel),
    GROK_TEMPMAIL_BLOCK_IMAGES: tempmailBlockImages ? "true" : "false",
    GROK_TURNSTILE_PARALLEL: String(turnstileParallel),
    GROK_UI_RETRIES: String(uiRetries),
    GROK_UI_RETRY_BACKOFF: String(uiRetryBackoff),
    GROK_PROBE_RETRIES: String(probeRetries),
    GROK_PROBE_RETRY_BACKOFF: String(probeRetryBackoff),
    PYTHONUNBUFFERED: "1",
    // Avoid Windows cp1252 UnicodeEncodeError on arrows/emoji in print().
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  if (cfg.mailMode === "google") {
    if (cfg.imapUser) env.GROK_IMAP_USER = cfg.imapUser;
    if (cfg.imapPass) env.GROK_IMAP_PASS = cfg.imapPass;
    env.GROK_IMAP_HOST = cfg.imapHost || "imap.gmail.com";
    env.GROK_IMAP_PORT = String(cfg.imapPort || 993);
    env.GROK_EMAIL_MODE = cfg.emailMode || "domain";
    if (cfg.emailDomain) env.GROK_EMAIL_DOMAIN = cfg.emailDomain.replace(/^@/, "");
    if (cfg.gmailBase) env.GROK_GMAIL_BASE = cfg.gmailBase;
  }

  if (cfg.proxyFile && existsSync(cfg.proxyFile)) {
    env.GROK_PROXY_FILE = cfg.proxyFile;
  } else {
    const defaultProxy = path.join(farmRoot(), "proxies.txt");
    if (existsSync(defaultProxy)) env.GROK_PROXY_FILE = defaultProxy;
  }
  if (cfg.proxyPool && cfg.proxyPool.trim()) {
    env.GROK_PROXY_POOL = cfg.proxyPool.trim();
  }
  if (cfg.proxyShuffle != null) {
    env.GROK_PROXY_SHUFFLE = cfg.proxyShuffle ? "true" : "false";
  }

  if (cfg.captchaApiKey) env.GROK_CAPTCHA_API_KEY = cfg.captchaApiKey;
  if (cfg.captchaProxyUrl) env.GROK_CAPTCHA_PROXY_URL = cfg.captchaProxyUrl;
  if (cfg.captchaModel) env.GROK_CAPTCHA_MODEL = cfg.captchaModel;

  if (cfg.otpTimeout != null) env.GROK_OTP_TIMEOUT = String(num(cfg.otpTimeout, 120, 10, 3600));
  if (cfg.confirmTimeout != null) env.GROK_CONFIRM_TIMEOUT = String(num(cfg.confirmTimeout, 45, 5, 600));
  if (cfg.completeTimeout != null) env.GROK_COMPLETE_TIMEOUT = String(num(cfg.completeTimeout, 90, 10, 600));
  if (cfg.accountTimeout != null) env.GROK_ACCOUNT_TIMEOUT = String(num(cfg.accountTimeout, 480, 60, 7200));
  if (cfg.emailLocalLen != null) env.GROK_EMAIL_LOCAL_LEN = String(num(cfg.emailLocalLen, 16, 6, 48));

  return env;
}

function findNewestBatch(resultsDir: string, afterMs: number): string | null {
  if (!existsSync(resultsDir)) return null;
  const dirs = readdirSync(resultsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("batch_"))
    .map((d) => {
      const full = path.join(resultsDir, d.name);
      try {
        const st = statSync(full);
        return { full, mtime: st.mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .filter((d) => d.mtime >= afterMs - 2000)
    .sort((a, b) => b.mtime - a.mtime);
  return dirs[0]?.full ?? null;
}

async function importBatch(job: GrokFarmJobState, batchDir: string): Promise<void> {
  const accountsPath = path.join(batchDir, "accounts.json");
  if (!existsSync(accountsPath)) {
    job.errors.push(`No accounts.json in ${batchDir}`);
    return;
  }
  let records: Array<Record<string, unknown>> = [];
  try {
    records = JSON.parse(readFileSync(accountsPath, "utf8"));
    if (!Array.isArray(records)) records = [];
  } catch (e) {
    job.errors.push(`Failed to parse accounts.json: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (records.length === 0) {
    job.lastMessage = "Farm finished with 0 accounts in batch";
    return;
  }
  const { importGrokFarmAccounts } = await import("../../api/accounts/actionroutes");
  const result = await importGrokFarmAccounts(records);
  job.imported += result.success;
  job.failed += result.failed;
  if (result.errors?.length) job.errors.push(...result.errors);
  job.lastMessage = `Imported ${result.success} Grok account(s), ${result.failed} failed`;
  broadcast({
    type: "login_success",
    data: {
      provider: "grok",
      message: job.lastMessage,
      count: result.success,
      jobId: job.id,
    },
  });
}

export async function startGrokFarm(cfg: GrokFarmConfig): Promise<GrokFarmJobState> {
  if (activeProc) {
    throw new Error("A Grok farm job is already running");
  }
  const script = farmScript();
  if (!existsSync(script)) {
    throw new Error(`Grok farm script missing: ${script}`);
  }
  const python = resolvePython();
  if (!python) {
    throw new Error(
      "Python not found. Use etteum's auth env: scripts/auth/.venv " +
        "(install: python -m venv scripts/auth/.venv && scripts/auth/.venv/Scripts/pip install -r scripts/auth/requirements.txt)",
    );
  }
  if (!pythonHasCamoufox(python)) {
    throw new Error(
      `Selected Python lacks camoufox: ${python}. ` +
        `Heal shared env: bun scripts/doctor.ts --fix ` +
        `(or: "${python}" -m pip install -r scripts/auth/requirements.txt && "${python}" -m camoufox fetch)`,
    );
  }
  if (!cfg.accountPassword?.trim()) {
    throw new Error("Account password is required");
  }
  if (cfg.mailMode === "google") {
    if (!cfg.imapUser?.trim() || !cfg.imapPass?.trim()) {
      throw new Error("IMAP user and app password are required for Gmail/IMAP mode");
    }
    if ((cfg.emailMode || "domain") === "domain" && !cfg.emailDomain?.trim()) {
      throw new Error("Catch-all email domain is required for domain mode");
    }
  }

  const id = `grok-farm-${Date.now().toString(36)}`;
  const job: GrokFarmJobState = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    config: cfg,
    logTail: [],
    imported: 0,
    failed: 0,
    errors: [],
    workerSessionIds: [],
  };
  jobs.set(id, job);
  activeJobId = id;

  const startedMs = Date.now();
  const env = buildEnv(cfg);
  const mailFlag = cfg.mailMode === "tempmail" ? "tempmail" : "google";
  const concurrent = Math.max(1, Math.min(8, cfg.concurrent));
  const args = [
    script,
    "-m", mailFlag,
    "-n", String(Math.max(1, Math.min(100, cfg.maxAccounts))),
    "-c", String(concurrent),
    "-y",
  ];

  // Overview session (job-level logs). Worker cards are pre-registered so Browser
  // Logs is not empty while Python/Camoufox boots (can take many seconds).
  registerSession({
    sessionId: id,
    accountId: 0,
    email: "Grok Farm",
    provider: "grok",
    phase: "starting",
    lastMessage: `Starting Grok farm (headless, concurrent=${concurrent})…`,
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

  // Concurrent slots 1..N → N Bot Logs cards immediately (phase: starting).
  for (let w = 1; w <= concurrent; w++) {
    const sid = ensureWorkerSession(job, w);
    appendStep(sid, "queued", "Waiting for farm worker / browser…", "grok");
    updatePhase(sid, "starting", "Waiting for farm worker / browser…");
    broadcast({
      type: "login_progress",
      data: {
        provider: "grok",
        step: "starting",
        message: `Worker #${w} slot ready — launching farm process…`,
        jobId: id,
        email: `Grok worker #${w}`,
        sessionId: sid,
        workerId: w,
      },
    });
  }

  pushLog(job, `[etteum] starting farm (always headless, shared Camoufox): ${python}`);
  pushLog(job, `[etteum] args: ${args.slice(1).join(" ")}`);
  const proc = spawn(python, args, {
    cwd: farmRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  activeProc = proc;
  job.pid = proc.pid;
  // Attach proc for cancel from Browser Logs (overview + any workers).
  const sess = getSession(id);
  if (sess) sess.proc = proc;
  for (const sid of job.workerSessionIds) {
    const w = getSession(sid);
    if (w) w.proc = proc;
  }

  // Line-buffer stdout/stderr — ETTEUM_JSON frames are multi-KB; Node chunks
  // mid-line. Same pattern as pythonFlow.ts / runner.ts.
  let stdoutBuf = "";
  let stderrBuf = "";
  const drainLines = (chunk: Buffer, which: "out" | "err") => {
    const prev = which === "out" ? stdoutBuf : stderrBuf;
    const merged = prev + chunk.toString("utf8");
    const parts = merged.split(/\r?\n/);
    const rest = parts.pop() ?? "";
    if (which === "out") stdoutBuf = rest;
    else stderrBuf = rest;
    for (const line of parts) {
      if (line.trim()) pushLog(job, line);
    }
  };
  proc.stdout.on("data", (buf: Buffer) => drainLines(buf, "out"));
  proc.stderr.on("data", (buf: Buffer) => drainLines(buf, "err"));

  proc.on("error", (err) => {
    pushLog(job, `[etteum] spawn error: ${err.message}`);
    forEachWorkerSession(job, (sid) => updatePhase(sid, "failed", err.message));
  });

  proc.on("close", async (code) => {
    // Flush any trailing partial line (rare for frames, useful for last log).
    if (stdoutBuf.trim()) pushLog(job, stdoutBuf);
    if (stderrBuf.trim()) pushLog(job, stderrBuf);
    stdoutBuf = "";
    stderrBuf = "";

    activeProc = null;
    activeJobId = null;
    if (!job.finishedAt) job.finishedAt = new Date().toISOString();

    // Preserve user cancel — do not overwrite cancelled with failed/completed.
    const wasCancelled = job.status === "cancelled";

    if (!wasCancelled) {
      const batch = findNewestBatch(path.join(farmRoot(), "results"), startedMs);
      if (batch) {
        job.batchDir = batch;
        pushLog(job, `[etteum] importing batch ${path.basename(batch)}`);
        try {
          await importBatch(job, batch);
        } catch (e) {
          job.errors.push(e instanceof Error ? e.message : String(e));
        }
      } else if (code !== 0) {
        const detail = bestFarmErrorMessage(
          job,
          `Farm process exited with code ${code} and wrote no batch folder.`,
        );
        const hint =
          /camoufox not installed/i.test(detail) || job.logTail.some((l) => /camoufox not installed/i.test(l))
            ? " Heal shared env: bun scripts/doctor.ts --fix"
            : /IMAP|EMAIL_DOMAIN|GROK_IMAP|plus_trick/i.test(detail)
              ? " Check Grok Farm mail settings (IMAP / domain / tempmail)."
              : "";
        const summary = `${detail}${hint}`;
        job.errors.push(summary);
        // Use pushLog so workers get the mirrored step too.
        pushLog(job, `[etteum] farm failed (exit ${code}): ${summary}`);
        job.lastMessage = summary.slice(0, 400);
      } else {
        const detail = bestFarmErrorMessage(job, "No new farm batch folder found after run");
        job.errors.push(detail);
        job.lastMessage = detail.slice(0, 400);
        pushLog(job, `[etteum] farm finished with no batch: ${detail}`);
      }
      job.status = code === 0 || job.imported > 0 ? "completed" : "failed";
      if (code !== 0 && job.imported === 0 && !job.lastMessage) {
        job.lastMessage = job.errors[job.errors.length - 1] || `Farm exited with code ${code}`;
      }
    }

    const phase =
      job.status === "cancelled"
        ? "cancelled"
        : job.status === "completed"
          ? "complete"
          : "failed";
    const endMsg = job.lastMessage || job.status;
    forEachWorkerSession(job, (sid) => {
      const s = getSession(sid);
      // Don't overwrite workers already marked complete/failed mid-run.
      if (s && !s.terminal) {
        appendStep(
          sid,
          phase === "complete" ? "success" : phase === "cancelled" ? "cancelled" : "error",
          endMsg,
          "grok",
        );
        updatePhase(sid, phase, endMsg);
      } else if (sid === job.id && s) {
        appendStep(
          sid,
          phase === "complete" ? "success" : phase === "cancelled" ? "cancelled" : "error",
          endMsg,
          "grok",
        );
        updatePhase(sid, phase, endMsg);
      }
    });
    broadcast({
      type:
        job.status === "completed"
          ? "login_success"
          : job.status === "cancelled"
            ? "login_progress"
            : "login_failed",
      data: {
        provider: "grok",
        jobId: job.id,
        email: "Grok Farm",
        sessionId: job.id,
        message: job.lastMessage,
        error: job.status === "failed" ? job.lastMessage : undefined,
        imported: job.imported,
        failed: job.failed,
        step: job.status === "cancelled" ? "cancelled" : undefined,
      },
    });
    // Refresh each worker card so steps + phase appear without waiting for poll.
    forEachWorkerSession(job, (sid) => {
      if (sid === job.id) return; // overview is hidden; workers already updated above
      const w = getSession(sid);
      broadcast({
        type:
          job.status === "completed"
            ? "login_success"
            : job.status === "cancelled"
              ? "login_progress"
              : "login_failed",
        data: {
          sessionId: sid,
          provider: "grok",
          jobId: job.id,
          email: w?.email || "Grok worker",
          message: endMsg,
          error: job.status === "failed" ? endMsg : undefined,
          terminal: true,
          phase: job.status,
        },
      });
      broadcast({
        type: "browser_frame",
        data: { sessionId: sid, terminal: true, phase: job.status },
      });
    });
  });

  broadcast({
    type: "browser_frame",
    data: { sessionId: id, provider: "grok", phase: "starting" },
  });

  return job;
}

/**
 * Kill farm Python + its full process tree (Camoufox/Firefox children).
 * Mirrors farm.py `_kill_pid_tree` / `taskkill /T` so Stop all does not leave
 * orphan browsers the way a bare `proc.kill()` can on Windows.
 */
export function killProcessTree(pid: number | undefined | null): void {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return;
  const p = Math.floor(pid);
  try {
    if (process.platform === "win32") {
      // /T = kill tree rooted at this pid (python → camoufox → firefox)
      execFileSync("taskkill", ["/F", "/T", `/PID`, String(p)], {
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
      });
      return;
    }
    // Unix: kill process group if spawned detached; else children then parent.
    try {
      process.kill(-p, "SIGTERM");
    } catch {
      /* not a group leader */
    }
    try {
      const kids = execFileSync("pgrep", ["-P", String(p)], {
        encoding: "utf8",
        timeout: 3_000,
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const k of kids) {
        try {
          process.kill(Number(k), "SIGKILL");
        } catch {
          /* gone */
        }
      }
    } catch {
      /* no pgrep / no children */
    }
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  } catch {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

export function cancelGrokFarm(): boolean {
  if (!activeProc || !activeJobId) return false;
  const job = jobs.get(activeJobId);
  const pid = activeProc.pid;
  // Tree-kill first (Windows taskkill /T). Farm atexit may not run if we force
  // kill, but browsers + python both die — no Camoufox zombies.
  killProcessTree(pid);
  try {
    activeProc.kill("SIGKILL");
  } catch {
    /* already dead after taskkill */
  }
  if (job) {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    job.lastMessage = "cancelled by user";
    pushLog(job, "[etteum] cancelled by user (process tree killed)");
    forEachWorkerSession(job, (sid) => {
      appendStep(sid, "cancelled", "cancelled by user", "grok");
      updatePhase(sid, "cancelled", "cancelled by user");
    });
  }
  activeProc = null;
  activeJobId = null;
  return true;
}

export function validateGrokFarmSetup(): {
  ok: boolean;
  python: string | null;
  farmScript: string;
  farmScriptExists: boolean;
  hasCamoufox: boolean;
  authVenv: string;
  errors: string[];
} {
  const python = resolvePython();
  const script = farmScript();
  const authVenv =
    process.platform === "win32"
      ? path.join(config.authScriptCwd, ".venv", "Scripts", "python.exe")
      : path.join(config.authScriptCwd, ".venv", "bin", "python");
  const errors: string[] = [];
  if (!python) {
    errors.push("Python not found — use etteum scripts/auth/.venv (same as auth bots)");
  }
  if (!existsSync(script)) errors.push(`Missing farm script at ${script}`);
  const hasCamoufox = python ? pythonHasCamoufox(python) : false;
  if (python && !hasCamoufox) {
    errors.push(
      `Python at ${python} is missing camoufox/playwright. ` +
        `Heal shared env: bun scripts/doctor.ts --fix ` +
        `(or: "${python}" -m pip install -r scripts/auth/requirements.txt && "${python}" -m camoufox fetch)`,
    );
  }
  return {
    ok: errors.length === 0,
    python,
    farmScript: script,
    farmScriptExists: existsSync(script),
    hasCamoufox,
    authVenv,
    errors,
  };
}
