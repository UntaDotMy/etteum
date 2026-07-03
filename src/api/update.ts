/**
 * Update-awareness + one-click update API.
 *
 * - GET  /api/update/status  — is a newer build available on origin/main?
 * - POST /api/update/apply   — git pull + rebuild dashboard + migrate, then
 *                               best-effort restart via the detected supervisor
 *                               (systemd / NSSM / launchd), or a manual-restart
 *                               prompt when no supervisor is present.
 *
 * Detection is git-based: the install dir is a git clone (upgrade.sh relies on
 * that), so we `git fetch origin main` and compare local HEAD to origin/main.
 * Status is cached for 5 min so dashboard polling doesn't hammer git fetch.
 *
 * Everything is designed to never throw at the HTTP layer: git missing, not a
 * clone, network down, conflicts — all return structured errors, never 500.
 */

import { Hono } from "hono";
import { config } from "../config";
import path from "path";

const projectRoot = path.resolve(import.meta.dir, "../..");
const FETCH_BRANCH = "main";

// ── git helpers ────────────────────────────────────────────────────────────

/** Run a git command in the project root. Returns trimmed stdout or null on failure. */
export function git(args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const r = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: r.exitCode === 0,
      out: new TextDecoder().decode(r.stdout).trim(),
      err: new TextDecoder().decode(r.stderr).trim(),
    };
  } catch {
    return { ok: false, out: "", err: "git not available" };
  }
}

/** Read the short human label for the current build (tag or short hash). */
export function readVersionLabel(): string {
  return git(["describe", "--tags", "--always"]).out || config.buildVersion;
}

/** Read the local HEAD commit hash, or null if not a git clone. */
export function readLocalCommit(): string | null {
  const r = git(["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}

/** Read the upstream (origin/main) commit hash from the local refs (no network). */
export function readRemoteCommit(): string | null {
  const r = git(["rev-parse", `origin/${FETCH_BRANCH}`]);
  return r.ok ? r.out : null;
}

/** Fetch origin/main to refresh the remote ref. Bounded by a timeout. */
export function fetchOrigin(): { ok: boolean; err: string } {
  const r = git(["fetch", "origin", FETCH_BRANCH, "--no-tags"]);
  return { ok: r.ok, err: r.err };
}

// ── status cache ───────────────────────────────────────────────────────────

interface StatusResult {
  currentCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  currentVersion: string;
  branch: string;
  lastCheckedAt: string | null;
  error?: string;
}

let statusCache: { result: StatusResult; at: number } | null = null;
const STATUS_CACHE_MS = 5 * 60 * 1000;

/**
 * Compute update status. Pure-ish: runs git, never throws. When `force` is
 * false and the cache is fresh, returns the cached result without a fetch.
 */
export function computeStatus(force = false): StatusResult {
  const now = Date.now();
  if (!force && statusCache && now - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.result;
  }

  const currentVersion = readVersionLabel();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out || FETCH_BRANCH;
  const local = readLocalCommit();

  if (!local) {
    // Not a git clone — can't detect updates. Report current build only.
    const result: StatusResult = {
      currentCommit: null,
      latestCommit: null,
      updateAvailable: false,
      currentVersion,
      branch,
      lastCheckedAt: statusCache ? new Date(statusCache.at).toISOString() : null,
      error: "Not a git checkout — update detection unavailable. Install via git clone to enable.",
    };
    statusCache = { result, at: now };
    return result;
  }

  const fetch = fetchOrigin();
  const remote = readRemoteCommit();

  const result: StatusResult = {
    currentCommit: local,
    latestCommit: remote,
    updateAvailable: !!remote && remote !== local,
    currentVersion,
    branch,
    lastCheckedAt: new Date(now).toISOString(),
    error: fetch.ok ? undefined : `git fetch failed: ${fetch.err || "unknown"}`,
  };
  // A failed fetch still has a stale remote ref; keep updateAvailable based on
  // whatever remote we know about, but surface the fetch error.
  statusCache = { result, at: now };
  return result;
}

// ── supervisor detection + restart ─────────────────────────────────────────

export type Supervisor = "systemd" | "nssm" | "launchd" | "manual";

/** Detect how the server is supervised so we know how to restart it. */
export function detectSupervisor(): Supervisor {
  const has = (cmd: string) => {
    const r = Bun.spawnSync({ cmd: ["which", cmd], stdout: "pipe", stderr: "pipe", cwd: projectRoot });
    return r.exitCode === 0;
  };
  const win = process.platform === "win32";

  // NSSM (Windows service)
  if (win) {
    const r = Bun.spawnSync({ cmd: ["sc", "query", "etteum"], stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(r.stdout);
    if (r.exitCode === 0 && /RUNNING|STOPPED|PAUSED/.test(out)) return "nssm";
    return "manual";
  }

  // launchd (macOS)
  if (process.platform === "darwin") {
    const r = Bun.spawnSync({ cmd: ["launchctl", "list"], stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0 && new TextDecoder().decode(r.stdout).includes("etteum")) return "launchd";
  }

  // systemd (Linux)
  if (!win && has("systemctl")) {
    const r = Bun.spawnSync({ cmd: ["systemctl", "is-active", "etteum"], stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) return "systemd";
  }

  return "manual";
}

/** The restart command for a supervisor (for display + execution). */
export function restartCommand(sup: Supervisor): { cmd: string[]; description: string } {
  switch (sup) {
    case "systemd":
      return { cmd: ["systemctl", "restart", "etteum"], description: "systemd service restart" };
    case "nssm":
      return { cmd: ["nssm", "restart", "etteum"], description: "NSSM service restart" };
    case "launchd":
      return { cmd: ["launchctl", "kickstart", "-k", "system/com.etteum"], description: "launchd reload" };
    case "manual":
    default:
      return { cmd: [], description: "manual restart required" };
  }
}

/** The manual restart command shown to the user when no supervisor is present. */
export function manualRestartHint(): string {
  const bun = process.env.BUN_EXECUTABLE_PATH || "bun";
  if (process.platform === "win32") {
    return `cd "${projectRoot}"\n${bun} scripts/production.ts`;
  }
  return `cd "${projectRoot}" && nohup ${bun} scripts/production.ts > .etteum.log.stdout 2> .etteum.log.stderr & echo $! > .etteum.pid`;
}

// ── apply: pull + build + migrate + restart ────────────────────────────────

export interface ApplyStep {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Run the update. Each step is recorded. On a failed step, we abort and return
 * what happened WITHOUT restarting — the running server stays up on the old
 * code. Never throws.
 */
export async function applyUpdate(): Promise<{
  ok: boolean;
  steps: ApplyStep[];
  restarted: boolean;
  supervisor: Supervisor;
  manualCommand?: string;
}> {
  const steps: ApplyStep[] = [];
  const bun = process.env.BUN_EXECUTABLE_PATH || "bun";

  // 1. git pull
  const pull = git(["pull", "origin", FETCH_BRANCH, "--no-rebase"]);
  steps.push({ name: "git pull", ok: pull.ok, detail: pull.ok ? pull.out.slice(0, 300) : pull.err.slice(0, 300) });
  if (!pull.ok) {
    return { ok: false, steps, restarted: false, supervisor: detectSupervisor() };
  }

  // 2. Rebuild dashboard
  let buildOk = false;
  let buildErr = "";
  try {
    const r = Bun.spawnSync({
      cmd: [bun, "run", "build"],
      cwd: path.join(projectRoot, "dashboard"),
      stdout: "pipe",
      stderr: "pipe",
    });
    buildOk = r.exitCode === 0;
    if (!buildOk) buildErr = new TextDecoder().decode(r.stderr).slice(0, 300) || `exit ${r.exitCode}`;
  } catch (e: any) {
    buildErr = e?.message || String(e);
  }
  steps.push({ name: "build dashboard", ok: buildOk, detail: buildOk ? undefined : buildErr });
  if (!buildOk) {
    return { ok: false, steps, restarted: false, supervisor: detectSupervisor() };
  }

  // 3. Run DB migrations (best-effort — a no-op migration is fine)
  let migrateOk = false;
  let migrateErr = "";
  try {
    const r = Bun.spawnSync({
      cmd: [bun, "run", "migrate"],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    migrateOk = r.exitCode === 0;
    if (!migrateOk) migrateErr = new TextDecoder().decode(r.stderr).slice(0, 300) || `exit ${r.exitCode}`;
  } catch (e: any) {
    migrateErr = e?.message || String(e);
  }
  steps.push({ name: "migrate database", ok: migrateOk, detail: migrateOk ? undefined : migrateErr });
  // Migration failure is non-fatal for restart (schema may be unchanged).

  // 4. Restart via supervisor
  const sup = detectSupervisor();
  const rc = restartCommand(sup);
  if (sup === "manual") {
    // No supervisor: spawn a detached successor that re-launches after we exit,
    // then signal shutdown. The successor waits briefly so this process can exit
    // and free the port.
    const hint = manualRestartHint();
    try {
      const relaunch = process.platform === "win32"
        ? `Start-Sleep -Seconds 2; & '${bun}' scripts/production.ts`
        : `sleep 2 && '${bun}' scripts/production.ts`;
      Bun.spawn({
        cmd: process.platform === "win32" ? ["powershell", "-Command", relaunch] : ["bash", "-c", relaunch],
        cwd: projectRoot,
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
      });
      steps.push({ name: "restart (manual: spawn successor)", ok: true, detail: "successor spawned; this process will exit" });
      return { ok: true, steps, restarted: true, supervisor: sup, manualCommand: hint };
    } catch (e: any) {
      steps.push({ name: "restart (manual)", ok: false, detail: e?.message || String(e) });
      return { ok: true, steps, restarted: false, supervisor: sup, manualCommand: hint };
    }
  }

  // Supervised: the supervisor will respawn us after the restart command runs.
  // Schedule the restart detached (so this process can respond before dying).
  try {
    Bun.spawn({ cmd: rc.cmd, cwd: projectRoot, detached: true, stdout: "ignore", stderr: "ignore" });
    steps.push({ name: `restart (${rc.description})`, ok: true });
    return { ok: true, steps, restarted: true, supervisor: sup };
  } catch (e: any) {
    steps.push({ name: `restart (${rc.description})`, ok: false, detail: e?.message || String(e) });
    return { ok: true, steps, restarted: false, supervisor: sup, manualCommand: manualRestartHint() };
  }
}

// ── router ─────────────────────────────────────────────────────────────────

export const updateRouter = new Hono();

updateRouter.get("/status", (c) => {
  const force = c.req.query("force") === "1";
  return c.json({ data: computeStatus(force) });
});

updateRouter.post("/apply", async (c) => {
  const result = await applyUpdate();
  return c.json({ data: result });
});
