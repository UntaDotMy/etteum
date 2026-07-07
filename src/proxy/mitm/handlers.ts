/**
 * MITM per-tool request handlers (F10).
 * Ported from 9router src/mitm/handlers/{antigravity,copilot,kiro,cursor}.js.
 *
 * Each handler: parse the intercepted request body → remap body.model via the
 * alias DB + synonyms → forward to the local router (/v1/chat/completions) →
 * pipe the SSE/response back to the IDE. The router resolves the alias to a
 * real in-pool model + handles fallback/translation.
 */
import { MITM_ROUTER_BASE_URL } from "./paths";
import { MODEL_SYNONYMS, MODEL_NO_MAP } from "./config";

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
    accept: headers.accept as string || "text/event-stream",
    "x-request-source": "mitm",
  };
  // Preserve an authorization header if present (some flows carry the vendor token;
  // the router ignores it and uses pool accounts, but pass it for completeness).
  const auth = headers.authorization as string | undefined;
  if (auth) fwdHeaders.authorization = auth;

  const url = `${MITM_ROUTER_BASE_URL.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, { method, headers: fwdHeaders, body: method === "GET" || method === "HEAD" ? undefined : body });

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });

  // Stream the response back (SSE or JSON).
  if (res.body) {
    return { status: res.status, headers: respHeaders, body: res.body as unknown as ReadableStream<Uint8Array> };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: respHeaders, body: buf };
}

/** Common handler: JSON body, remap model, forward to /v1/chat/completions. */
async function handleJsonChat(tool: string, req: MitmRequest): Promise<MitmHandlerResult> {
  let parsed: any;
  try { parsed = JSON.parse(req.body.toString("utf8")); }
  catch { return { status: 400, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "invalid JSON" })) }; }

  if (parsed.model) parsed.model = await remapModel(tool, parsed.model);
  // Some vendors nest the model under request.modelConfig.model etc.; remap any
  // top-level string `model` field we find.
  if (parsed.request?.modelConfig?.model) {
    parsed.request.modelConfig.model = await remapModel(tool, parsed.request.modelConfig.model);
  }

  const rewritten = Buffer.from(JSON.stringify(parsed), "utf8");
  return forwardToRouter("/chat/completions", "POST", req.headers, rewritten, "application/json");
}

/** Antigravity (Gemini Code): generateContent endpoint, Gemini-shape body. */
export async function handleAntigravity(req: MitmRequest): Promise<MitmHandlerResult> {
  // Antigravity sends Gemini generateContent bodies. The router's /v1/chat/completions
  // expects OpenAI shape; rather than translate Gemini→OpenAI here (the antigravity
  // provider already does OpenAI→Gemini for outbound), we forward the body and let
  // the router handle it via the model alias → antigravity provider. The model id
  // in the Gemini body is under contents/model.
  return handleJsonChat("antigravity", req);
}

/** Copilot: OpenAI-shape chat completions. */
export async function handleCopilot(req: MitmRequest): Promise<MitmHandlerResult> {
  return handleJsonChat("copilot", req);
}

/** Kiro: CodeWhisperer generateAssistantResponse (eventstream). */
export async function handleKiro(req: MitmRequest): Promise<MitmHandlerResult> {
  // Kiro uses AWS eventstream; the model id is in the body. We remap + forward;
  // the kiro provider handles the wire format.
  return handleJsonChat("kiro", req);
}

/** Cursor: Connect proto (BidiAppend/RunSSE/RunPoll/Run). */
export async function handleCursor(req: MitmRequest): Promise<MitmHandlerResult> {
  return handleJsonChat("cursor", req);
}

/** Dispatch by tool id. */
export async function handleToolRequest(tool: string, req: MitmRequest): Promise<MitmHandlerResult> {
  switch (tool) {
    case "antigravity": return handleAntigravity(req);
    case "copilot": return handleCopilot(req);
    case "kiro": return handleKiro(req);
    case "cursor": return handleCursor(req);
    default: return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: `unknown tool: ${tool}` })) };
  }
}
