#!/usr/bin/env bun
/**
 * preflight.ts — Lightweight smoke test invoked by install.sh / install.ps1
 * after the install completes. Verifies critical pieces and exits 0/1.
 *
 * For a fuller diagnostic, use `bun run doctor` instead.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  findAuthVenvPython,
  probeAuthFlowImports,
  probeCanvaWorkerImports,
  resolveAuthPython,
} from "../src/utils/python";

const ROOT = resolve(import.meta.dir, "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let failed = 0;
function check(name: string, ok: boolean, hint?: string) {
  if (ok) {
    console.log(`  ${GREEN}✓${RESET} ${name}`);
  } else {
    console.log(`  ${RED}✗${RESET} ${name}${hint ? `\n      → ${hint}` : ""}`);
    failed++;
  }
}

console.log("\n  Etteum Pool — Preflight\n");

// 1. Bun
const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8" });
const bunVersion = bunCheck.status === 0 ? bunCheck.stdout.trim() : "";
if (bunVersion === "1.3.14") {
  const hint = "Run: bun upgrade --canary";
  check("Bun runtime", false, hint);
} else {
  check("Bun runtime", bunCheck.status === 0, "Re-run installer or install Bun manually");
}

// 2. .env exists
const envFile = join(ROOT, ".env");
check(".env file", existsSync(envFile), "Re-run installer to recreate .env");

// 3. node_modules
check("Root node_modules", existsSync(join(ROOT, "node_modules")), "Run: bun install");
check("Dashboard node_modules", existsSync(join(ROOT, "dashboard", "node_modules")), "Run: cd dashboard && bun install");

// 4. Dashboard build
check("Dashboard build", existsSync(join(ROOT, "dashboard", "dist", "index.html")), "Run: cd dashboard && bun run build");

// 5. Shared auth Python — same resolver as runtime (config.pythonPath / runPythonFlow)
const authPy = findAuthVenvPython(ROOT);
const runtimePy = resolveAuthPython(ROOT);
check("Auth Python venv", !!authPy, "Run: bun scripts/doctor.ts --fix");
if (authPy) {
  const probe = probeAuthFlowImports(authPy, ROOT);
  check(
    "Auth flow deps (aiohttp + adapters)",
    probe.ok,
    `Run: bun scripts/doctor.ts --fix  or: "${authPy}" -m pip install -r scripts/auth/requirements.txt`,
  );
  check(
    "Runtime Python matches auth venv",
    runtimePy === authPy || resolve(runtimePy) === resolve(authPy),
    `Runtime would use ${runtimePy}; clear ETTEUM_PYTHON/BATCHER_PYTHON/PYTHON_PATH overrides`,
  );
}

// 6. Camoufox JS (optional stealth dep for TS bulk-import)
const cfo = spawnSync("bun", ["-e", "import('camoufox-js').then(() => process.exit(0)).catch(() => process.exit(1))"], { encoding: "utf8" });
check("Camoufox JS (optional)", cfo.status === 0, "Run: bun install (camoufox-js is in optionalDependencies)");

// 7. Canva worker — runtime uses config.pythonPath (auth venv), not system Python
const workerPath = join(ROOT, "src", "proxy", "providers", "canva_worker.py");
if (existsSync(workerPath) && authPy) {
  const cf = probeCanvaWorkerImports(authPy);
  check(
    "Canva worker (curl_cffi in auth venv)",
    cf.ok,
    `Run: bun scripts/doctor.ts --fix  or: "${authPy}" -m pip install -r scripts/auth/requirements.txt`,
  );
}

console.log("");
if (failed === 0) {
  console.log(`  ${GREEN}✓ Preflight passed.${RESET}\n`);
  process.exit(0);
} else {
  console.log(`  ${RED}✗ ${failed} preflight check(s) failed. Run \`bun run doctor\` for details.${RESET}\n`);
  process.exit(1);
}
