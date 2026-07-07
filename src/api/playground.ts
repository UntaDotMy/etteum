/**
 * Playground API (F14) — basic-chat, skills, translator-live backends.
 *
 * TS port of 9router's dashboard playground routes:
 *   POST /api/playground/chat          — streaming chat playground (basic-chat)
 *   GET  /api/playground/skills        — static skills catalog
 *   POST /api/playground/translator/load    — load a saved translation sample
 *   POST /api/playground/translator/save   — save a translation sample
 *   POST /api/playground/translator/translate — live translate (calls provider)
 *
 * The basic-chat + translator/translate routes call the live proxy (unlike the
 * existing /api/translator/debug which is a dry-run). The skills route serves a
 * static catalog (the reference's 9router agent skills).
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db/index";
import { kv } from "../db/schema";
import { eq } from "drizzle-orm";
import { handleChatCompletion } from "../proxy/index";
import type { ChatCompletionRequest } from "../proxy/providers/base";

export const playgroundRouter = new Hono();

// ─── Basic-chat playground ───────────────────────────────────────────────────
/**
 * POST /api/playground/chat — streaming chat playground. Accepts an OpenAI-shape
 * request, runs it through the live proxy (handleChatCompletion), and streams
 * the SSE back. Mirrors reference /api/dashboard/chat/completions.
 */
playgroundRouter.post("/chat", async (c) => {
  const body = await c.req.json<ChatCompletionRequest>().catch(() => ({}) as ChatCompletionRequest);
  if (!body.model) return c.json({ error: "model required" }, 400);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages required" }, 400);
  }
  // Force streaming for the playground (the reference uses stream:true + SSE).
  body.stream = true;
  try {
    const { result } = await handleChatCompletion(body);
    if (!result.success || !result.stream) {
      return c.json({ error: result.error || "No stream returned" }, 502);
    }
    return streamSSE(c, async (stream) => {
      const reader = result.stream!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) await stream.write(new TextDecoder().decode(value));
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

// ─── Skills catalog ──────────────────────────────────────────────────────────
/** Static skills catalog (mirrors reference shared/constants/skills.js). */
const SKILLS = [
  { id: "chat", name: "Chat", description: "General chat completion", url: "" },
  { id: "image", name: "Image Generation", description: "Generate images via media providers", url: "" },
  { id: "tts", name: "Text-to-Speech", description: "Synthesize speech", url: "" },
  { id: "stt", name: "Speech-to-Text", description: "Transcribe audio", url: "" },
  { id: "embeddings", name: "Embeddings", description: "Vector embeddings", url: "" },
  { id: "web-search", name: "Web Search", description: "Search the web (built-in agent loop)", url: "" },
  { id: "web-fetch", name: "Web Fetch", description: "Fetch a URL's content", url: "" },
  { id: "code", name: "Code", description: "Code generation + completion", url: "" },
];

playgroundRouter.get("/skills", (c) => c.json({ skills: SKILLS }));

// ─── Translator live playground ──────────────────────────────────────────────
// Save/load translation samples in the kv table (scope "translatorSamples").
playgroundRouter.post("/translator/load", async (c) => {
  const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  const id = body.id || "default";
  const [row] = await db.select().from(kv).where(eq(kv.key, `translator:${id}`)).limit(1).catch(() => []);
  if (!row) return c.json({ sample: null });
  try { return c.json({ sample: JSON.parse(row.value) }); }
  catch { return c.json({ sample: row.value }); }
});

playgroundRouter.post("/translator/save", async (c) => {
  const body = await c.req.json<{ id?: string; sample: any }>().catch(() => ({}) as { id?: string; sample: any });
  const id = body.id || "default";
  const key = `translator:${id}`;
  const val = JSON.stringify(body.sample ?? {});
  const [existing] = await db.select().from(kv).where(eq(kv.key, key)).limit(1).catch(() => []);
  if (existing) {
    await db.update(kv).set({ value: val, updatedAt: new Date() }).where(eq(kv.key, key));
  } else {
    await db.insert(kv).values({ scope: "translatorSamples", key, value: val, updatedAt: new Date() });
  }
  return c.json({ success: true, id });
});

/**
 * POST /api/playground/translator/translate — live translate a request (calls
 * the provider). Unlike /api/translator/debug (dry-run), this sends the request
 * upstream and returns the real response. Body: { request, stream? }.
 */
playgroundRouter.post("/translator/translate", async (c) => {
  const body = await c.req.json<{ request: ChatCompletionRequest; stream?: boolean }>().catch(() => ({}) as any);
  const request = body.request;
  if (!request?.model) return c.json({ error: "request.model required" }, 400);
  if (body.stream !== undefined) request.stream = body.stream;
  try {
    const { result } = await handleChatCompletion(request);
    if (!result.success) {
      return c.json({ error: result.error || "Translation failed" }, 502);
    }
    return c.json({ response: result.response });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});
