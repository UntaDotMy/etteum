/**
 * MITM per-tool request handlers (F10).
 * Ported from the reference proxy src/mitm/handlers/{antigravity,copilot,kiro,cursor}.js.
 *
 * Each handler: parse the intercepted request body → remap body.model via the
 * alias DB + synonyms → forward to the local router (/v1/chat/completions) →
 * pipe the SSE/response back to the IDE. The router resolves the alias to a
 * real in-pool model + handles fallback/translation.
 *
 * Honest protocol support: only OpenAI-shaped JSON chat is rewritten/forwarded
 * as pool traffic. Native eventstream/protobuf vendor bodies return 501 with a
 * clear error (claiming "kiro provider handles the wire format" was false —
 * the local router only accepts OpenAI JSON).
 */
import { MITM_ROUTER_BASE_URL } from "./paths";
import { MODEL_SYNONYMS, MODEL_NO_MAP } from "./config";
import { getActiveApiKey } from "../../api/keys";

export interface MitmRequest {
  method: string;
  url: string;
  host: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface MitmHandlerResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer | ReadableStream<Uint8Array>;
}

/** Read the kv(mitmAlias) map (tool → real model). Lazily imported to avoid a cycle. */
async function getMitmAliases(): Promise<Record<string, string>> {
  try {
    const { db } = require("../../db/index");
    const { kv } = require("../../db/schema");
    const { eq } = require("drizzle-orm");
    const rows = await db.select().from(kv).where(eq(kv.scope, "mitmAlias"));
    const out: Record<string, string> = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  } catch {
    return {};
  }
}

/** Remap a model id: kv alias (per tool) → synonym table → passthrough. */
async function remapModel(tool: string, model: string): Promise<string> {
  if (!model || MODEL_NO_MAP.has(model)) return model;
  const aliases = await getMitmAliases();
  const toolKey = `${tool}:${model}`;
  if (aliases[toolKey]) return aliases[toolKey];
  if (aliases[model]) return aliases[model];
  if (MODEL_SYNONYMS[model]) return MODEL_SYNONYMS[model];
  return model;
}

function looksLikeOpenAiChat(parsed: any): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  // OpenAI chat completions shape
  if (Array.isArray(parsed.messages)) return true;
  // Responses API shape (still JSON, router has /v1/responses)
  if (parsed.input !== undefined && parsed.model) return true;
  return false;
}

function unsupportedProtocol(tool: string, detail: string): MitmHandlerResult {
  return {
    status: 501,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      error: {
        message:
          `MITM tool "${tool}" cannot reshape this vendor protocol into the local pool. ` +
          `${detail} Use an OpenAI-compatible client pointed at the pool, or configure ` +
          `the IDE to speak OpenAI chat completions.`,
        type: "not_implemented",
        tool,
      },
    })),
  };
}

/** Forward the (rewritten) request to the local router and pipe the response back. */
async function forwardToRouter(
  path: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  contentType: string,
): Promise<MitmHandlerResult> {
  // Force JSON content-type for the router; drop hop-by-hop / host headers.
  const fwdHeaders: Record<string, string> = {
    "content-type": contentType.includes("json") ? "application/json" : contentType,
    accept: (headers.accept as string) || "text/event-stream",
    "x-request-source": "mitm",
  };

  // Inject the pool API key — vendor Authorization is NOT a valid pool key,
  // so forwarding it caused permanent 401s on the local router.
  try {
    const poolKey = await getActiveApiKey();
    if (poolKey) {
      fwdHeaders.authorization = `Bearer ${poolKey}`;
    } else {
      const auth = headers.authorization as string | undefined;
      if (auth) fwdHeaders.authorization = auth;
    }
  } catch {
    const auth = headers.authorization as string | undefined;
    if (auth) fwdHeaders.authorization = auth;
  }

  // MITM_ROUTER_BASE_URL already includes /v1; path is like /chat/completions.
  const base = MITM_ROUTER_BASE_URL.replace(/\/$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: fwdHeaders,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });

  if (res.body) {
    return { status: res.status, headers: respHeaders, body: res.body as unknown as ReadableStream<Uint8Array> };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: respHeaders, body: buf };
}

/** Common handler: OpenAI-shaped JSON body, remap model, forward to /v1/chat/completions. */
async function handleJsonChat(tool: string, req: MitmRequest): Promise<MitmHandlerResult> {
  let parsed: any;
  try { parsed = JSON.parse(req.body.toString("utf8")); }
  catch {
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ error: "invalid JSON" })),
    };
  }

  if (!looksLikeOpenAiChat(parsed)) {
    return unsupportedProtocol(
      tool,
      "Body is JSON but not OpenAI chat completions (missing messages[]) or Responses (missing input).",
    );
  }

  if (parsed.model) parsed.model = await remapModel(tool, parsed.model);
  if (parsed.request?.modelConfig?.model) {
    parsed.request.modelConfig.model = await remapModel(tool, parsed.request.modelConfig.model);
  }

  const rewritten = Buffer.from(JSON.stringify(parsed), "utf8");
  // Responses API shape → /responses; otherwise chat completions.
  const path = parsed.input !== undefined && !Array.isArray(parsed.messages)
    ? "/responses"
    : "/chat/completions";
  return forwardToRouter(path, "POST", req.headers, rewritten, "application/json");
}

/** Antigravity (Gemini Code): only OpenAI-shaped JSON is supported. */
export async function handleAntigravity(req: MitmRequest): Promise<MitmHandlerResult> {
  // Native Gemini generateContent is NOT OpenAI JSON — refuse honestly.
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("protobuf") || ct.includes("proto")) {
    return unsupportedProtocol("antigravity", "Protobuf/Gemini native bodies are not reshaped by MITM.");
  }
  return handleJsonChat("antigravity", req);
}

/** Copilot: OpenAI-shape chat completions. */
export async function handleCopilot(req: MitmRequest): Promise<MitmHandlerResult> {
  return handleJsonChat("copilot", req);
}

/** Kiro: AWS eventstream is not OpenAI JSON — refuse unless body is already chat JSON. */
export async function handleKiro(req: MitmRequest): Promise<MitmHandlerResult> {
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("event-stream") || ct.includes("eventstream") || ct.includes("aws")) {
    return unsupportedProtocol(
      "kiro",
      "AWS eventstream (CodeWhisperer) is not reshaped; only OpenAI JSON chat is forwarded.",
    );
  }
  // Heuristic: non-JSON binary bodies
  const head = req.body.subarray(0, Math.min(req.body.length, 8)).toString("utf8");
  if (req.body.length > 0 && !head.trimStart().startsWith("{") && !head.trimStart().startsWith("[")) {
    return unsupportedProtocol(
      "kiro",
      "Non-JSON body detected (likely eventstream). Point the client at the pool OpenAI API instead.",
    );
  }
  return handleJsonChat("kiro", req);
}

/** Cursor: Connect proto is not supported; OpenAI JSON only. */
export async function handleCursor(req: MitmRequest): Promise<MitmHandlerResult> {
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("protobuf") || ct.includes("proto") || ct.includes("connect")) {
    return unsupportedProtocol(
      "cursor",
      "Cursor Connect/protobuf is not reshaped; only OpenAI JSON chat is forwarded.",
    );
  }
  const head = req.body.subarray(0, Math.min(req.body.length, 8)).toString("utf8");
  if (req.body.length > 0 && !head.trimStart().startsWith("{") && !head.trimStart().startsWith("[")) {
    return unsupportedProtocol(
      "cursor",
      "Non-JSON body detected (likely protobuf). Point Cursor at the pool OpenAI API instead.",
    );
  }
  return handleJsonChat("cursor", req);
}

/** Dispatch by tool id. */
export async function handleToolRequest(tool: string, req: MitmRequest): Promise<MitmHandlerResult> {
  switch (tool) {
    case "antigravity": return handleAntigravity(req);
    case "copilot": return handleCopilot(req);
    case "kiro": return handleKiro(req);
    case "cursor": return handleCursor(req);
    default:
      return {
        status: 404,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ error: `unknown tool: ${tool}` })),
      };
  }
}
