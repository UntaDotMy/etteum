/**
 * Python Camoufox flow-runner client — spawns scripts/auth/camoufox_flow.py
 * (the 1:1 enowxai automation) and bridges its stdio JSON events to the TS
 * emit callback.
 *
 * Why Python, not camoufox-js: the camoufox-js binding hangs at browser launch
 * on this Windows host (verified), while the Python camoufox package launches
 * reliably (enowxai uses it). The whole login flow runs in Python; TS owns the
 * adapter routing + result application + WebSocket broadcast.
 *
 * This replaces the broken runProvider() call for enowxai-adapter providers.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AutomationEvent, EmitFn } from "./enowxaiAdapter";

// Resolve the Python interpreter + flow script paths once.
function resolvePython(): string | null {
  // Explicit override first.
  if (process.env.ETTEUM_PYTHON && existsSync(process.env.ETTEUM_PYTHON)) return process.env.ETTEUM_PYTHON;
  // Common Windows install locations (prefer a real CPython over a venv).
  const candidates = [
    "C:\\Users\\riezh\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
    "C:\\Users\\riezh\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
    "C:\\Users\\riezh\\AppData\\Local\\Programs\\Python\\Python310\\python.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // Fall back to PATH lookup (non-Windows or custom installs).
  return null;
}

function flowScriptPath(): string {
  // Relative to the project root (config.databasePath lives under data/).
  const root = process.env.ETTEUM_ROOT || process.cwd();
  return path.join(root, "scripts", "auth", "camoufox_flow.py");
}

export interface FlowResult {
  success: boolean;
  error?: string;
  manual?: boolean;
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; profile_arn?: string; [k: string]: unknown };
  quota?: Record<string, number> | null;
  email?: string;
}

/**
 * Run a login flow via the Python Camoufox runner. Spawns the subprocess,
 * sends run_login, streams events to emit(), and resolves with the result.
 */
export function runPythonFlow(
  provider: string,
  account: { email: string; password: string },
  emit: EmitFn,
  opts: { headless?: boolean; proxy?: string } = {},
): Promise<FlowResult> {
  return new Promise((resolve, reject) => {
    const py = resolvePython();
    const script = flowScriptPath();
    if (!py) {
      reject(new Error("Python interpreter not found. Set ETTEUM_PYTHON to a CPython 3.10+ path."));
      return;
    }
    if (!existsSync(script)) {
      reject(new Error(`Camoufox flow script not found: ${script}`));
      return;
    }

    const proxy = opts.proxy ? parseProxy(opts.proxy) : undefined;
    const req = {
      id: 1,
      method: "run_login",
      params: { provider, email: account.email, password: account.password, headless: opts.headless ?? true, proxy },
    };

    // On Windows, spawn the interpreter directly with a clean env so the
    // camoufox package resolves from the user site-packages.
    const child = spawn(py, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderrBuf = "";
    let settled = false;

    const finish = (result: FlowResult) => {
      if (settled) return;
      settled = true;
      try { child.stdin.end(); } catch {}
      // Ask the runner to shut down its browser + exit.
      try { child.stdin.write(JSON.stringify({ id: 2, method: "shutdown" }) + "\n"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        // Unsolicited event (ready / progress / frame / manual_challenge).
        if (obj.type === "event" && obj.id === req.id) {
          bridgeEvent(obj, emit);
          continue;
        }
        // Response to our run_login request.
        if (obj.id === req.id && !obj.type) {
          if (obj.ok) {
            finish(obj.result as FlowResult);
          } else {
            finish({ success: false, error: obj.error || "flow runner error" });
          }
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => { stderrBuf += d.toString("utf8"); });

    child.on("error", (err) => {
      if (!settled) { settled = true; reject(new Error(`failed to spawn camoufox_flow.py: ${err.message}`)); }
    });
    child.on("exit", (code) => {
      // If the process exited without us settling, it crashed.
      if (!settled) {
        const tail = stderrBuf.slice(-500);
        reject(new Error(`camoufox_flow.py exited (code ${code})${tail ? `: ${tail}` : ""}`));
      }
    });

    // Send the run_login request.
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

/** Parse a proxy URL into Camoufox's {server, username, password} shape. */
function parseProxy(proxyUrl: string): { server: string; username?: string; password?: string } | undefined {
  const clean = String(proxyUrl || "").trim();
  if (!clean) return undefined;
  try {
    const u = new URL(clean);
    const out: { server: string; username?: string; password?: string } = { server: `${u.protocol}//${u.host}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: clean };
  }
}

/** Bridge a Python event to the TS AutomationEvent shape the runner expects. */
function bridgeEvent(obj: any, emit: EmitFn): void {
  const provider = (obj.params && obj.params.provider) || "";
  if (obj.event === "progress") {
    emit({ type: "progress", provider, step: obj.step || "", message: obj.message || "" });
  } else if (obj.event === "manual_challenge") {
    emit({ type: "manual_challenge", provider, challengeType: obj.challengeType || "unknown", message: obj.message || "" });
  } else if (obj.event === "frame") {
    // Frames are emitted as a distinct event the dashboard renders as a preview.
    // Route through progress so the existing WS bridge surfaces something, and
    // also broadcast a dedicated "frame" type the Browser Log can render.
    emit({ type: "progress", provider, step: "frame", message: "" });
    (emit as any)({ type: "frame", provider, png: obj.data?.png || "" });
  } else if (obj.event === "error") {
    emit({ type: "error", provider, error: obj.error || "", fatal: obj.fatal });
  }
}
