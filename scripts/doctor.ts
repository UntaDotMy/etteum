#!/usr/bin/env bun
/**
 * doctor.ts — Health diagnostic for Etteum Pool installation
 *
 * Run this any time something feels off. It validates every prerequisite,
 * config value, and runtime asset, then prints a remediation hint when
 * something is missing or broken.
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

/**
 * Auto-detect the venv Python path.
 * A venv created on Linux has bin/python; one created on Windows has
 * Scripts/python.exe. We check both regardless of the current platform
 * so the doctor works even when a venv was created in WSL and the server
 * is running under native Windows (or vice-versa).
 */
function venvPython(): string | null {
  const venvRoot = join(ROOT, "scripts", "auth", ".venv");
  const candidates = [
    join(venvRoot, "Scripts", "python.exe"),  // Windows venv
    join(venvRoot, "bin", "python"),            // Linux/macOS venv
    join(venvRoot, "bin", "python3"),           // Linux/macOS venv (alt)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** The venv's pip path (for remediation hints). */
function venvPipHint(): string {
  const py = venvPython();
  if (!py) return "scripts/auth/.venv/bin/pip";
  return py.replace(/python(?:3)?(?:\.exe)?$/, "pip");
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
      IS_WIN
        ? 'Upgrade canary: bun upgrade --canary'
        : "Upgrade canary: bun upgrade --canary",
    );
  } else {
    pushOk("Bun runtime", `v${version} at ${path}`);
  }
}

function checkPython() {
  const env = parseEnv(join(ROOT, ".env"));
  const venvPy = venvPython();

  if (!venvPy) {
    return pushFail(
      "Python venv",
      `No venv found at scripts/auth/.venv/ (checked Scripts/python.exe and bin/python)`,
      "Run with --fix to auto-create, or manually: python -m venv scripts/auth/.venv && "
      + `${IS_WIN ? "scripts/auth/.venv/Scripts/pip" : "scripts/auth/.venv/bin/pip"} install -r scripts/auth/requirements.txt`,
    );
  }
  const v = run(venvPy, ["--version"]);
  if (!v.ok) {
    return pushFail("Python venv", `Cannot execute ${venvPy}`, "Run with --fix to rebuild the venv");
  }
  pushOk("Python venv", `${v.stdout.trim() || v.stderr.trim()} at ${venvPy}`);

  // PYTHON_PATH config sanity
  const cfgPath = (env.PYTHON_PATH || "").trim();
  if (cfgPath && !existsSync(cfgPath)) {
    pushWarn(
      "PYTHON_PATH config",
      `PYTHON_PATH=${cfgPath} does not exist`,
      "Clear it (auto-detect): set PYTHON_PATH= in .env",
    );
  }
}

function checkPyPackages() {
  const venvPy = venvPython();
  if (!venvPy) return;
  const required = ["camoufox", "playwright", "aiohttp", "httpx", "cbor2", "pydantic"];
  for (const pkg of required) {
    const r = run(venvPy, ["-c", `import ${pkg}`]);
    if (!r.ok) {
      pushFail(
        `Python pkg: ${pkg}`,
        `Import failed`,
        `Run: ${venvPipHint()} install -r scripts/auth/requirements.txt`,
      );
    } else {
      pushOk(`Python pkg: ${pkg}`, "import ok");
    }
  }
}

function checkBrowsers() {
  const venvPy = venvPython();
  if (!venvPy) return;

  // Playwright Chromium
  const pw = run(venvPy, [
    "-c",
    "from playwright.sync_api import sync_playwright;\n"
    + "with sync_playwright() as p:\n"
    + "  print(p.chromium.executable_path)",
  ]);
  if (pw.ok && pw.stdout.trim() && existsSync(pw.stdout.trim())) {
    pushOk("Playwright Chromium", "installed");
  } else {
    pushFail(
      "Playwright Chromium",
      "Browser binary missing",
      `Run: ${venvPy} -m playwright install chromium`,
    );
  }

  // Camoufox
  const cf = run(venvPy, ["-c", "import camoufox.utils as u; print(u.installed_verstr() or '')"]);
  if (cf.ok && cf.stdout.trim()) {
    pushOk("Camoufox browser", `installed (${cf.stdout.trim()})`);
  } else {
    pushFail(
      "Camoufox browser",
      "Browser not fetched",
      `Run: ${venvPy} -m camoufox fetch`,
    );
  }
}

function checkDotenv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    return pushFail(".env", "Missing .env", "Copy from .env.example and re-run installer");
  }
  const env = parseEnv(envPath);
  const required = ["PORT", "DASHBOARD_PORT", "API_KEY", "DATABASE_PATH", "ENCRYPTION_KEY", "AUTH_SCRIPT_PATH", "AUTH_SCRIPT_CWD"];
  for (const k of required) {
    if (!(k in env) || !env[k]) {
      pushWarn(`.env: ${k}`, "missing or empty", "Copy from .env.example and re-run installer");
    }
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
  if (age > 30) pushWarn("Dashboard build", `Built ${age.toFixed(0)} days ago`, "Consider rebuilding: bun run build");
  else pushOk("Dashboard build", "present");
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

function checkDataDir() {
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

function checkPrivateProviders() {
  // Private build only — these are optional but warn if a recent clone is missing them
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

/**
 * Built-in web_search shim health.
 *
 * - If WEB_SEARCH_ENABLED is off → report as off (ok).
 * - If SEARXNG_URL is set → probe it (?q=test&format=json) and report
 *   reachability + JSON. This catches a missing/stopped SearXNG container
 *   before it silently degrades searches.
 * - If SEARXNG_URL is unset → the keyless DuckDuckGo fallback is active;
 *   report ok with a hint that SearXNG is the optional robust upgrade.
 */
function checkWebSearch() {
  const env = parseEnv(join(ROOT, ".env"));
  const enabled = env.WEB_SEARCH_ENABLED !== "false"; // default on
  if (!enabled) {
    pushOk("Web search", "disabled (WEB_SEARCH_ENABLED=false)");
    return;
  }
  const searxngUrl = env.SEARXNG_URL?.trim();
  if (!searxngUrl) {
    pushOk(
      "Web search",
      "enabled, using keyless DuckDuckGo backend (zero-config)",
      "For more robust results, run SearXNG and set SEARXNG_URL — see README 'Web search'",
    );
    return;
  }
  // Probe the configured SearXNG instance.
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
  // Confirm it actually returned JSON (not the HTML theme, which means format=json is disabled).
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

/** Find a system Python via PATH (any 3.10-3.12). */
function findSystemPython(): string | null {
  const candidates = IS_WIN
    ? ["python", "python3", "py", "py -3"]
    : ["python3", "python"];
  for (const cmd of candidates) {
    const py = which(cmd === "py -3" ? "py" : cmd);
    if (py) {
      const v = run(cmd === "py -3" ? "py" : py, cmd === "py -3" ? ["-3", "--version"] : ["--version"]);
      if (v.ok) return py;
    }
  }
  return null;
}

/** Run a fix step with a timeout. Returns true if it succeeded. */
function runFix(cmd: string, args: string[], name: string, timeoutSec = 300): boolean {
  process.stdout.write(`  \x1b[2m→ ${name}...\x1b[0m`);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutSec * 1000 });
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

  // ── 1. Venv ──────────────────────────────────────────────────────────
  const venvPy = venvPython();
  const venvRoot = join(ROOT, "scripts", "auth", ".venv");
  let venvOk = venvPy !== null && run(venvPy, ["--version"]).ok;

  if (!venvOk) {
    process.stdout.write("  \x1b[33m! Venv broken or missing — rebuilding...\x1b[0m\n");
    const sysPy = findSystemPython();
    if (!sysPy) {
      console.log("  \x1b[31m✗ No system Python found on PATH. Install Python 3.10–3.12 first.\x1b[0m\n");
      process.exit(1);
    }
    // Remove broken venv
    if (existsSync(venvRoot)) {
      // Windows: use rm -rf via shell; Bun's fs.rmSync can struggle with long paths
      const rm = spawnSync(IS_WIN ? "cmd" : "rm", IS_WIN ? ["/c", "rmdir", "/s", "/q", venvRoot] : ["-rf", venvRoot], { encoding: "utf8" });
      if (rm.status !== 0) {
        // fallback: try recursive removal
        try { import("node:fs").then(fs => (fs as any).rmSync(venvRoot, { recursive: true, force: true })); } catch { /* best effort */ }
      }
    }
    // Recreate venv
    if (!runFix(sysPy, ["-m", "venv", venvRoot], "Creating venv", 60)) {
      console.log("  \x1b[31m✗ Failed to create venv. Try: re-run installer.\x1b[0m\n");
      process.exit(1);
    }
    // Re-evaluate
    const newPy = venvPython();
    if (!newPy || !run(newPy, ["--version"]).ok) {
      console.log("  \x1b[31m✗ Venv created but python not found — platform mismatch?\x1b[0m\n");
      process.exit(1);
    }
    venvOk = true;
  }

  const pipPath = venvPipHint();
  const vpy = venvPython()!;

  // ── 2. Python packages ──────────────────────────────────────────────
  const required = ["camoufox", "playwright", "aiohttp", "httpx", "cbor2", "pydantic"];
  const missingPkgs = required.filter(pkg => !run(vpy, ["-c", `import ${pkg}`]).ok);
  if (missingPkgs.length > 0) {
    process.stdout.write(`  \x1b[33m! Installing ${missingPkgs.length} missing packages...\x1b[0m\n`);
    runFix(pipPath, ["install", "-r", join(ROOT, "scripts/auth/requirements.txt")], "pip install", 300);
    // Verify each
    for (const pkg of missingPkgs) {
      if (!run(vpy, ["-c", `import ${pkg}`]).ok) {
        console.log(`    \x1b[31m✗ ${pkg} still fails to import\x1b[0m`);
      }
    }
  }

  // ── 3. Playwright Chromium ──────────────────────────────────────────
  const pw = run(vpy, ["-c", "from playwright.sync_api import sync_playwright;\nwith sync_playwright() as p:\n  print(p.chromium.executable_path)"]);
  if (!(pw.ok && pw.stdout.trim() && existsSync(pw.stdout.trim()))) {
    process.stdout.write("  \x1b[33m! Installing Playwright Chromium...\x1b[0m\n");
    runFix(vpy, ["-m", "playwright", "install", "chromium"], "playwright install chromium", 300);
  }

  // ── 4. Camoufox browser ─────────────────────────────────────────────
  const cf = run(vpy, ["-c", "import camoufox.utils as u; print(u.installed_verstr() or '')"]);
  if (!(cf.ok && cf.stdout.trim())) {
    process.stdout.write("  \x1b[33m! Fetching Camoufox browser...\x1b[0m\n");
    runFix(vpy, ["-m", "camoufox", "fetch"], "camoufox fetch", 300);
  }

  console.log("");
}

// ── Main ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const strict = args.includes("--strict");
const wantFix = args.includes("--fix");

if (wantFix) {
  autoFix();
  // Re-run all checks after fixing
  checks.length = 0;
}

checkBun();
checkPython();
checkPyPackages();
checkBrowsers();
checkDotenv();
checkNodeModules();
checkDashboardBuild();
checkDataDir();
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
    console.log("  \x1b[31m\x1b[1m✗ Installation has errors. Run remediation hints above.\x1b[0m\n");
  }
}

if (failCount > 0) process.exit(1);
if (strict && warnCount > 0) process.exit(2);
