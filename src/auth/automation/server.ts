import http from "node:http";
import { URL } from "node:url";

/**
 * Local HTTP callback server for OAuth code-exchange flows — TS port of
 * the reference proxy's src/lib/oauth/utils/server.js, 1:1.
 *
 * Starts a localhost server on a free port (or a fixed redirect port), waits
 * for the provider to redirect back with ?code=...&state=..., resolves with the
 * params, and shuts down. Rejects on timeout.
 */
export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  [key: string]: string | undefined;
}

export interface StartServerOptions {
  /** Port to listen on. If omitted, 0 = ephemeral free port. */
  port?: number;
  /** Path the provider redirects to (must match redirect_uri). Default "/callback". */
  path?: string;
  /** Timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
  /** Expected state value (recommended — guards CSRF). */
  expectedState?: string;
}

const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login successful</title><style>body{font-family:system-ui;padding:2rem;text-align:center}</style></head><body><h2>✅ Login successful</h2><p>You can close this window.</p></body></html>`;
const ERROR_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login failed</title></head><body><h2>❌ Login failed</h2><p id="err"></p></body></html>`;

export function startCallbackServer(opts: StartServerOptions = {}): Promise<{ params: CallbackParams; port: number }> {
  const { port = 0, path: callbackPath = "/callback", timeoutMs = 5 * 60_000, expectedState } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", `http://localhost`);
      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404).end("not found");
        return;
      }
      const params: CallbackParams = {};
      for (const [k, v] of reqUrl.searchParams.entries()) {
        params[k] = v;
      }
      if (params.error) {
        res.writeHead(400, { "content-type": "text/html" }).end(ERROR_HTML.replace("<p id=\"err\"></p>", `<p id="err">${params.error}: ${params.errorDescription || ""}</p>`));
      } else {
        res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_HTML);
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        server.close();
        if (expectedState && params.state && params.state !== expectedState) {
          reject(new Error(`OAuth state mismatch: expected ${expectedState}, got ${params.state}`));
        } else {
          resolve({ params, port: serverPort });
        }
      }
    });

    let serverPort = 0;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      serverPort = typeof addr === "object" && addr ? addr.port : port;
    });
  });
}

/** Pick a free localhost port (ephemeral) for use as the redirect target. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}
