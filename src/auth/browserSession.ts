/**
 * Browser session registry — tracks active manual-login browser sessions for
 * the live frame viewer (Browser Logs page).
 *
 * Each session is a running antigravity_manual_login.py process. The TS
 * manualRunner spawns the process and registers it here. The dashboard
 * connects to the SSE frame stream + sends input/captcha via the API endpoints.
 */

export interface BrowserSessionStep {
  ts: number;        // ms epoch
  step: string;      // init|proxy|start|retry|browser_launch|authenticated|tokens|quota|quota_skip|claim|error|result
  message: string;
  provider: string;
}

export interface BrowserSession {
  sessionId: string;
  accountId: number;
  email: string;
  provider: string;
  phase: string;
  lastMessage: string;
  lastFrame: string;      // base64 JPEG (no data: prefix)
  lastFrameFormat: string; // "jpeg"
  lastFrameTime: number;   // ms epoch
  steps: BrowserSessionStep[]; // bounded step-history timeline (FIFO, cap 200)
  challenge: {
    image_base64: string;
    image_format: string;
    prompt: string;
    seq: number;
  } | null;
  terminal: boolean;       // true when phase=complete or failed
  proc: any;               // Bun subprocess
  stdinWriter: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> } | null;
  cancelSignalFile: string;
  startedAt: number;
}

const sessions = new Map<string, BrowserSession>();

export function registerSession(s: BrowserSession): void {
  sessions.set(s.sessionId, s);
}

export function getSession(sessionId: string): BrowserSession | undefined {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function listSessions(): BrowserSession[] {
  return [...sessions.values()];
}

export function updateFrame(sessionId: string, base64: string, format: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.lastFrame = base64;
  s.lastFrameFormat = format;
  s.lastFrameTime = Date.now();
}

/**
 * Append a structured step to the session's bounded timeline. This is the
 * richer log surface (the structured progress/error/result events from the
 * Python automation engine). Cap 200 entries FIFO so memory stays bounded for
 * long-running sessions. Idempotent against duplicate consecutive steps.
 */
export function appendStep(
  sessionId: string,
  step: string,
  message: string,
  provider: string,
): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  const last = s.steps[s.steps.length - 1];
  // Dedup exact consecutive repeats (same step + message + provider) to keep
  // the timeline readable during tight retry loops.
  if (last && last.step === step && last.message === message && last.provider === provider) {
    last.ts = Date.now();
    return;
  }
  s.steps.push({ ts: Date.now(), step, message, provider });
  if (s.steps.length > 200) s.steps.splice(0, s.steps.length - 200);
}

export function updatePhase(sessionId: string, phase: string, message: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.phase = phase;
  s.lastMessage = message || s.lastMessage;
  if (phase === "complete" || phase === "failed" || phase === "cancelled") s.terminal = true;
}

export function updateChallenge(sessionId: string, challenge: BrowserSession["challenge"]): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.challenge = challenge;
}

export function clearChallenge(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.challenge = null;
}

/**
 * Forward input (pointer/key) or captcha answer to the running Python script's stdin.
 * The script reads JSON lines: {answer}, {type:"pointer",...}, {type:"key",...}.
 */
export function forwardInput(sessionId: string, msg: Record<string, unknown>): boolean {
  const s = sessions.get(sessionId);
  if (!s || !s.stdinWriter || s.terminal) return false;
  const enc = new TextEncoder();
  // Inject accountId so the batch runner can route the message to the
  // right login.py worker (automation sessions are batch-<accountId>).
  const out = { ...msg, accountId: s.accountId };
  s.stdinWriter.write(enc.encode(JSON.stringify(out) + "\n")).catch(() => {});
  if ("answer" in msg) clearChallenge(sessionId);
  return true;
}

/**
 * Cancel a running session: write the cancel-signal-file + kill the process.
 */
export function cancelSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  // 1. Graceful: send cancel via stdin (the frame-relay path).
  if (s.stdinWriter) {
    const enc = new TextEncoder();
    s.stdinWriter.write(enc.encode(JSON.stringify({ type: "cancel", accountId: s.accountId }) + "\n")).catch(() => {});
  }
  // 2. Legacy: write to cancel signal file (manual-login path).
  if (s.cancelSignalFile) {
    try { writeFileSync(s.cancelSignalFile, "cancel"); } catch {}
  }
  // 3. Last resort: kill the process (only for standalone manual sessions,
  //    not batch sessions — batch sessions share one process).
  if (s.proc && !sessionId.startsWith("batch-")) {
    const proc = s.proc;
    const pid = proc.pid;
    if (pid) {
      try { Bun.spawnSync(["pterminate", "-9", "-P", String(pid)]); } catch {}
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    try { (proc as any).kill("SIGTERM"); } catch {}
  }
  s.terminal = true;
  s.phase = "cancelled";
  return true;
}

import { writeFileSync } from "node:fs";
