import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { decrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";

/**
 * Media router — OpenAI-compatible endpoints for non-chat modalities.
 * Closes the Wave-4 media HIGH gaps: /v1/audio/speech (TTS),
 * /v1/audio/transcriptions (STT), /v1/embeddings, /v1/images/generations.
 *
 * Design mirrors the BYOK chat adapter (src/proxy/providers/byok.ts): a media
 * "account" row stores base_url + api_key + supported modalities in its tokens
 * JSON, and these endpoints forward to the upstream with the OpenAI-compatible
 * contract. This lets ONE adapter serve OpenAI, Together, Groq, Voyage, etc.
 * without per-provider code — the user registers a media BYOK account.
 *
 * Storage convention (account row):
 *   provider: "media"
 *   email:    label (e.g. "openai-media")
 *   password: encrypted api key
 *   tokens:   { base_url, format, modalities: ["tts","stt","embeddings","images"], default_models: {...} }
 */

export const mediaRouter = new Hono();

interface MediaAccountTokens {
  base_url: string;
  format: "openai" | "anthropic";
  modalities: string[];
  default_models?: Partial<Record<"tts" | "stt" | "embeddings" | "images", string>>;
  headers?: Record<string, string>;
}

/** Pick the first enabled media account supporting a modality. */
async function getMediaAccount(modality: string): Promise<{ account: typeof accounts.$inferSelect; tokens: MediaAccountTokens; apiKey: string } | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, "media"), eq(accounts.enabled, true), eq(accounts.status, "active")));
  for (const account of rows) {
    let tokens: MediaAccountTokens;
    try {
      tokens = JSON.parse(account.tokens as string) as MediaAccountTokens;
    } catch {
      continue;
    }
    if (!tokens?.base_url || !tokens.modalities?.includes(modality)) continue;
    const apiKey = account.password ? decrypt(account.password) : "";
    return { account, tokens, apiKey };
  }
  return null;
}

function authHeader(tokens: MediaAccountTokens, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(tokens.headers || {}) };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** POST /v1/audio/speech — OpenAI-compatible TTS. */
mediaRouter.post("/v1/audio/speech", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const media = await getMediaAccount("tts");
  if (!media) return c.json({ error: { message: "No media account configured for TTS", type: "invalid_request_error" } }, 503);

  const model = body.model || media.tokens.default_models?.tts || "gpt-4o-mini-tts";
  const url = media.tokens.base_url.replace(/\/$/, "") + "/v1/audio/speech";
  const upstream = await fetch(url, {
    method: "POST",
    headers: authHeader(media.tokens, media.apiKey),
    body: JSON.stringify({ ...body, model }),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return c.json({ error: { message: `TTS upstream error: ${text.slice(0, 500)}`, type: "upstream_error" } }, upstream.status as ContentfulStatusCode);
  }

  // OpenAI returns audio binary (mpeg) — stream it through with the right type.
  const contentType = upstream.headers.get("content-type") || "audio/mpeg";
  const buf = await upstream.arrayBuffer();
  broadcast({ type: "media_request", data: { modality: "tts", model, accountId: media.account.id } });
  return new Response(new Uint8Array(buf), { status: 200, headers: { "content-type": contentType } });
});

/** POST /v1/audio/transcriptions — OpenAI-compatible STT. */
mediaRouter.post("/v1/audio/transcriptions", async (c) => {
  const media = await getMediaAccount("stt");
  if (!media) return c.json({ error: { message: "No media account configured for STT", type: "invalid_request_error" } }, 503);

  const formData = await c.req.formData();
  const model = (formData.get("model") as string) || media.tokens.default_models?.stt || "whisper-1";
  formData.set("model", model);

  const url = media.tokens.base_url.replace(/\/$/, "") + "/v1/audio/transcriptions";
  const headers: Record<string, string> = { ...(media.tokens.headers || {}) };
  if (media.apiKey) headers.authorization = `Bearer ${media.apiKey}`;
  const upstream = await fetch(url, { method: "POST", headers, body: formData });

  const text = await upstream.text();
  if (!upstream.ok) {
    return c.json({ error: { message: `STT upstream error: ${text.slice(0, 500)}`, type: "upstream_error" } }, upstream.status as ContentfulStatusCode);
  }
  broadcast({ type: "media_request", data: { modality: "stt", model, accountId: media.account.id } });
  return new Response(text, { status: 200, headers: { "content-type": upstream.headers.get("content-type") || "application/json" } });
});

/** GET /v1/audio/voices — list available TTS voices (OpenAI-compatible). */
mediaRouter.get("/v1/audio/voices", async (c) => {
  const media = await getMediaAccount("tts");
  if (!media) return c.json({ error: { message: "No media account configured for TTS", type: "invalid_request_error" } }, 503);
  const url = media.tokens.base_url.replace(/\/$/, "") + "/v1/audio/voices";
  const upstream = await fetch(url, { headers: authHeader(media.tokens, media.apiKey) });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json" } });
});

/** POST /v1/embeddings — OpenAI-compatible embeddings. */
mediaRouter.post("/v1/embeddings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const media = await getMediaAccount("embeddings");
  if (!media) return c.json({ error: { message: "No media account configured for embeddings", type: "invalid_request_error" } }, 503);

  const model = body.model || media.tokens.default_models?.embeddings || "text-embedding-3-small";
  const url = media.tokens.base_url.replace(/\/$/, "") + "/v1/embeddings";
  const upstream = await fetch(url, {
    method: "POST",
    headers: authHeader(media.tokens, media.apiKey),
    body: JSON.stringify({ ...body, model }),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    return c.json({ error: { message: `Embeddings upstream error: ${text.slice(0, 500)}`, type: "upstream_error" } }, upstream.status as ContentfulStatusCode);
  }
  broadcast({ type: "media_request", data: { modality: "embeddings", model, accountId: media.account.id } });
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
});

/** POST /v1/images/generations — OpenAI-compatible image generation. */
mediaRouter.post("/v1/images/generations", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const media = await getMediaAccount("images");
  if (!media) return c.json({ error: { message: "No media account configured for image generation", type: "invalid_request_error" } }, 503);

  const model = body.model || media.tokens.default_models?.images || "dall-e-3";
  const url = media.tokens.base_url.replace(/\/$/, "") + "/v1/images/generations";
  const upstream = await fetch(url, {
    method: "POST",
    headers: authHeader(media.tokens, media.apiKey),
    body: JSON.stringify({ ...body, model }),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    return c.json({ error: { message: `Image generation upstream error: ${text.slice(0, 500)}`, type: "upstream_error" } }, upstream.status as ContentfulStatusCode);
  }
  broadcast({ type: "media_request", data: { modality: "images", model, accountId: media.account.id } });
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
});
