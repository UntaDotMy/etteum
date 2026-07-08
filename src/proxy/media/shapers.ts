/**
 * Per-vendor media request shapers + response normalizers.
 *
 * The media catalog declares a `format` per vendor config (elevenlabs,
 * deepgram, stability, fal, openai, generic). The media router accepts
 * OpenAI-shaped requests; these shapers translate the OpenAI-shaped input into
 * the vendor's native request shape and normalize the vendor's response back to
 * the OpenAI-compatible contract the client expects.
 *
 * 1:1 with the reference proxy's per-vendor media handlers
 * (ttsProviders/elevenlabs.js, imageProviders/falAi.js, etc.).
 */

export type MediaFormat = "openai" | "elevenlabs" | "deepgram" | "assemblyai" | "stability" | "fal" | "generic";

export interface ShapedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON body (stringified) or null when the request is form/multipart. */
  body: string | null;
  /** Optional form-data fields when the vendor wants multipart (null otherwise). */
  formData?: FormData | null;
}

export interface ShaperContext {
  baseUrl: string;
  apiKey: string;
  authHeader?: string;
  model: string;
  /** The raw OpenAI-shaped incoming body. */
  input: any;
}

/** Apply auth per the config's authHeader name. */
function applyAuth(headers: Record<string, string>, apiKey: string, authHeader?: string): Record<string, string> {
  if (!apiKey) return headers;
  const name = (authHeader || "authorization").toLowerCase();
  if (name === "authorization" || name === "bearer") headers["Authorization"] = `Bearer ${apiKey}`;
  else if (name === "xi-api-key") headers["xi-api-key"] = apiKey;
  else if (name === "assemblyai-api-key") headers["assemblyai-api-key"] = apiKey;
  else if (name === "token") headers["token"] = apiKey;
  else headers[authHeader!] = apiKey;
  return headers;
}

// ── TTS shapers ─────────────────────────────────────────────────────────

function shapeElevenLabsTTS(ctx: ShaperContext): ShapedRequest {
  // ElevenLabs encodes the voice id in the URL path. The OpenAI `voice` field
  // (or the model, as "model_id/voice_id") selects it.
  let modelId = "eleven_multilingual_v2";
  let voiceId = ctx.input.voice || ctx.model;
  if (ctx.model && ctx.model.includes("/")) {
    const [m, v] = ctx.model.split("/");
    if (m) modelId = m;
    if (v) voiceId = v;
  }
  else if (ctx.input.model && String(ctx.input.model).includes("/")) {
    const [m, v] = String(ctx.input.model).split("/");
    if (m) modelId = m;
    if (v) voiceId = v;
  }
  return {
    url: `${ctx.baseUrl.replace(/\/$/, "")}/${voiceId}`,
    method: "POST",
    headers: applyAuth({ "Content-Type": "application/json" }, ctx.apiKey, ctx.authHeader || "xi-api-key"),
    body: JSON.stringify({
      text: ctx.input.input || ctx.input.text || "",
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  };
}

/** Normalize an ElevenLabs TTS response (raw audio bytes) — pass through. */
function normalizeElevenLabsTTS(buf: ArrayBuffer, _ctx: ShaperContext): { body: Uint8Array; contentType: string } {
  return { body: new Uint8Array(buf), contentType: "audio/mpeg" };
}

// ── STT shapers ─────────────────────────────────────────────────────────

function shapeDeepgramSTT(ctx: ShaperContext): ShapedRequest {
  // Deepgram: POST audio bytes (multipart) to /v1/listen?model=...
  const qp = new URLSearchParams({ model: ctx.model });
  if (ctx.input.language) qp.set("language", ctx.input.language);
  return {
    url: `${ctx.baseUrl.replace(/\/$/, "")}?${qp}`,
    method: "POST",
    headers: applyAuth({ "Content-Type": "audio/*" }, ctx.apiKey, ctx.authHeader || "token"),
    body: null,
    formData: null,
  };
}

/** Normalize a Deepgram STT response into the OpenAI transcription shape. */
function normalizeDeepgramSTT(data: any): any {
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  const text = alt?.transcript || "";
  return { text };
}

// ── Image shapers ────────────────────────────────────────────────────────

function shapeStabilityImage(ctx: ShaperContext): ShapedRequest {
  // Stability AI: multipart form with prompt + output_format.
  const fd = new FormData();
  fd.set("prompt", ctx.input.prompt || "");
  fd.set("output_format", ctx.input.response_format || "png");
  if (ctx.input.n && ctx.input.n > 1) fd.set("seed", "0");
  return {
    url: ctx.baseUrl.replace(/\/$/, ""),
    method: "POST",
    headers: applyAuth({ Accept: "application/json" }, ctx.apiKey, ctx.authHeader || "authorization"),
    body: null,
    formData: fd,
  };
}

/** Normalize a Stability AI image response into the OpenAI image shape. */
function normalizeStabilityImage(data: any): any {
  const images = Array.isArray(data?.artifacts) ? data.artifacts : [];
  return {
    created: Math.floor(Date.now() / 1000),
    data: images.map((a: any) => ({ b64_json: a.base64 })),
  };
}

function shapeFalImage(ctx: ShaperContext): ShapedRequest {
  // Fal.ai: POST JSON { prompt, image_size, num_images } to baseUrl/<model>.
  const req: any = { prompt: ctx.input.prompt, num_images: ctx.input.n || 1 };
  if (ctx.input.size) {
    // OpenAI size "1024x1024" → fal aspect ratio (best-effort square/landscape).
    req.image_size = ctx.input.size === "1024x1024" ? "square_hd" : "landscape_4_3";
  }
  return {
    url: `${ctx.baseUrl.replace(/\/$/, "")}/${ctx.model}`,
    method: "POST",
    headers: applyAuth({ "Content-Type": "application/json" }, ctx.apiKey, ctx.authHeader || "authorization"),
    body: JSON.stringify(req),
  };
}

/** Normalize a fal.ai image response (sync) into the OpenAI image shape. */
function normalizeFalImage(data: any): any {
  const images = Array.isArray(data?.images) ? data.images : (data?.image ? [data.image] : []);
  return {
    created: Math.floor(Date.now() / 1000),
    data: images.map((img: any) => ({ url: typeof img === "string" ? img : img.url })),
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/** Build a vendor-native request from an OpenAI-shaped input. */
export function shapeMediaRequest(format: MediaFormat, modality: "tts" | "stt" | "images", ctx: ShaperContext): ShapedRequest | null {
  if (modality === "tts" && format === "elevenlabs") return shapeElevenLabsTTS(ctx);
  if (modality === "stt" && format === "deepgram") return shapeDeepgramSTT(ctx);
  if (modality === "images" && format === "stability") return shapeStabilityImage(ctx);
  if (modality === "images" && format === "fal") return shapeFalImage(ctx);
  // openai / generic / unsupported modality+format combos fall through to the
  // router's default OpenAI-shaped pass-through.
  return null;
}

/** Normalize a vendor-native response back to the OpenAI-compatible contract. */
export function normalizeMediaResponse(format: MediaFormat, modality: "tts" | "stt" | "images", payload: any, ctx: ShaperContext): any | null {
  if (modality === "tts" && format === "elevenlabs") return normalizeElevenLabsTTS(payload, ctx);
  if (modality === "stt" && format === "deepgram") return normalizeDeepgramSTT(payload);
  if (modality === "images" && format === "stability") return normalizeStabilityImage(payload);
  if (modality === "images" && format === "fal") return normalizeFalImage(payload);
  return null;
}

/** Whether a format+modality has a dedicated (non-pass-through) shaper. */
export function hasShaper(format: MediaFormat, modality: "tts" | "stt" | "images"): boolean {
  return shapeMediaRequest(format, modality, { baseUrl: "", apiKey: "", model: "", input: {} }) !== null;
}
