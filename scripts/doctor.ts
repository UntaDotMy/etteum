#!/usr/bin/env bun
/**
 * doctor.ts — Health diagnostic for Etteum Pool installation
 *
 *   bun scripts/doctor.ts           # human-readable report
 *   bun scripts/doctor.ts --json    # machine-readable
 *   bun scripts/doctor.ts --strict  # exit 1 on any warning (CI mode)
 *   bun scripts/doctor.ts --fix     # auto-fix every failing check
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

type Severity = "ok" | "warn" | "fail";
type Check = {
  name: string;
  severity: Severity;
  message: string;
  fix?: string;
};

const ROOT = resolve(import.meta.dir, "..");
const IS_WIN = platform() === "win32";
const checks: Check[] = [];

function pushOk(name: string, message: string, fix?: string) {
  checks.push({ name, severity: "ok", message, fix });
}
function pushWarn(name: string, message: string, fix?: string) {
  checks.push({ name, severity: "warn", message, fix });
}
function pushFail(name: string, message: string, fix?: string) {
  checks.push({ name, severity: "fail", message, fix });
}

function which(cmd: string): string | null {
  const out = spawnSync(IS_WIN ? "where" : "command", IS_WIN ? [cmd] : ["-v", cmd], {
    encoding: "utf8",
    shell: true,
  });
  if (out.status === 0) return (out.stdout || "").trim().split(/\r?\n/)[0] || null;
  return null;
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function parseEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      const k = m[1]!;
      out[k] = m[2] ?? "";
    }
  }
  return out;
}

// ── Checks ─────────────────────────────────────────────────────────────

function checkBun() {
  const path = which("bun");
  if (!path) {
    return pushFail(
      "Bun runtime",
      "bun not found on PATH",
      IS_WIN
        ? 'Install: powershell -c "irm bun.sh/install.ps1 | iex"'
        : "Install: curl -fsSL https://bun.sh/install | bash",
    );
  }
  const v = run("bun", ["--version"]);
  const version = v.stdout.trim();
  if (version === "1.3.14") {
    pushFail(
      "Bun runtime",
      `v${version} detected — this version has known issues with this project`,
      "Upgrade: bun upgrade --canary",
    );
  } else {
    pushOk("Bun runtime", `v${version} at ${path}`);
  }
}

function checkDotenv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    return pushFail(".env", "Missing .env", "Copy from .env.example and re-run installer");
  }
  const env = parseEnv(envPath);
  const required = ["PORT", "DASHBOARD_PORT", "API_KEY", "DATABASE_PATH", "ENCRYPTION_KEY"];
  for (const k of required) {
    if (!(k in env) || !env[k]) {
      pushFail(`.env: ${k}`, "missing or empty", "Copy from .env.example and re-run installer");
    }
  }
  // Optional overrides are fine; bare defaults still use scripts/auth/.venv.
  if (env.PYTHON_PATH) {
    pushOk(".env: PYTHON_PATH", `override set (${env.PYTHON_PATH})`);
  }
  if (env.ENCRYPTION_KEY === "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6") {
    pushFail(
      ".env: ENCRYPTION_KEY",
      "Still using the example placeholder key — tokens will not survive a re-encrypt",
      "Generate a new key: openssl rand -hex 16, replace ENCRYPTION_KEY in .env, then restart",
    );
  } else if (env.ENCRYPTION_KEY) {
    pushOk(".env: ENCRYPTION_KEY", "custom key set");
  }
  if (env.API_KEY === "pool-proxy-secret-key") {
    pushWarn(
      ".env: API_KEY",
      "Still default — anyone who guesses this can hit your proxy",
      "Set API_KEY in .env to a long random string",
    );
  }
  if (env.BROWSER_ENGINE === "nodriver") {
    pushWarn(
      ".env: BROWSER_ENGINE",
      "Set to 'nodriver' which is no longer supported — change to 'camoufox' or 'chromium'",
      "Set BROWSER_ENGINE=camoufox in .env",
    );
  }
}

function checkNodeModules() {
  for (const dir of ["node_modules", "dashboard/node_modules"]) {
    if (!existsSync(join(ROOT, dir))) {
      pushFail(
        `${dir}`,
        "missing",
        dir.startsWith("dashboard") ? "Run: cd dashboard && bun install" : "Run: bun install",
      );
    } else {
      pushOk(`${dir}`, "present");
    }
  }
}

/** Shared Python auth/farm interpreter under scripts/auth/.venv (not per-farm). */
function authVenvPython(): string | null {
  const venvRoot = join(ROOT, "scripts", "auth", ".venv");
  const candidates = IS_WIN
    ? [join(venvRoot, "Scripts", "python.exe"), join(venvRoot, "bin", "python")]
    : [join(venvRoot, "bin", "python"), join(venvRoot, "bin", "python3"), join(venvRoot, "Scripts", "python.exe")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function checkAuthPythonEnv() {
  const py = authVenvPython();
  if (!py) {
    pushFail(
      "Auth Python venv",
      "scripts/auth/.venv missing — shared env for provider login + farms",
      "Run: bun scripts/doctor.ts --fix   (or re-run install)",
    );
    return;
  }
  pushOk("Auth Python venv", py);

  const nodriver = run(py, ["-c", "import nodriver"]);
  if (nodriver.ok) {
    pushWarn(
      "Legacy nodriver",
      "nodriver is installed in auth venv but is not used — remove it",
      "Run: bun scripts/doctor.ts --fix",
    );
  } else {
    pushOk("Legacy nodriver", "not installed (good)");
  }
}

function checkCamoufox() {
  // Primary runtime: Python camoufox in scripts/auth/.venv (login adapters + farms).
  const py = authVenvPython();
  if (!py) {
    pushFail(
      "Camoufox (Python)",
      "auth venv missing — cannot import camoufox",
      "Run: bun scripts/doctor.ts --fix",
    );
  } else {
    const imp = run(py, ["-c", "import camoufox; import playwright"]);
    if (imp.ok) {
      pushOk("Camoufox (Python)", `importable via ${py}`);
    } else {
      pushFail(
        "Camoufox (Python)",
        "camoufox/playwright missing in scripts/auth/.venv",
        `Run: bun scripts/doctor.ts --fix   or: "${py}" -m pip install -r scripts/auth/requirements.txt && "${py}" -m camoufox fetch`,
      );
    }
  }

  // Optional TS bulk-import path (camoufox-js) — warn only, not the farm source of truth.
  const js = run("bun", ["-e", "import('camoufox-js').then(() => process.exit(0)).catch(() => process.exit(1))"]);
  if (js.ok) {
    pushOk("Camoufox (JS optional)", "camoufox-js importable");
  } else {
    pushWarn(
      "Camoufox (JS optional)",
      "camoufox-js not found — TS bulk-import stealth may fall back to chromium",
      "Run: bun install (optionalDependencies)",
    );
  }
}

function checkDashboardBuild() {
  const dist = join(ROOT, "dashboard", "dist", "index.html");
  if (!existsSync(dist)) {
    return pushFail(
      "Dashboard build",
      "dashboard/dist not found",
      "Run: cd dashboard && bun install && bun run build",
    );
  }
  const age = (Date.now() - statSync(dist).mtimeMs) / 1000 / 60 / 60 / 24;
  if (age > 30) pushWarn("Dashboard build", `Built ${age.toFixed(0)} days ago`, "Consider rebuilding: cd dashboard && bun run build");
  else pushOk("Dashboard build", "present");
}

function checkDatabase() {
  const env = parseEnv(join(ROOT, ".env"));
  const dbPath = (env.DATABASE_PATH || "./data/poolprox3.db").replace(/^\.\//, "");
  const fullPath = resolve(ROOT, dbPath);
  if (!existsSync(fullPath)) {
    pushWarn("Database", `${dbPath} not found yet (will be created on first start)`, "Run: bun src/db/migrate.ts");
  } else {
    const sizeMb = (statSync(fullPath).size / 1024 / 1024).toFixed(2);
    pushOk("Database", `${dbPath} (${sizeMb} MB)`);
  }
}

function checkCanvaWorker() {
  // canva_worker.py still uses Python for curl_cffi TLS impersonation
  const workerPath = join(ROOT, "src", "proxy", "providers", "canva_worker.py");
  if (!existsSync(workerPath)) {
    pushOk("Canva worker", "canva_worker.py not present (optional)");
    return;
  }
  const sysPy = findSystemPython();
  if (!sysPy) {
    pushWarn(
      "Canva worker",
      "Python not found — canva media generation will fail",
      "Install Python 3.10+ and: pip install curl_cffi",
    );
    return;
  }
  const cf = run(sysPy, ["-c", "import curl_cffi"]);
  if (cf.ok) {
    pushOk("Canva worker", `Python ${sysPy}, curl_cffi ready`);
  } else {
    pushFail(
      "Canva worker",
      "curl_cffi not installed",
      `Run: ${sysPy} -m pip install curl_cffi`,
    );
  }
}

function checkPrivateProviders() {
  const duoDir = join(ROOT, "src", "proxy", "providers", "gitlab-duo");
  const youmindFile = join(ROOT, "src", "proxy", "providers", "youmind.ts");

  if (existsSync(duoDir)) {
    pushOk("Provider: gitlab-duo", "present (private build)");
  } else {
    pushWarn("Provider: gitlab-duo", "folder missing", "Re-clone from private repo if you expected this provider");
  }
  if (existsSync(youmindFile)) {
    pushOk("Provider: youmind", "present (private build)");
  } else {
    pushWarn("Provider: youmind", "file missing", "Re-clone from private repo if you expected this provider");
  }
}

function checkWebSearch() {
  const env = parseEnv(join(ROOT, ".env"));
  const enabled = env.WEB_SEARCH_ENABLED !== "false";
  if (!enabled) {
    pushOk("Web search", "disabled (WEB_SEARCH_ENABLED=false)");
    return;
  }
  const searxngUrl = env.SEARXNG_URL?.trim();
  if (!searxngUrl) {
    pushOk(
      "Web search",
      "enabled, using keyless DuckDuckGo backend (zero-config)",
    );
    return;
  }
  const base = searxngUrl.replace(/\/+$/, "");
  const probeUrl = `${base}/search?q=test&format=json`;
  const curl = which("curl");
  if (!curl) {
    pushWarn("Web search (SearXNG)", "SEARXNG_URL set but curl not found to probe it", "Install curl or verify SearXNG manually");
    return;
  }
  const r = run(curl, ["-fsS", "--max-time", "8", "-H", "Accept: application/json", probeUrl]);
  if (!r.ok) {
    pushFail(
      "Web search (SearXNG)",
      `SEARXNG at ${base} not reachable`,
      "Start SearXNG (e.g. docker run -p 8080:8080 searxng/searxng) and ensure json format is enabled in settings.yml",
    );
    return;
  }
  let isJson = false;
  try { JSON.parse(r.stdout); isJson = true; } catch { /* not json */ }
  if (!isJson) {
    pushWarn(
      "Web search (SearXNG)",
      `${base} reachable but did not return JSON (format=json likely disabled in settings.yml)`,
      "In SearXNG settings.yml, under search.formats, add 'json' and restart SearXNG",
    );
    return;
  }
  pushOk("Web search (SearXNG)", `reachable at ${base}, returning JSON`);
}

// ── Auto-heal (--fix) ──────────────────────────────────────────────────

function findSystemPython(): string | null {
  const candidates = IS_WIN
    ? ["py", "python3", "python"]
    : ["python3", "python"];
  for (const cmd of candidates) {
    const py = which(cmd);
    if (!py) continue;
    const args = cmd === "py" ? ["-3", "--version"] : ["--version"];
    const v = run(py, args);
    if (!v.ok) continue;
    const pipCheck = run(py, cmd === "py" ? ["-3", "-m", "pip", "--version"] : ["-m", "pip", "--version"]);
    if (pipCheck.ok) return py;
    const ensurepip = run(py, cmd === "py" ? ["-3", "-m", "ensurepip", "--default-pip"] : ["-m", "ensurepip", "--default-pip"]);
    if (ensurepip.ok) return py;
  }
  return null;
}

function runFix(cmd: string, args: string[], name: string, timeoutSec = 300, cwd?: string): boolean {
  process.stdout.write(`  \x1b[2m→ ${name}...\x1b[0m`);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutSec * 1000, cwd });
  if (r.status === 0) {
    process.stdout.write(" \x1b[32mOK\x1b[0m\n");
    return true;
  }
  const err = r.stderr?.trim() || r.stdout?.slice(-200).trim() || "unknown error";
  process.stdout.write(` \x1b[31mFAILED\x1b[0m\n    \x1b[2m${err.slice(0, 300)}\x1b[0m\n`);
  return false;
}

function autoFix() {
  console.log(`\n\x1b[1m🔧 Auto-fix mode\x1b[0m\n`);

  // 1. node_modules
  for (const dir of ["node_modules", "dashboard/node_modules"]) {
    if (!existsSync(join(ROOT, dir))) {
      process.stdout.write(`  \x1b[33m! ${dir} missing — installing...\x1b[0m\n`);
      if (dir.startsWith("dashboard")) {
        runFix("bun", ["install"], "bun install (dashboard)", 300, join(ROOT, "dashboard"));
      } else {
        runFix("bun", ["install"], "bun install (root)", 300);
      }
    }
  }

  // 2. Dashboard build
  if (!existsSync(join(ROOT, "dashboard", "dist", "index.html"))) {
    process.stdout.write("  \x1b[33m! Dashboard build missing — building...\x1b[0m\n");
    runFix("bun", ["run", "build"], "bun run build (dashboard)", 300, join(ROOT, "dashboard"));
  }

  // 3. Shared auth/farm Python venv + Camoufox (source of truth for browser automation)
  const venvRoot = join(ROOT, "scripts", "auth", ".venv");
  const reqFile = join(ROOT, "scripts", "auth", "requirements.txt");
  let venvPy = authVenvPython();
  if (!venvPy) {
    process.stdout.write("  \x1b[33m! Creating scripts/auth/.venv...\x1b[0m\n");
    const hostPy = findSystemPython();
    if (!hostPy) {
      process.stdout.write("  \x1b[31m✗ No system Python found — install Python 3.10+\x1b[0m\n");
    } else {
      const isPyLauncher = hostPy === "py" || /(?:^|[\\/])py(?:\.exe)?$/i.test(hostPy);
      const ok = isPyLauncher
        ? runFix(hostPy, ["-3", "-m", "venv", venvRoot], "create auth venv", 120)
        : runFix(hostPy, ["-m", "venv", venvRoot], "create auth venv", 120);
      if (ok) venvPy = authVenvPython();
    }
  }

  if (venvPy && existsSync(reqFile)) {
    process.stdout.write("  \x1b[33m! Installing scripts/auth requirements (camoufox[geoip] + playwright)...\x1b[0m\n");
    runFix(venvPy, ["-m", "pip", "install", "--no-input", "--upgrade", "pip", "wheel"], "pip upgrade", 120);
    runFix(venvPy, ["-m", "pip", "install", "--no-input", "-r", reqFile], "pip install auth requirements", 300);

    // Remove legacy nodriver — never uninstall camoufox.
    const hasNodriver = run(venvPy, ["-c", "import nodriver"]);
    if (hasNodriver.ok) {
      process.stdout.write("  \x1b[33m! Removing legacy nodriver from auth venv...\x1b[0m\n");
      runFix(venvPy, ["-m", "pip", "uninstall", "-y", "--no-input", "nodriver"], "uninstall nodriver", 60);
    }

    if (process.env.ETTEUM_SKIP_BROWSERS !== "1") {
      process.stdout.write("  \x1b[33m! Fetching Camoufox browser binary...\x1b[0m\n");
      runFix(venvPy, ["-m", "camoufox", "fetch"], "camoufox fetch", 300);
    } else {
      process.stdout.write("  \x1b[2m→ ETTEUM_SKIP_BROWSERS=1 — skipped camoufox fetch\x1b[0m\n");
    }
  }

  // 4. Canva worker: install curl_cffi if Python is available
  const workerPath = join(ROOT, "src", "proxy", "providers", "canva_worker.py");
  if (existsSync(workerPath)) {
    const sysPy = findSystemPython();
    if (sysPy) {
      const cf = run(sysPy, ["-c", "import curl_cffi"]);
      if (!cf.ok) {
        process.stdout.write("  \x1b[33m! Installing curl_cffi for Canva worker...\x1b[0m\n");
        runFix(sysPy, ["-m", "pip", "install", "curl_cffi"], "pip install curl_cffi", 120);
      }
    }
  }

  // 5. .env: BROWSER_ENGINE nodriver → camoufox (do not strip PYTHON_PATH)
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    const env = parseEnv(envPath);
    if (env.BROWSER_ENGINE === "nodriver") {
      process.stdout.write("  \x1b[33m! Fixing BROWSER_ENGINE=nodriver → camoufox...\x1b[0m\n");
      let content = readFileSync(envPath, "utf8");
      content = content.replace(/^BROWSER_ENGINE=nodriver$/m, "BROWSER_ENGINE=camoufox");
      Bun.write(envPath, content);
      process.stdout.write("  \x1b[2m→ Fixed BROWSER_ENGINE\x1b[0m \x1b[32mOK\x1b[0m\n");
    }
  }

  // 6. Database migrations
  process.stdout.write("  \x1b[33m! Running database migrations...\x1b[0m\n");
  runFix("bun", ["src/db/migrate.ts"], "db migrate", 60);

  console.log("");
}

// ── Main ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const strict = args.includes("--strict");
const wantFix = args.includes("--fix");

if (wantFix) {
  autoFix();
  checks.length = 0;
}

checkBun();
checkDotenv();
checkNodeModules();
checkAuthPythonEnv();
checkCamoufox();
checkDashboardBuild();
checkDatabase();
checkCanvaWorker();
checkPrivateProviders();
checkWebSearch();

const okCount = checks.filter((c) => c.severity === "ok").length;
const warnCount = checks.filter((c) => c.severity === "warn").length;
const failCount = checks.filter((c) => c.severity === "fail").length;

if (wantJson) {
  console.log(JSON.stringify({ ok: okCount, warn: warnCount, fail: failCount, checks }, null, 2));
} else {
  const ICON = { ok: "✓", warn: "!", fail: "✗" } as const;
  const COLOR = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m" } as const;
  const RESET = "\x1b[0m";

  console.log(`\n\x1b[1m🩺 Etteum Pool — Doctor Report\x1b[0m\n`);
  for (const c of checks) {
    console.log(`  ${COLOR[c.severity]}${ICON[c.severity]}${RESET}  \x1b[1m${c.name}\x1b[0m — ${c.message}`);
    if (c.fix && c.severity !== "ok") {
      console.log(`     \x1b[2m→ ${c.fix}\x1b[0m`);
    }
  }
  console.log(
    `\n  \x1b[32m${okCount} ok\x1b[0m   \x1b[33m${warnCount} warn\x1b[0m   \x1b[31m${failCount} fail\x1b[0m\n`,
  );
  if (failCount === 0 && warnCount === 0) {
    console.log("  \x1b[32m\x1b[1m✓ All checks passed — you're ready to roll.\x1b[0m\n");
  } else if (failCount === 0) {
    console.log("  \x1b[33mInstallation works but has warnings. Read them above.\x1b[0m\n");
  } else {
    console.log("  \x1b[31m\x1b[1m✗ Installation has errors. Run with --fix to auto-heal.\x1b[0m\n");
  }
}

if (failCount > 0) process.exit(1);
if (strict && warnCount > 0) process.exit(2);
