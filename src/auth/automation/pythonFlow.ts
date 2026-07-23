/**
 * Python Camoufox flow-runner client.
 *
 * Spawns scripts/auth/camoufox_flow.py and bridges stdio JSON events to the TS
 * emit callback. Camoufox-js hangs on some Windows hosts; the Python package
 * launches reliably. TS owns routing, DB updates, and WebSocket broadcast.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AutomationEvent, EmitFn } from "./automationEvents";
import { findAuthVenvPython, resolveAuthPython } from "../../utils/python";

/**
 * Resolve Python for camoufox_flow.py via the shared resolver.
 * Prefer scripts/auth/.venv; never invent a second PATH-first policy here.
 */
function resolvePython(): string | null {
  const root = process.env.ETTEUM_ROOT || process.cwd();
  const resolved = resolveAuthPython(root);
  // Bare names (python3) are PATH lookups — accept them. Absolute paths must exist.
  if (path.basename(resolved) === resolved) return resolved;
  if (existsSync(resolved)) return resolved;
  return findAuthVenvPython(root);
}

function flowScriptPath(): string {
  const root = process.env.ETTEUM_ROOT || process.cwd();
  return path.join(root, "scripts", "auth", "camoufox_flow.py");
}

export interface FlowResult {
  success: boolean;
  error?: string;
  manual?: boolean;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    profile_arn?: string;
    [k: string]: unknown;
  };
  credentials?: FlowResult["tokens"];
  quota?: Record<string, number> | null;
  email?: string;
}

/**
 * Run a login flow via the Python Camoufox runner.
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
      reject(
        new Error(
          "Python interpreter not found. Install Python 3.10+ and ensure it is on PATH, or set ETTEUM_PYTHON.",
        ),
      );
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
      params: {
        provider,
        email: account.email,
        password: account.password,
        headless: opts.headless ?? true,
        proxy,
      },
    };

    const env = {
      ...process.env,
      BATCHER_ENABLE_CAMOUFOX: process.env.BATCHER_ENABLE_CAMOUFOX || "true",
      BATCHER_CAMOUFOX_HEADLESS:
        process.env.BATCHER_CAMOUFOX_HEADLESS ||
        (opts.headless === false ? "false" : "true"),
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: [
        path.dirname(script),
        process.env.PYTHONPATH || "",
      ]
        .filter(Boolean)
        .join(path.delimiter),
    };

    const child: ChildProcessWithoutNullStreams = spawn(py, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: path.dirname(script),
    });

    let buffer = "";
    let stderrBuf = "";
    let settled = false;

    const finish = (result: FlowResult) => {
      if (settled) return;
      settled = true;
      try {
        child.stdin.write(JSON.stringify({ id: 2, method: "shutdown" }) + "\n");
      } catch {
        /* ignore */
      }
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5000);
      // Normalize tokens from either field.
      if (result.success && !result.tokens && result.credentials) {
        result.tokens = result.credentials;
      }
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
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === "event") {
          bridgeEvent(obj, emit);
          continue;
        }
        if (obj.id === req.id && obj.ok !== undefined) {
          if (obj.ok) finish(obj.result as FlowResult);
          else finish({ success: false, error: obj.error || "flow runner error" });
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString("utf8");
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`failed to spawn camoufox_flow.py: ${err.message}`));
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        const tail = stderrBuf.slice(-500);
        reject(
          new Error(`camoufox_flow.py exited (code ${code})${tail ? `: ${tail}` : ""}`),
        );
      }
    });

    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

function parseProxy(
  proxyUrl: string,
): { server: string; username?: string; password?: string } | undefined {
  const clean = String(proxyUrl || "").trim();
  if (!clean) return undefined;
  try {
    const u = new URL(clean);
    const out: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: clean };
  }
}

function bridgeEvent(obj: any, emit: EmitFn): void {
  const provider = obj.provider || "";
  if (obj.event === "progress") {
    emit({
      type: "progress",
      provider,
      step: obj.step || "",
      message: obj.message || "",
    });
  } else if (obj.event === "manual_challenge") {
    emit({
      type: "manual_challenge",
      provider,
      challengeType: obj.challengeType || "unknown",
      message: obj.message || "",
    });
  } else if (obj.event === "frame") {
    emit({ type: "frame", provider, png: obj.data?.png || "" });
  } else if (obj.event === "error") {
    emit({ type: "error", provider, error: obj.error || "", fatal: obj.fatal });
  } else if (obj.event === "ready") {
    emit({ type: "progress", provider: "system", step: "ready", message: obj.message || "ready" });
  }
}

// Re-export type surface for callers that previously imported from the old module.
export type { AutomationEvent, EmitFn };
