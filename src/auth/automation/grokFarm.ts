/**
 * Grok farm automation — runs vendored scripts/auth/grok-farm/farm.py and
 * imports finished accounts into the Grok provider pool.
 *
 * Farm remains the producer (signup + OIDC). Etteum owns config (UI → env),
 * process lifecycle, progress events, and account persistence.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { broadcast } from "../../ws/index";

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
}

const jobs = new Map<string, GrokFarmJobState>();
let activeProc: ChildProcessWithoutNullStreams | null = null;
let activeJobId: string | null = null;

function resolvePython(): string | null {
  if (process.env.ETTEUM_PYTHON && existsSync(process.env.ETTEUM_PYTHON)) return process.env.ETTEUM_PYTHON;
  if (process.env.BATCHER_PYTHON && existsSync(process.env.BATCHER_PYTHON)) return process.env.BATCHER_PYTHON;
  const whichCmds =
    process.platform === "win32"
      ? [["where", "python"], ["where", "python3"], ["where", "py"]]
      : [["which", "python3"], ["which", "python"]];
  for (const [cmd, arg] of whichCmds) {
    try {
      const out = execFileSync(cmd, [arg], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (out && existsSync(out) && !out.toLowerCase().includes("windowsapps\\python")) return out;
    } catch { /* next */ }
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("py", ["-3", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
      if (out && existsSync(out)) return out;
    } catch { /* */ }
  }
  return null;
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

function pushLog(job: GrokFarmJobState, line: string) {
  const msg = line.replace(/\r/g, "").trimEnd();
  if (!msg) return;
  job.logTail.push(msg);
  if (job.logTail.length > 200) job.logTail.splice(0, job.logTail.length - 200);
  job.lastMessage = msg.slice(0, 300);
  broadcast({
    type: "login_progress",
    data: {
      provider: "grok",
      step: "farm",
      message: job.lastMessage,
      jobId: job.id,
    },
  });
}

function buildEnv(cfg: GrokFarmConfig): NodeJS.ProcessEnv {
  const resultsDir = path.join(farmRoot(), "results");
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(path.join(farmRoot(), "screenshots"), { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GROK_UI: "log",
    GROK_VERBOSE: "true",
    GROK_MAIL_MODE: cfg.mailMode === "tempmail" ? "tempmail" : "google",
    GROK_PASSWORD: cfg.accountPassword,
    GROK_MAX_ACCOUNTS: String(cfg.maxAccounts),
    GROK_CONCURRENT: String(cfg.concurrent),
    GROK_HEADLESS: cfg.headless ? "true" : "false",
    GROK_ACTIVATE_WEB: cfg.activateWeb ? "true" : "false",
    GROK_RESULTS_DIR: resultsDir,
    GROK_USED_EMAILS_FILE: path.join(resultsDir, "used_emails.txt"),
    GROK_SCREENSHOTS: "false",
    PYTHONUNBUFFERED: "1",
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

  if (cfg.captchaApiKey) env.GROK_CAPTCHA_API_KEY = cfg.captchaApiKey;
  if (cfg.captchaProxyUrl) env.GROK_CAPTCHA_PROXY_URL = cfg.captchaProxyUrl;

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
    throw new Error("Python interpreter not found (set ETTEUM_PYTHON)");
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
  };
  jobs.set(id, job);
  activeJobId = id;

  const startedMs = Date.now();
  const env = buildEnv(cfg);
  const mailFlag = cfg.mailMode === "tempmail" ? "tempmail" : "google";
  const args = [
    script,
    "-m", mailFlag,
    "-n", String(Math.max(1, Math.min(100, cfg.maxAccounts))),
    "-c", String(Math.max(1, Math.min(8, cfg.concurrent))),
    "-y",
  ];

  pushLog(job, `[etteum] starting farm: ${python} ${args.join(" ")}`);
  const proc = spawn(python, args, {
    cwd: farmRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  }) as ChildProcessWithoutNullStreams;

  activeProc = proc;
  job.pid = proc.pid;

  const onChunk = (buf: Buffer) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) pushLog(job, line);
    }
  };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);

  proc.on("error", (err) => {
    pushLog(job, `[etteum] spawn error: ${err.message}`);
  });

  proc.on("close", async (code) => {
    activeProc = null;
    activeJobId = null;
    job.finishedAt = new Date().toISOString();
    const batch = findNewestBatch(path.join(farmRoot(), "results"), startedMs);
    if (batch) {
      job.batchDir = batch;
      pushLog(job, `[etteum] importing batch ${path.basename(batch)}`);
      try {
        await importBatch(job, batch);
      } catch (e) {
        job.errors.push(e instanceof Error ? e.message : String(e));
      }
    } else {
      job.errors.push("No new farm batch folder found after run");
    }
    job.status = code === 0 || job.imported > 0 ? "completed" : "failed";
    if (code !== 0 && job.imported === 0) {
      job.lastMessage = `Farm exited with code ${code}`;
    }
    broadcast({
      type: job.status === "completed" ? "login_success" : "login_failed",
      data: {
        provider: "grok",
        jobId: job.id,
        message: job.lastMessage,
        imported: job.imported,
        failed: job.failed,
      },
    });
  });

  return job;
}

export function cancelGrokFarm(): boolean {
  if (!activeProc || !activeJobId) return false;
  const job = jobs.get(activeJobId);
  try {
    activeProc.kill();
  } catch { /* */ }
  if (job) {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    pushLog(job, "[etteum] cancelled by user");
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
  errors: string[];
} {
  const python = resolvePython();
  const script = farmScript();
  const errors: string[] = [];
  if (!python) errors.push("Python not found — install Python 3.11+ or set ETTEUM_PYTHON");
  if (!existsSync(script)) errors.push(`Missing farm script at ${script}`);
  return {
    ok: errors.length === 0,
    python,
    farmScript: script,
    farmScriptExists: existsSync(script),
    errors,
  };
}
