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

/** True if this interpreter can import camoufox (farm requirement). */
function pythonHasCamoufox(pythonExe: string): boolean {
  try {
    execFileSync(
      pythonExe,
      ["-c", "import camoufox; import playwright"],
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch {
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
  push(config.pythonPath);
  push(process.env.PYTHON_PATH);
  push(process.env.ETTEUM_PYTHON);
  push(process.env.BATCHER_PYTHON);

  const authVenv =
    process.platform === "win32"
      ? path.join(config.authScriptCwd, ".venv", "Scripts", "python.exe")
      : path.join(config.authScriptCwd, ".venv", "bin", "python");
  push(authVenv);

  // System installs that commonly have camoufox when install.ps1 ran pip global.
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || "";
    if (home) {
      for (const ver of ["Python312", "Python311", "Python310"]) {
        push(path.join(home, "AppData", "Local", "Programs", "Python", ver, "python.exe"));
      }
    }
  }

  // PATH lookup last among "shared" interpreters.
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
      // bare name — still try import
      if (pythonHasCamoufox(c)) return c;
      continue;
    }
    if (existsSync(c) && pythonHasCamoufox(c)) return c;
  }

  // Farm-local venv only if someone created it (optional, not required).
  const farmVenv =
    process.platform === "win32"
      ? path.join(farmRoot(), ".venv", "Scripts", "python.exe")
      : path.join(farmRoot(), ".venv", "bin", "python");
  if (existsSync(farmVenv) && pythonHasCamoufox(farmVenv)) return farmVenv;

  // Fall back to etteum pythonPath even without camoufox so the error message
  // from farm.py / our validate is clear and points at scripts/auth deps.
  if (config.pythonPath) return config.pythonPath;
  return candidates[0] ?? null;
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
  const raw = line.replace(/\r/g, "").trimEnd();
  if (!raw) return;

  // Frame relay from farm.py (ETTEUM_JSON:{"type":"frame","base64":...,"format":"jpeg"})
  // Same contract as enowxai: headless browser + screenshot loop → Browser Logs.
  if (raw.startsWith("ETTEUM_JSON:")) {
    try {
      const payload = JSON.parse(raw.slice("ETTEUM_JSON:".length)) as {
        type?: string;
        base64?: string;
        format?: string;
      };
      if (payload.type === "frame" && payload.base64) {
        updateFrame(job.id, payload.base64, payload.format || "jpeg");
        broadcast({
          type: "browser_frame",
          data: {
            sessionId: job.id,
            provider: "grok",
            format: payload.format || "jpeg",
          },
        });
        return; // never put multi-KB base64 into logTail
      }
    } catch {
      /* fall through as normal log */
    }
  }

  const msg = raw;
  job.logTail.push(msg);
  if (job.logTail.length > 200) job.logTail.splice(0, job.logTail.length - 200);
  job.lastMessage = msg.slice(0, 300);

  const sid = job.id;
  const isErr = /error|failed|traceback|exception/i.test(msg);
  appendStep(sid, isErr ? "error" : "farm", job.lastMessage, "grok");
  updatePhase(sid, isErr ? "error" : "farming", job.lastMessage);

  // Only push meaningful progress to the global activity stream (avoid flooding
  // with every farm print line — steps already live on the session card).
  const noteworthy =
    isErr ||
    /\[etteum\]|BATCH|Mail mode|Batch|Import|succeed|fail|ERROR|starting farm|closing|signup|OAuth|probe|token/i.test(
      msg,
    );
  if (noteworthy) {
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
    // Headless OS window (no popup) — frames still stream via screenshot relay.
    GROK_HEADLESS: "true",
    ETTEUM_FRAME_RELAY: "true",
    ETTEUM_FRAME_INTERVAL: "1.5",
    GROK_ACTIVATE_WEB: cfg.activateWeb ? "true" : "false",
    GROK_RESULTS_DIR: resultsDir,
    GROK_USED_EMAILS_FILE: path.join(resultsDir, "used_emails.txt"),
    GROK_SCREENSHOTS: "false",
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
    throw new Error(
      "Python not found. Use etteum's auth env: scripts/auth/.venv " +
        "(install: python -m venv scripts/auth/.venv && scripts/auth/.venv/Scripts/pip install -r scripts/auth/requirements.txt)",
    );
  }
  if (!pythonHasCamoufox(python)) {
    throw new Error(
      `Selected Python lacks camoufox: ${python}. ` +
        `Install etteum auth deps: "${python}" -m pip install -r scripts/auth/requirements.txt`,
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

  // Register in Browser Logs so the dashboard has a live session card + step timeline.
  registerSession({
    sessionId: id,
    accountId: 0,
    // Display label for Browser Logs (not a real mailbox).
    email: "Grok Farm",
    provider: "grok",
    phase: "starting",
    lastMessage: "Starting Grok farm…",
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

  pushLog(job, `[etteum] starting farm (always headless): ${python}`);
  pushLog(job, `[etteum] args: ${args.slice(1).join(" ")}`);
  const proc = spawn(python, args, {
    cwd: farmRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  activeProc = proc;
  job.pid = proc.pid;
  // Attach proc for cancel from Browser Logs.
  const sess = getSession(id);
  if (sess) sess.proc = proc;

  const onChunk = (buf: Buffer) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) pushLog(job, line);
    }
  };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);

  proc.on("error", (err) => {
    pushLog(job, `[etteum] spawn error: ${err.message}`);
    updatePhase(id, "failed", err.message);
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
    } else if (code !== 0) {
      const hint =
        job.logTail.some((l) => /camoufox not installed/i.test(l))
          ? " Install deps: cd scripts/auth/grok-farm && python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt"
          : "";
      job.errors.push(`No new farm batch folder found after run (exit ${code}).${hint}`);
      pushLog(job, `[etteum] farm failed (exit ${code}).${hint}`);
    } else {
      job.errors.push("No new farm batch folder found after run");
    }
    job.status = code === 0 || job.imported > 0 ? "completed" : "failed";
    if (code !== 0 && job.imported === 0) {
      job.lastMessage = job.errors[job.errors.length - 1] || `Farm exited with code ${code}`;
    }
    updatePhase(id, job.status === "completed" ? "complete" : "failed", job.lastMessage || job.status);
    broadcast({
      type: job.status === "completed" ? "login_success" : "login_failed",
      data: {
        provider: "grok",
        jobId: job.id,
        email: `grok-farm@${job.id}`,
        sessionId: job.id,
        message: job.lastMessage,
        error: job.status === "failed" ? job.lastMessage : undefined,
        imported: job.imported,
        failed: job.failed,
      },
    });
    broadcast({
      type: "browser_frame",
      data: { sessionId: job.id, terminal: true, phase: job.status },
    });
    // Keep session visible in Bot Logs for a while (don't delete immediately).
  });

  broadcast({
    type: "browser_frame",
    data: { sessionId: id, provider: "grok", phase: "starting" },
  });

  return job;
}

export function cancelGrokFarm(): boolean {
  if (!activeProc || !activeJobId) return false;
  const job = jobs.get(activeJobId);
  const sid = activeJobId;
  try {
    activeProc.kill();
  } catch { /* */ }
  if (job) {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    pushLog(job, "[etteum] cancelled by user");
    updatePhase(sid, "cancelled", "cancelled by user");
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
        `Install into etteum auth env: ` +
        `"${python}" -m pip install -r scripts/auth/requirements.txt`,
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
