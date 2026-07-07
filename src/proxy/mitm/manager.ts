/**
 * MITM manager (F10) — orchestrates the MITM subsystem.
 * Ported from 9router src/mitm/manager.js (adapted: in-process server, no child
 * process / IPC since Bun has no HMR/locking concerns).
 *
 * Responsibilities:
 *   - generateRootCA() once (auto-regen if expired)
 *   - install the Root CA into the OS trust store (needs elevation)
 *   - enable DNS hijack (write vendor hosts → 127.0.0.1)
 *   - start/stop the TLS intercepting server
 *   - report status (running, certExists, certTrusted, dnsStatus)
 *
 * All elevation-requiring ops return {requiresAdmin|needsPassword} so the API
 * can prompt + retry with a password.
 */
import { existsSync } from "node:fs";
import { generateRootCA, isCertExpired } from "./cert";
import { ROOT_CA_CERT_PATH } from "./paths";
import { installRootCA, isCertTrusted, type TrustResult } from "./install";
import { addDNSEntry, removeAllDNSEntriesSync, checkAllDNSStatus } from "./dns";
import { startMitmServer, stopMitmServer, isMitmServerRunning } from "./server";
import { broadcast } from "../../ws/index";

export interface MitmStatus {
  running: boolean;
  certExists: boolean;
  certTrusted: boolean;
  dnsStatus: Record<string, boolean>;
}

export interface MitmOpResult {
  ok: boolean;
  requiresAdmin?: boolean;
  needsPassword?: boolean;
  error?: string;
}

/** Current MITM status (read-only). */
export function getMitmStatus(): MitmStatus {
  return {
    running: isMitmServerRunning(),
    certExists: existsSync(ROOT_CA_CERT_PATH) && !isCertExpired(ROOT_CA_CERT_PATH),
    certTrusted: isCertTrusted(),
    dnsStatus: checkAllDNSStatus(),
  };
}

/** Generate the Root CA (idempotent). Returns ok unless generation fails. */
export async function ensureRootCA(): Promise<MitmOpResult> {
  try {
    await generateRootCA();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Install the Root CA into the OS trust store (needs elevation). */
export function trustRootCA(password?: string): TrustResult {
  return installRootCA(password);
}

/** Enable DNS hijack for the given tools (default: all). Needs elevation. */
export function enableDNS(tools?: string[], password?: string): MitmOpResult {
  const res = addDNSEntry([], password); // addDNSEntry flattens all tools when host list empty
  if (!res.ok && !res.needsPassword) {
    return { ok: false, error: res.error };
  }
  return { ok: res.ok, needsPassword: res.needsPassword, error: res.error };
}

/**
 * Start the MITM server (generate CA if needed, enable DNS, start TLS server).
 * This is the one-click "start MITM" entry point. DNS + trust may need elevation
 * → returns needsPassword/requiresAdmin for the API to prompt.
 */
export async function startMitm(password?: string): Promise<MitmOpResult> {
  // 1. Ensure Root CA.
  const ca = await ensureRootCA();
  if (!ca.ok) return ca;

  // 2. Enable DNS hijack (best-effort; not fatal if it needs elevation — the
  //    server can still run for tools whose hosts the user added manually).
  const dns = enableDNS(undefined, password);
  if (!dns.ok && !dns.needsPassword && !dns.requiresAdmin) {
    // Hard error (sudo missing etc.) — surface but continue to start server.
    console.warn("[MITM] DNS enablement failed (server will still start):", dns.error);
  }

  // 3. Start the TLS server.
  const srv = startMitmServer();
  if (!srv.ok) return srv;

  broadcast({ type: "mitm_status", data: getMitmStatus() });
  return { ok: true, needsPassword: dns.needsPassword };
}

/** Stop the MITM server (DNS entries are left in place until explicit disable or shutdown). */
export function stopMitm(): MitmOpResult {
  stopMitmServer();
  broadcast({ type: "mitm_status", data: getMitmStatus() });
  return { ok: true };
}

/** Disable DNS hijack + stop the server (full teardown). */
export function disableMitm(): MitmOpResult {
  stopMitmServer();
  removeAllDNSEntriesSync();
  broadcast({ type: "mitm_status", data: getMitmStatus() });
  return { ok: true };
}
