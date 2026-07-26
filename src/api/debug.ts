/**
 * Debug endpoints — translator pipeline replay + live console log stream.
 *
 *   POST /api/translator/debug  — run a request through each transform stage
 *                                  (dry-run; does NOT call the provider) and
 *                                  return each stage's output for inspection.
 *   GET  /api/console/stream    — SSE stream of server log lines (ring buffer).
 *
 * Closes the dashboard gaps that made the Translator + Live Console pages
 * non-functional .
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { pool } from "../proxy/pool";
import { providers } from "../proxy/router";
import { applyPudidilFilters } from "../proxy/filters";
import { getCompressionConfig, compressRequest } from "../proxy/compression";
import { resolveModelAlias, normalizeModelId as proxyNormalizeModelId } from "../proxy/model-mapping";

export const debugRouter = new Hono();

const RING_BUFFER: { ts: number; level: string; msg: string }[] = [];
const RING_MAX = 500;
const SSE_CLIENTS = new Set<(line: string) => void>();

/** Push a log line into the ring buffer + broadcast to SSE clients. */
export function pushConsoleLine(level: string, msg: string): void {
  const line = { ts: Date.now(), level, msg: String(msg).slice(0, 2000) };
  RING_BUFFER.push(line);
  if (RING_BUFFER.length > RING_MAX) RING_BUFFER.shift();
  const data = `data: ${JSON.stringify(line)}\n\n`;
  for (const send of SSE_CLIENTS) {
    try { send(data); } catch { /* client gone */ }
  }
}

let consoleBridgeInstalled = false;
let consoleBridgeReentry = false;

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Mirror console.log/info/warn/error into the Live Console ring buffer.
 * Without this, /api/console/stream has nothing to show (pushConsoleLine was never called).
 */
export function installConsoleBridge(): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;

  const levels = ["log", "info", "warn", "error"] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (consoleBridgeReentry) return;
      consoleBridgeReentry = true;
      try {
        const msg = args.map(formatConsoleArg).join(" ");
        if (msg) pushConsoleLine(level === "log" ? "info" : level, msg);
      } catch {
        /* never throw from console bridge */
      } finally {
        consoleBridgeReentry = false;
      }
    };
  }
}

/**
 * Model-id normalization for the Translator preview.
 *
 * MUST match the production edge (proxy/index.ts normalizeModelId), otherwise
 * the debug page reports a pipeline the real request never runs. The extra
 * vendor-prefix trim is applied first because the dashboard's own model picker
 * can hand us `anthropic/...` ids that never reach /v1.
 */
function normalizeModelId(model: string): string {
  if (!model) return model;
  const trimmed = model.trim().replace(/^anthropic\//, "").replace(/^openai\//, "");
  return proxyNormalizeModelId(trimmed);
}

/** POST /api/translator/debug — dry-run a request through the transform pipeline. */
debugRouter.post("/translator/debug", async (c) => {
  const body = await c.req.json<{ request: any; dryRun?: boolean }>().catch(() => ({ request: {} as any, dryRun: true }));
  const request = body.request || {};
  const raw = JSON.parse(JSON.stringify(request));

  // Stage 1: normalized — model id canonicalized, alias resolved.
  const normalizedModel = resolveModelAlias(normalizeModelId(request.model));
  const normalized = { ...request, model: normalizedModel };

  // Stage 2: filtered — telemetry/brand neutralization via applyPudidilFilters.
  // The filter operates on message content strings; apply it to each message.
  const filtered = JSON.parse(JSON.stringify(normalized));
  if (Array.isArray(filtered.messages)) {
    filtered.messages = filtered.messages.map((m: any) => {
      if (typeof m.content === "string") return { ...m, content: applyPudidilFilters(m.content) };
      return m;
    });
  }

  // Stage 3: compressed — RTK/TSC/cache-markers.
  let compressed = JSON.parse(JSON.stringify(filtered));
  try {
    const cfg = await getCompressionConfig();
    const out = compressRequest(filtered, cfg);
    compressed = out.request;
  } catch { /* fall back to filtered */ }

  // Stage 4: mapped — which provider/account would serve it.
  const match = await pool.getAccountForModel(normalizedModel).catch(() => null);
  const mapped = {
    model: normalizedModel,
    provider: match?.provider ?? null,
    accountId: match?.account?.id ?? null,
    accountEmail: match?.account?.email ?? null,
  };

  // Stage 5: transformed — provider-native format (structural preview).
  const providerName = match?.provider;
  const provider = providerName ? (providers as any)[providerName] : null;
  const transformed = {
    provider: providerName,
    format: provider ? (provider.providerFormat || "openai") : "unknown",
    note: "Provider-native transform happens inside chatCompletion(); this is a structural preview.",
    requestShape: { model: compressed.model, messageCount: (compressed.messages || []).length, stream: !!compressed.stream },
  };

  // Stage 6: response — dry-run: provider not called.
  const response = body.dryRun
    ? { note: "Dry-run: provider was not called. Set dryRun:false to execute." }
    : { note: "Set dryRun:true for a safe preview." };

  return c.json({ raw, normalized, filtered, compressed, mapped, transformed, response });
});

/** GET /api/console/stream — SSE stream of server log lines (ring buffer + live). */
debugRouter.get("/console/stream", (c) => {
  return streamSSE(c, async (stream) => {
    // Replay the current ring buffer to the new client first.
    for (const line of RING_BUFFER) {
      await stream.write(`data: ${JSON.stringify(line)}\n\n`).catch(() => {});
    }
    // Register for live lines.
    let closed = false;
    const send = (data: string) => {
      if (closed) return;
      stream.write(data).catch(() => { closed = true; });
    };
    SSE_CLIENTS.add(send);
    try {
      while (!closed) {
        await stream.sleep(20_000);
        if (!closed) await stream.write(`: keepalive\n\n`).catch(() => { closed = true; });
      }
    } finally {
      closed = true;
      SSE_CLIENTS.delete(send);
    }
  });
});
