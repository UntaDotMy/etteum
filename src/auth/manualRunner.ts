/**
 * Manual-login runner — spawns antigravity_manual_login.py (the visible nodriver
 * 'frame') and bridges its line-JSON events to the dashboard, including the
 * manual_challenge round-trip (CAPTCHA image → dashboard modal → user's answer
 * → script stdin).
 *
 * This mirrors how the reference design's Go server spawns the manual-login script: the script
 * emits progress / manual_challenge / result / error events on stdout; the
 * server forwards them to the dashboard and writes the user's challenge answer
 * back to the script's stdin.
 *
 * The final result event is mapped via applyProviderResult (runner.ts), so the
 * per-account DB/broadcast/VCC/provider-post-processing is the SAME as the
 * direct loginAccount path — nothing is ported to Python.
 */
import { config } from "../config";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import { applyProviderResult, markLoginFailed } from "./runner";
import { handleCardResult } from "../api/vcc";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Account } from "../db/schema";
import { registerSession, updateFrame, updatePhase, deleteSession, updateChallenge } from "./browserSession";

// Active manual-login sessions: accountId → session handle. Lets the dashboard
// look up the running process to submit a challenge answer or cancel.
interface ManualSession {
  accountId: number;
  proc: ReturnType<typeof Bun.spawn> | null;
  stdinWriter: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> } | null;
  cancelSignalFile: string;
  provider: string;
}
const activeSessions = new Map<number, ManualSession>();

function cancelDir(): string {
  const dir = path.join(config.authScriptCwd, ".cancel-signals");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * Submit the user's challenge answer to a running manual-login session.
 * Returns true if delivered, false if no active session / no stdin.
 */
export function submitManualChallengeAnswer(accountId: number, answer: string): boolean {
  const session = activeSessions.get(accountId);
  if (!session || !session.stdinWriter) return false;
  const enc = new TextEncoder();
  // One JSON line — antigravity_manual_login.py reads this as {answer:...}.
  session.stdinWriter.write(enc.encode(JSON.stringify({ answer }) + "\n")).catch(() => {});
  return true;
}

/**
 * Cancel a running manual-login session by creating the cancel-signal-file the
 * script polls, then terminating the process. Returns true if a session was
 * found and signalled.
 */
export function cancelManualLogin(accountId: number): boolean {
  const session = activeSessions.get(accountId);
  if (!session) return false;
  try { writeFileSync(session.cancelSignalFile, "cancel"); } catch {}
  const proc = session.proc;
  if (proc) {
    const pid = proc.pid;
    if (pid) {
      try { Bun.spawnSync(["pterminate", "-9", "-P", String(pid)]); } catch {}
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    try { (proc as any).kill("SIGTERM"); } catch {}
  }
  return true;
}

/**
 * Run antigravity_manual_login.py for one account. Spawns the visible nodriver
 * 'frame', streams events to the dashboard, bridges manual_challenge answers,
 * and applies the final result via applyProviderResult.
 */
export async function runAntigravityManualLogin(account: Account): Promise<void> {
  const provider = "antigravity";
  const password = decrypt(account.password);
  const cancelSignalFile = path.join(cancelDir(), `ag-${account.id}-${Date.now()}.cancel`);

  // Resolve the proxy URL before building env (getNextProxy is async).
  let proxyUrl = config.proxyUrl || "";
  try {
    const proxyEntry = await (await import("../services/proxy-pool")).getNextProxy("auth");
    if (proxyEntry?.url) proxyUrl = proxyEntry.url;
  } catch {}

  const manualScript = config.authScriptPath.replace(/login\.py$/, "antigravity_manual_login.py");
  const proc = Bun.spawn(
    [config.pythonPath, manualScript, "--email", account.email, "--password", password, "--cancel-signal-file", cancelSignalFile],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        BATCHER_CONCURRENT: "1",
        BATCHER_PRIORITY: provider,
        ...(proxyUrl ? { BATCHER_PROXY_URL: proxyUrl, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } : {}),
      },
      cwd: config.authScriptCwd,
    },
  );

  // stdin writer for challenge answers. Bun's stdin:"pipe" is a FileSink
  // (write()/end()), not a WritableStream — wrap it in a minimal writer shape
  // so submitManualChallengeAnswer can .write() a JSON line.
  let stdinWriter: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> } | null = null;
  if (proc.stdin) {
    const sink = proc.stdin as any;
    stdinWriter = {
      write: (chunk: Uint8Array) => { try { sink.write(chunk); return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
      close: () => { try { sink.end(); } catch {} return Promise.resolve(); },
    };
  }

  const session: ManualSession = { accountId: account.id, proc, stdinWriter, cancelSignalFile, provider };
  activeSessions.set(account.id, session);

  // Track the browser session ID emitted by the Python script (for the frame viewer).
  let browserSessionId: string | null = null;

  const startLog = addAuthLog({
    type: "login_progress",
    accountId: account.id,
    email: account.email,
    provider,
    step: "manual_login_start",
    message: `Starting visible-frame antigravity login for ${account.email}...`,
  });
  broadcast({ type: "login_progress", data: { logId: startLog.id, id: account.id, accountId: account.id, email: account.email, provider, step: "manual_login_start", message: startLog.message } });

  const decoder = new TextDecoder();
  let buffer = "";
  const reader = proc.stdout.getReader();
  let finalResult: any = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        // Handle frame/phase/session events (for the browser frame viewer).
        if (event.type === "session" && event.sessionId) {
          browserSessionId = event.sessionId;
          registerSession({
            sessionId: event.sessionId,
            accountId: account.id,
            email: account.email,
            provider: "antigravity",
            phase: "launching",
            lastMessage: "Starting...",
            lastFrame: "",
            lastFrameFormat: "jpeg",
            lastFrameTime: 0,
            challenge: null,
            terminal: false,
            proc,
            stdinWriter,
            cancelSignalFile,
            startedAt: Date.now(),
          });
          continue;
        }
        if (event.type === "frame" && browserSessionId) {
          updateFrame(browserSessionId, event.base64, event.format || "jpeg");
          continue;  // don't broadcast frames via WS (too heavy)
        }
        if (event.type === "phase" && browserSessionId) {
          updatePhase(browserSessionId, event.phase, event.message || "");
          broadcast({ type: "login_progress", data: { id: account.id, accountId: account.id, email: account.email, provider: "antigravity", step: "phase", message: event.message, phase: event.phase } });
          continue;
        }
        finalResult = handleManualEvent(event, account, finalResult, browserSessionId);
      }
    }
  } catch {
    // reader closed
  }

  // Close stdin (no more answers expected).
  try { if (stdinWriter) await stdinWriter.close(); } catch {}

  await proc.exited;
  activeSessions.delete(account.id);
  if (browserSessionId) {
    updatePhase(browserSessionId, "failed", "Session ended");
    // Keep the session in the registry for a short while so the frontend can
    // show the final frame + "Browser frame ended with the session." message.
    setTimeout(() => deleteSession(browserSessionId!), 10000);
  }
  try { unlinkSync(cancelSignalFile); } catch {}

  // Apply the final result if we got one (mirrors loginAccount's success path).
  if (finalResult && finalResult.success) {
    await applyProviderResult(account, provider, password, {
      success: true,
      provider,
      credentials: finalResult.credentials || {},
      quota: finalResult.quota || {},
    });
  } else if (finalResult && !finalResult.success) {
    await markLoginFailed(account, provider, finalResult.error || "Manual login failed");
  } else {
    // Process ended with no result event.
    await markLoginFailed(account, provider, "Manual login ended without a result");
  }

  try { unlinkSync(cancelSignalFile); } catch {}
}

/**
 * Map one stdout event from antigravity_manual_login.py to dashboard broadcasts.
 * Returns the latest result-shaped event seen (applied by the caller at end).
 */
function handleManualEvent(event: any, account: Account, prevResult: any, browserSessionId: string | null = null): any {
  const provider = "antigravity";
  if (event.type === "progress") {
    const log = addAuthLog({
      type: "login_progress",
      accountId: account.id,
      email: account.email,
      provider: event.provider || provider,
      step: event.step,
      message: event.message,
    });
    broadcast({ type: "login_progress", data: { logId: log.id, id: account.id, accountId: account.id, email: account.email, provider: event.provider || provider, step: event.step, message: event.message, timestamp: log.timestamp } });
    return prevResult;
  }
  if (event.type === "manual_challenge") {
    // Store the challenge in the browser session registry (for the frame viewer).
    if (browserSessionId) {
      updateChallenge(browserSessionId, {
        image_base64: event.challenge_image_base64 || "",
        image_format: event.challenge_image_format || "jpeg",
        prompt: event.prompt || "Type the characters",
        seq: event.challenge_seq || 1,
      });
    }
    // Forward the challenge to the dashboard — it renders the CAPTCHA image +
    // a text input. The user's answer comes back via POST /api/browser-session/:sid/captcha
    // → forwardInput → this script's stdin.
    const log = addAuthLog({
      type: "login_progress",
      accountId: account.id,
      email: account.email,
      provider,
      step: "manual_challenge",
      message: event.message || "Manual challenge",
      data: {
        challenge_type: event.challenge_type,
        challenge_seq: event.challenge_seq,
        challenge_image_base64: event.challenge_image_base64,
        challenge_image_format: event.challenge_image_format,
        prompt: event.prompt,
      },
    });
    broadcast({
      type: "manual_challenge",
      data: {
        logId: log.id,
        id: account.id,
        accountId: account.id,
        email: account.email,
        provider,
        challenge_type: event.challenge_type,
        challenge_seq: event.challenge_seq,
        challenge_image_base64: event.challenge_image_base64,
        challenge_image_format: event.challenge_image_format,
        message: event.message,
        prompt: event.prompt,
      },
    });
    return prevResult;
  }
  if (event.type === "upgrade_card_result") {
    const { card_last4, card_status } = event;
    if (card_last4 && card_status && card_status !== "success") {
      const status = card_status === "declined" ? "declined" as const : "error" as const;
      void handleCardResult(account.id, card_last4, status);
    }
    return prevResult;
  }
  if (event.type === "error") {
    const log = addAuthLog({
      type: "login_failed",
      accountId: account.id,
      email: account.email,
      provider: event.provider || provider,
      error: event.error,
      message: event.error,
    });
    broadcast({ type: "login_failed", data: { logId: log.id, id: account.id, accountId: account.id, email: account.email, provider: event.provider || provider, error: event.error, timestamp: log.timestamp } });
    return prevResult;
  }
  if (event.type === "result") {
    // login.py/batch_login shape: {antigravity: {success, credentials, quota, error}}
    const pr = event[provider] || event.antigravity || event;
    return { success: !!pr.success, credentials: pr.credentials, quota: pr.quota, error: pr.error };
  }
  return prevResult;
}
