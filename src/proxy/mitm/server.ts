/**
 * MITM TLS intercepting server (F10).
 * Ported from 9router src/mitm/server.js.
 *
 * A `tls.Server` on :443 with an `SNICallback` that mints a per-domain leaf
 * cert (signed by the Root CA) on the fly, caching the secure context. Each TLS
 * connection carries an HTTP request; we collect the body, dispatch to the
 * per-tool handler (by SNI host → tool), which rewrites body.model + forwards to
 * the local router, then pipe the response back to the IDE.
 *
 * Runs IN-PROCESS (Bun, not a child Node process — no HMR/locking concerns and
 * no IPC). The manager (manager.ts) starts/stops it + manages the CA/DNS.
 */
import * as tls from "node:tls";
import * as http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { generateLeafCert, loadRootCA } from "./cert";
import { getToolForHost } from "./config";
import { handleToolRequest, type MitmRequest } from "./handlers";
import { MITM_DIR, MITM_PORT, ROOT_CA_CERT_PATH, ROOT_CA_KEY_PATH } from "./paths";

let server: tls.Server | null = null;
const certCache = new Map<string, tls.SecureContext>();
let rootCAPem = "";

/** SNI callback: mint (or reuse) a leaf cert for the requested domain. */
function sniCallback(servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void): void {
  try {
    const host = servername.split(":")[0] ?? servername;
    const cached = certCache.get(host);
    if (cached) return cb(null, cached);
    const rootCA = loadRootCA();
    const leaf = generateLeafCert(host, rootCA);
    const ctx = tls.createSecureContext({
      key: leaf.key,
      cert: `${leaf.cert}\n${rootCAPem}`,
    });
    certCache.set(host, ctx);
    cb(null, ctx);
  } catch (e) {
    cb(e as Error);
  }
}

/** Parse the HTTP request from a TLS connection's data. */
function parseHttp(buf: Buffer): { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer } | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerStr = buf.subarray(0, headerEnd).toString("utf8");
  const body = buf.subarray(headerEnd + 4);
  const lines = headerStr.split("\r\n");
  const firstParts = (lines[0] || "").split(" ");
  const method = firstParts[0] ?? "";
  const url = firstParts[1] ?? "/";
  const headers: Record<string, string | string[] | undefined> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    const existing = headers[k];
    if (existing !== undefined) {
      headers[k] = Array.isArray(existing) ? [...existing, v] : [existing as string, v];
    } else {
      headers[k] = v;
    }
  }
  return { method, url, headers, body };
}

/** Collect all data from a TLS socket (HTTP request), then handle it. */
async function handleConnection(socket: tls.TLSSocket): Promise<void> {
  const chunks: Buffer[] = [];
  let totalLen = 0;
  const MAX = 32 * 1024 * 1024; // 32MB cap
  for await (const chunk of socket as any) {
    chunks.push(Buffer.from(chunk));
    totalLen += (chunk as Buffer).length;
    if (totalLen > MAX) { socket.end("HTTP/1.1 413 Request Too Large\r\n\r\n"); return; }
    // Heuristic: once we have the full headers + Content-Length body, break.
    const joined = Buffer.concat(chunks);
    const headerEnd = joined.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const headerStr = joined.subarray(0, headerEnd).toString("utf8");
      const clMatch = headerStr.match(/content-length:\s*(\d+)/i);
      const cl = clMatch && clMatch[1] ? parseInt(clMatch[1], 10) : 0;
      const bodySoFar = joined.length - (headerEnd + 4);
      if (bodySoFar >= cl) break;
    }
  }
  const raw = Buffer.concat(chunks);
  const parsed = parseHttp(raw);
  if (!parsed) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const servername = (socket.servername || parsed.headers.host as string || "").toString();
  const tool = getToolForHost(servername);
  if (!tool) {
    socket.end("HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n" + JSON.stringify({ error: `no MITM tool for host: ${servername}` }));
    return;
  }

  const mitmReq: MitmRequest = { method: parsed.method, url: parsed.url, host: servername, headers: parsed.headers, body: parsed.body };
  try {
    const result = await handleToolRequest(tool, mitmReq);
    const respHeaders = Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    const head = `HTTP/1.1 ${result.status} OK\r\n${respHeaders}\r\n\r\n`;
    socket.write(head);
    if (Buffer.isBuffer(result.body)) {
      socket.write(result.body);
    } else {
      // ReadableStream (SSE) — pipe it.
      const reader = (result.body as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) socket.write(Buffer.from(value));
        }
      } catch { /* client disconnect */ }
    }
    socket.end();
  } catch (e: any) {
    socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ error: e?.message || String(e) })}`);
  }
}

export interface ServerStartResult { ok: boolean; error?: string; }

/** Start the MITM TLS server (idempotent). */
export function startMitmServer(): ServerStartResult {
  if (server) return { ok: true };
  if (!existsSync(ROOT_CA_KEY_PATH) || !existsSync(ROOT_CA_CERT_PATH)) {
    return { ok: false, error: "Root CA not generated. Generate it first." };
  }
  try {
    rootCAPem = readFileSync(ROOT_CA_CERT_PATH, "utf8");
    const rootKey = readFileSync(ROOT_CA_KEY_PATH);
    server = tls.createServer({ key: rootKey, cert: rootCAPem, SNICallback: sniCallback }, (socket) => {
      void handleConnection(socket).catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
    });
    server.on("error", (err: any) => {
      console.error("[MITM] server error:", err?.message || err);
    });
    server.listen(MITM_PORT, () => {
      console.log(`[MITM] TLS intercepting server listening on :${MITM_PORT}`);
    });
    return { ok: true };
  } catch (e: any) {
    server = null;
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Stop the MITM TLS server. */
export function stopMitmServer(): void {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
    server = null;
    certCache.clear();
    console.log("[MITM] server stopped");
  }
}

export function isMitmServerRunning(): boolean {
  return server !== null;
}
