/**
 * MITM subsystem paths + per-tool DNS hosts (F10).
 * Ported from the reference proxy src/mitm/paths.js + src/shared/constants/mitmToolHosts.js.
 */
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

const APP_NAME = "etteum";

function defaultDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir(): string {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  try {
    if (!existsSync(configured)) mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e: any) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
export const MITM_DIR = path.join(DATA_DIR, "mitm");
export const ROOT_CA_KEY_PATH = path.join(MITM_DIR, "rootCA.key");
export const ROOT_CA_CERT_PATH = path.join(MITM_DIR, "rootCA.crt");
export const MITM_PID_PATH = path.join(MITM_DIR, ".mitm.pid");

/**
 * Per-tool DNS hosts — written to the hosts file as `127.0.0.1 <host>` when
 * MITM DNS is enabled for that tool. These are the vendor endpoints the IDEs
 * hardcode (ignoring a BASE_URL env), which the MITM intercepts.
 */
export const TOOL_HOSTS: Record<string, string[]> = {
  antigravity: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
  copilot: ["api.individual.githubcopilot.com"],
  kiro: ["runtime.us-east-1.kiro.dev", "q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com"],
  cursor: ["api2.cursor.sh"],
};

/** The local port the MITM TLS server listens on (vendor HTTPS = 443). */
export const MITM_PORT = Number(process.env.MITM_PORT) || 443;

/** The local router base URL the MITM forwards intercepted requests to. */
// Default to this process's PORT (1930) + /v1 — the previous 20128 default
// pointed at a non-existent local port and guaranteed  connection failures.
export const MITM_ROUTER_BASE_URL =
  process.env.MITM_ROUTER_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || "1930"}/v1`;

/** Restart backoff delays (ms) for the MITM server child process. */
export const MITM_RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
