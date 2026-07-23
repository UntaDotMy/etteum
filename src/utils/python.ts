/**
 * Shared auth/farm Python resolution.
 *
 * Rule: health checks, installers, and runtime spawns must all prefer the same
 * interpreter — scripts/auth/.venv — so "doctor green" never means "login red".
 *
 * Override priority (explicit only; empty env values are ignored):
 *   1. ETTEUM_PYTHON
 *   2. BATCHER_PYTHON  (legacy alias)
 *   3. PYTHON_PATH     (general / canva_worker)
 *   4. scripts/auth/.venv
 *   5. bare system python (last resort — often lacks project deps)
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Absolute candidates for the shared auth/farm venv interpreter. */
export function authVenvPythonCandidates(projectRoot: string): string[] {
  const venvRoot = path.join(projectRoot, "scripts", "auth", ".venv");
  return process.platform === "win32"
    ? [
        path.join(venvRoot, "Scripts", "python.exe"),
        path.join(venvRoot, "bin", "python"),
        path.join(venvRoot, "bin", "python3"),
      ]
    : [
        path.join(venvRoot, "bin", "python"),
        path.join(venvRoot, "bin", "python3"),
        path.join(venvRoot, "Scripts", "python.exe"),
      ];
}

export function findAuthVenvPython(projectRoot: string): string | null {
  for (const c of authVenvPythonCandidates(projectRoot)) {
    if (existsSync(c)) return c;
  }
  return null;
}

function firstExistingOverride(env: NodeJS.ProcessEnv, keys: string[]): string | null {
  for (const key of keys) {
    const raw = env[key];
    if (!raw || !raw.trim()) continue;
    const val = raw.trim();
    // Bare command names (python3 / python.exe) are valid PATH lookups.
    if (path.basename(val) === val) return val;
    if (existsSync(val)) return val;
  }
  return null;
}

/**
 * Resolve the Python used for camoufox_flow, canva_worker, grok-farm, and
 * any other auth/farm subprocess. Always call this (or config.pythonPath which
 * wraps it) — do not re-implement PATH-first logic in callers.
 */
export function resolveAuthPython(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = firstExistingOverride(env, [
    "ETTEUM_PYTHON",
    "BATCHER_PYTHON",
    "PYTHON_PATH",
  ]);
  if (override) return override;

  const venv = findAuthVenvPython(projectRoot);
  if (venv) return venv;

  return process.platform === "win32" ? "python.exe" : "python3";
}

/** Import surface camoufox_flow.py needs at process start. */
export const AUTH_FLOW_IMPORT_PROBE =
  "import aiohttp, aiohttp_socks, httpx, camoufox, playwright; " +
  "from app.providers.kiro import KiroProviderAdapter; " +
  "from app.providers.codebuddy import CodeBuddyProviderAdapter; " +
  "from app.providers.canva import CanvaProviderAdapter; " +
  "from app.providers.qoder_adapter import QoderProviderAdapter";

/** Canva media worker needs curl_cffi (TLS impersonation). */
export const CANVA_WORKER_IMPORT_PROBE = "import curl_cffi";

export type PythonProbeResult = { ok: boolean; detail: string };

export function probePythonImports(
  python: string,
  code: string,
  opts: { cwd?: string; pythonPath?: string } = {},
): PythonProbeResult {
  const env = { ...process.env };
  if (opts.pythonPath) {
    const sep = process.platform === "win32" ? ";" : ":";
    env.PYTHONPATH = [opts.pythonPath, env.PYTHONPATH || ""].filter(Boolean).join(sep);
  }
  const r = spawnSync(python, ["-c", code], {
    encoding: "utf8",
    cwd: opts.cwd,
    env,
    timeout: 30_000,
  });
  if (r.status === 0) return { ok: true, detail: "" };
  const detail = (r.stderr || r.stdout || r.error?.message || "import failed")
    .trim()
    .split(/\r?\n/)
    .slice(-3)
    .join(" | ")
    .slice(0, 300);
  return { ok: false, detail };
}

export function probeAuthFlowImports(python: string, projectRoot: string): PythonProbeResult {
  const authDir = path.join(projectRoot, "scripts", "auth");
  return probePythonImports(python, AUTH_FLOW_IMPORT_PROBE, {
    cwd: authDir,
    pythonPath: authDir,
  });
}

export function probeCanvaWorkerImports(python: string): PythonProbeResult {
  return probePythonImports(python, CANVA_WORKER_IMPORT_PROBE);
}

export function authRequirementsPath(projectRoot: string): string {
  return path.join(projectRoot, "scripts", "auth", "requirements.txt");
}
