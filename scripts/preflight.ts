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
import { platform } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const IS_WIN = platform() === "win32";

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

// 5. Camoufox (optional stealth dep)
const cfo = spawnSync("bun", ["-e", "import('camoufox-js').then(() => process.exit(0)).catch(() => process.exit(1))"], { encoding: "utf8" });
check("Camoufox (stealth browser auth)", cfo.status === 0, "Run: bun install (camoufox-js is in optionalDependencies)");

// 6. Canva worker (curl_cffi)
const workerPath = join(ROOT, "src", "proxy", "providers", "canva_worker.py");
if (existsSync(workerPath)) {
  // Find system Python for canva_worker.py
  const pyCandidates = IS_WIN ? ["python", "python3", "py"] : ["python3", "python"];
  let sysPy = "";
  for (const cmd of pyCandidates) {
    const out = spawnSync(IS_WIN ? "where" : "command", IS_WIN ? [cmd] : ["-v", cmd], { encoding: "utf8", shell: true });
    if (out.status === 0) { sysPy = cmd; break; }
  }
  if (sysPy) {
    const cf = spawnSync(sysPy, ["-c", "import curl_cffi"], { encoding: "utf8" });
    check("Canva worker (curl_cffi)", cf.status === 0, `Run: ${sysPy} -m pip install curl_cffi`);
  }
}

console.log("");
if (failed === 0) {
  console.log(`  ${GREEN}✓ Preflight passed.${RESET}\n`);
  process.exit(0);
} else {
  console.log(`  ${RED}✗ ${failed} preflight check(s) failed. Run \`bun run doctor\` for details.${RESET}\n`);
  process.exit(1);
}
