/**
 * WebSocket Responses API endpoint (`/v1/responses`, `/backend-api/codex/responses`).
 *
 * Speaks the OpenAI Realtime-style Responses-over-WebSocket protocol:
 *   - Client sends `event: response.create\ndata: {...}\n\n` text frames to
 *     start a turn. The data payload's `response` field is a Responses-API
 *     request body (model, input, instructions, stream, tools, …).
 *   - Server streams `response.*` events back as SSE-framed text frames
 *     (response.created → … → response.completed | response.failed).
 *
 * Hybrid transport, decided per-turn by the routed provider:
 *   - codex provider → PASSTHROUGH: connect to OpenAI's native
 *     wss://.../backend-api/codex/responses with the account's auth headers,
 *     forward the client's response.create verbatim, pipe response.* events
 *     back byte-for-byte. Preserves encrypted_content / reasoning state (the
 *     whole reason codex-lb uses WS). No double-translation.
 *   - any other provider → TERMINATE & TRANSLATE: parse response.create into a
 *     ChatCompletionRequest, run it through the existing handleChatCompletion
 *     pipeline, and pump the resulting response.* SSE stream out over the WS.
 *
 * Every turn ends with exactly one terminal event (response.completed on
 * success, response.failed on error / early close). This mirrors codex-lb's
 * "upstream websocket closed before response.completed" contract.
 */
import type { ServerWebSocket } from "bun";
import { providers } from "../proxy/providers/registry";
import { pool } from "../proxy/pool";
import { handleChatCompletion } from "../proxy/index";
import {
  responsesRequestToChat,
  chatStreamToResponsesStream,
  newResponsesResponseMeta,
  type ResponsesApiRequest,
} from "../proxy/transforms/openai-responses";
import type { ChatCompletionRequest } from "../proxy/providers/base";

export interface ResponsesProxySocketData {
  kind: "responses-proxy";
  path: string;
  /** Per-socket session state for an in-flight turn. */
  turn?: TurnSession;
}

interface TurnSession {
  /** Abort the in-flight translate pump or passthrough connection. */
  abort: AbortController;
  /** For passthrough mode: the upstream WebSocket to [AI-LAB-B]. */
  upstream?: WebSocket;
  /** For translate mode: a resolver invoked when the pump finishes, for cleanup. */
  done?: () => void;
}

const encoder = new TextEncoder();

/** Parse one or more SSE-framed events out of a text buffer. Returns the events.
 *  Exported for direct unit testing (the handler is otherwise hard to test in
 *  isolation — it drives a WebSocket pump). */
export function parseSseEvents(text: string): { event: string; data: string }[] {
  const out: { event: string; data: string }[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        // WHATWG event-stream spec: join multiple data: field values with a
        // single U+000A LINE FEED between them, and strip only ONE leading
        // space (not all whitespace). The old code joined with no separator
        // and .trim()'d — corrupting multi-line JSON payloads.
        const value = line.slice(5).replace(/^ /, "");
        data = data ? data + "\n" + value : value;
      }
    }
    if (event) out.push({ event, data });
  }
  return out;
}

/** Extract the Responses-API request from a `response.create` SSE payload. */
function extractResponsesRequest(data: string): ResponsesApiRequest | null {
  try {
    const parsed = JSON.parse(data);
    // The Realtime protocol wraps the request under `response`; some clients
    // send it flat. Accept both.
    const req = parsed?.response ?? parsed;
    if (!req?.model) return null;
    return req as ResponsesApiRequest;
  } catch {
    return null;
  }
}

/** Send an SSE-framed event to the client over the WS. Returns ws.send result. */
function sendSse(ws: ServerWebSocket<ResponsesProxySocketData>, event: string, data: unknown): number {
  const json = typeof data === "string" ? data : JSON.stringify(data);
  return ws.send(`event: ${event}\ndata: ${json}\n\n`);
}

function makeResponseId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `resp_${ts}${rand}`;
}

/**
 * Determine whether a model routes to the codex provider (passthrough mode).
 */
function isCodexModel(model: string): boolean {
  return pool.getProviderForModel(model) === "codex";
}

export const responsesProxyHandler = {
  open(ws: ServerWebSocket<ResponsesProxySocketData>) {
    // Nothing to send yet — wait for the client's response.create. The Realtime
    // protocol is client-driven; sending a greeting would confuse strict clients.
  },

  message(ws: ServerWebSocket<ResponsesProxySocketData>, message: string | Buffer) {
    const text = typeof message === "string" ? message : message.toString();
    const events = parseSseEvents(text);

    for (const ev of events) {
      if (ev.event === "response.create") {
        // One response.create per turn. If a turn is already in flight, ignore
        // the new one (the client must wait for the terminal event or cancel).
        if (ws.data.turn) continue;
        handleResponseCreate(ws, ev.data).catch((err) => {
          sendTerminalError(ws, makeResponseId(), err instanceof Error ? err.message : String(err));
        });
      }
      // Other client events (e.g. response.cancel) could be handled here.
    }
  },

  close(ws: ServerWebSocket<ResponsesProxySocketData>) {
    teardownTurn(ws);
  },

  drain(_ws: ServerWebSocket<ResponsesProxySocketData>) {
    // Backpressure relief. For the translate pump we already gate on ws.send()
    // return values inside the pump loop; for passthrough the upstream WS's
    // own buffering applies. No additional action needed here.
  },
};

/** Tear down any in-flight turn for a socket (abort + close upstream). */
function teardownTurn(ws: ServerWebSocket<ResponsesProxySocketData>) {
  const turn = ws.data.turn;
  if (!turn) return;
  turn.abort.abort();
  try { turn.upstream?.close(); } catch { /* already closed */ }
  turn.done?.();
  ws.data.turn = undefined;
}

/** Emit a terminal response.failed event and clear the turn. */
function sendTerminalError(ws: ServerWebSocket<ResponsesProxySocketData>, responseId: string, message: string) {
  try {
    sendSse(ws, "response.failed", {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      error: { type: "api_error", message },
      output: [],
      usage: null,
    });
  } catch { /* socket closed */ }
  ws.data.turn = undefined;
}

async function handleResponseCreate(ws: ServerWebSocket<ResponsesProxySocketData>, data: string) {
  const req = extractResponsesRequest(data);
  if (!req) {
    sendTerminalError(ws, makeResponseId(), "Invalid response.create payload: missing model");
    return;
  }

  const responseId = makeResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  const abort = new AbortController();
  ws.data.turn = { abort };

  if (isCodexModel(req.model)) {
    await runPassthrough(ws, req, responseId, createdAt, abort);
  } else {
    await runTranslate(ws, req, responseId, createdAt, abort);
  }
}

/* ------------------------------------------------------------------ */
/* Translate mode (non-codex providers)                                */
/* ------------------------------------------------------------------ */

async function runTranslate(
  ws: ServerWebSocket<ResponsesProxySocketData>,
  req: ResponsesApiRequest,
  responseId: string,
  createdAt: number,
  abort: AbortController
) {
  let chatRequest: ChatCompletionRequest;
  try {
    chatRequest = responsesRequestToChat(req);
  } catch (e) {
    sendTerminalError(ws, responseId, `Invalid request: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  chatRequest.stream = true;

  let result;
  try {
    ({ result } = await handleChatCompletion(chatRequest));
  } catch (e) {
    sendTerminalError(ws, responseId, e instanceof Error ? e.message : String(e));
    return;
  }

  if (!result.stream) {
    sendTerminalError(ws, responseId, "Provider did not return a stream");
    return;
  }

  // Pump the Responses SSE stream out over the WebSocket as text frames.
  const stream = chatStreamToResponsesStream(result.stream, req.model, responseId, createdAt);
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  ws.data.turn!.done = () => {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  };

  try {
    while (true) {
      if (abort.signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      // Respect backpressure: ws.send returns 1 (ok), 0 (buffer full), -1 (closed).
      const sendResult = ws.send(text);
      if (sendResult === -1) break; // socket closed by client
      if (sendResult === 0) {
        // Buffer is full — wait for drain. Yield to the event loop a tick; Bun
        // will call drain() when backpressure relieves, but we also poll
        // briefly so a slow drain doesn't stall the stream indefinitely.
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  } catch (e) {
    // The converter already emits response.failed on source errors; if the
    // pump itself threw before any terminal event, send one now.
    sendTerminalError(ws, responseId, e instanceof Error ? e.message : String(e));
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    ws.data.turn = undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Passthrough mode (codex provider → OpenAI native Responses WS)      */
/* ------------------------------------------------------------------ */

async function runPassthrough(
  ws: ServerWebSocket<ResponsesProxySocketData>,
  req: ResponsesApiRequest,
  responseId: string,
  createdAt: number,
  abort: AbortController
) {
  // Resolve a codex account + the upstream WS context (url + auth headers).
  const account = await pool.getNextAccount("codex");
  if (!account) {
    sendTerminalError(ws, responseId, "No available codex account");
    return;
  }
  const codex = providers["codex"] as any;
  let ctx: { url: string; headers: Record<string, string> };
  try {
    ctx = codex.getUpstreamWebSocketContext(account);
  } catch (e) {
    sendTerminalError(ws, responseId, e instanceof Error ? e.message : String(e));
    return;
  }
  if (!ctx) {
    sendTerminalError(ws, responseId, "Codex account has no valid tokens");
    return;
  }

  // Build the upstream Responses body. The codex provider's makeRequest body
  // (codex.ts:473-484) is exactly the Responses-API shape, so forward the
  // client's request fields directly, forcing stream:true.
  const upstreamBody = {
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    tools: req.tools,
    tool_choice: req.tool_choice ?? (req.tools?.length ? "auto" : undefined),
    parallel_tool_calls: req.tools?.length ? true : undefined,
    store: false,
    stream: true,
    include: [],
    ...(req.reasoning ? { reasoning: req.reasoning } : {}),
  };

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(ctx.url, { headers: ctx.headers } as any);
  } catch (e) {
    sendTerminalError(ws, responseId, `Failed to connect upstream: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  ws.data.turn!.upstream = upstream;

  // Register the WS connection as in-flight so least_inflight balancing counts it
  // and the account isn't over-selected while it serves a live stream. Released in
  // the upstream `close` handler below (the single guaranteed teardown point).
  pool.trackRequestStart(account.id);

  let sawTerminal = false;
  const markTerminal = () => { sawTerminal = true; };

  upstream.addEventListener("open", () => {
    // Forward the client's response.create to the upstream as a
    // response.create event (Realtime protocol). The upstream expects the
    // full request under `response`.
    const createEvent = `event: response.create\ndata: ${JSON.stringify({ type: "response.create", response: upstreamBody })}\n\n`;
    try { upstream.send(createEvent); } catch { /* closed */ }
  });

  upstream.addEventListener("message", (ev: MessageEvent) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    // Pipe upstream response.* events straight to the client. Track terminal
    // events so we know when the turn is done.
    if (text.includes("event: response.completed") || text.includes("event: response.failed") || text.includes("event: response.incomplete")) {
      markTerminal();
    }
    const sendResult = ws.send(text);
    if (sendResult === -1) {
      try { upstream.close(); } catch { /* closed */ }
    }
  });

  upstream.addEventListener("error", () => {
    if (!sawTerminal) {
      sendTerminalError(ws, responseId, "Upstream websocket error");
    }
    try { upstream.close(); } catch { /* ignore */ }
  });

  upstream.addEventListener("close", () => {
    // If the upstream closed without sending a terminal event, synthesize one
    // (codex-lb: "upstream websocket closed before response.completed").
    if (!sawTerminal) {
      sendTerminalError(ws, responseId, "Upstream websocket closed before response.completed");
    }
    ws.data.turn = undefined;
    // Release the in-flight slot and record use so round-robin/sticky rotation
    // advances (lastUsedAt / consecutiveUseCount), mirroring the HTTP translate path.
    pool.trackRequestEnd(account.id);
    void pool.markUsed(account.id, "codex");
  });

  // If the client aborts (close/cancel), close the upstream.
  abort.signal.addEventListener("abort", () => {
    try { upstream.close(); } catch { /* ignore */ }
  });
}
