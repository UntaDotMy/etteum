import { describe, test, expect } from "bun:test";
import { shapeMediaRequest, normalizeMediaResponse, hasShaper, type MediaFormat } from "../../src/proxy/media/shapers";

/**
 * Hermetic tests for the per-vendor media shapers. Pure functions: build a
 * vendor-native request from an OpenAI-shaped input, and normalize a vendor
 * response back to the OpenAI contract. No network.
 */

const ctx = (overrides: Partial<{ baseUrl: string; apiKey: string; authHeader?: string; model: string; input: any }> = {}) => ({
  baseUrl: "https://api.elevenlabs.io/v1/text-to-speech",
  apiKey: "test-key",
  model: "eleven_multilingual_v2",
  input: { input: "hello world", voice: "v1" },
  ...overrides,
});

describe("media shaper dispatch", () => {
  test("hasShaper is true only for supported format+modality pairs", () => {
    expect(hasShaper("elevenlabs", "tts")).toBe(true);
    expect(hasShaper("deepgram", "stt")).toBe(true);
    expect(hasShaper("stability", "images")).toBe(true);
    expect(hasShaper("fal", "images")).toBe(true);
    // Unsupported combos fall through to OpenAI pass-through.
    expect(hasShaper("openai", "tts")).toBe(false);
    expect(hasShaper("elevenlabs", "images")).toBe(false);
    expect(hasShaper("generic", "stt")).toBe(false);
  });

  test("returns null for openai/generic (pass-through)", () => {
    expect(shapeMediaRequest("openai", "tts", ctx())).toBeNull();
    expect(shapeMediaRequest("generic", "images", ctx())).toBeNull();
  });
});

describe("elevenlabs TTS shaping", () => {
  test("builds the voice-id URL + xi-api-key + {text, model_id, voice_settings}", () => {
    const shaped = shapeMediaRequest("elevenlabs", "tts", ctx())!;
    expect(shaped.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/v1");
    expect(shaped.headers["xi-api-key"]).toBe("test-key");
    const body = JSON.parse(shaped.body as string);
    expect(body).toEqual({ text: "hello world", model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
  });

  test("splits model_id/voice_id from the model field", () => {
    const shaped = shapeMediaRequest("elevenlabs", "tts", ctx({ model: "eleven_turbo_v2_5/voiceX", input: { input: "hi" } }))!;
    expect(shaped.url).toContain("/voiceX");
    expect(JSON.parse(shaped.body as string).model_id).toBe("eleven_turbo_v2_5");
  });

  test("normalizes the audio response as raw bytes + audio/mpeg", () => {
    const buf = new ArrayBuffer(8);
    const out = normalizeMediaResponse("elevenlabs", "tts", buf, ctx()) as any;
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.body).toBeInstanceOf(Uint8Array);
  });
});

describe("deepgram STT shaping", () => {
  test("builds /v1/listen?model=... with token auth", () => {
    const shaped = shapeMediaRequest("deepgram", "stt", ctx({ baseUrl: "https://api.deepgram.com/v1/listen", authHeader: "token", model: "nova-3", input: { language: "en" } }))!;
    expect(shaped.url).toContain("https://api.deepgram.com/v1/listen");
    expect(shaped.url).toContain("model=nova-3");
    expect(shaped.url).toContain("language=en");
    expect(shaped.headers["token"]).toBe("test-key");
  });

  test("normalizes the Deepgram transcript into { text }", () => {
    const data = { results: { channels: [{ alternatives: [{ transcript: "hello there" }] }] } };
    const out = normalizeMediaResponse("deepgram", "stt", data, ctx()) as any;
    expect(out).toEqual({ text: "hello there" });
  });

  test("returns empty text when the transcript is missing", () => {
    const out = normalizeMediaResponse("deepgram", "stt", {}, ctx()) as any;
    expect(out).toEqual({ text: "" });
  });
});

describe("stability image shaping", () => {
  test("builds a multipart form with prompt + output_format", () => {
    const shaped = shapeMediaRequest("stability", "images", ctx({ baseUrl: "https://api.stability.ai/v2beta/stable-image/generate", model: "stable-image-core", input: { prompt: "a cat", response_format: "png" } }))!;
    expect(shaped.method).toBe("POST");
    expect(shaped.formData).toBeInstanceOf(FormData);
    expect(shaped.formData!.get("prompt")).toBe("a cat");
    expect(shaped.formData!.get("output_format")).toBe("png");
  });

  test("normalizes artifacts into b64_json data", () => {
    const data = { artifacts: [{ base64: "AAA" }, { base64: "BBB" }] };
    const out = normalizeMediaResponse("stability", "images", data, ctx()) as any;
    expect(out.data).toEqual([{ b64_json: "AAA" }, { b64_json: "BBB" }]);
    expect(typeof out.created).toBe("number");
  });
});

describe("fal image shaping", () => {
  test("builds JSON { prompt, num_images, image_size } to baseUrl/<model>", () => {
    const shaped = shapeMediaRequest("fal", "images", ctx({ baseUrl: "https://fal.run/fal-ai", model: "flux/dev", input: { prompt: "a dog", n: 2, size: "1024x1024" } }))!;
    expect(shaped.url).toBe("https://fal.run/fal-ai/flux/dev");
    expect(shaped.headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(shaped.body as string);
    expect(body).toEqual({ prompt: "a dog", num_images: 2, image_size: "square_hd" });
  });

  test("normalizes images[] into url data", () => {
    const data = { images: [{ url: "https://i/1.png" }, { url: "https://i/2.png" }] };
    const out = normalizeMediaResponse("fal", "images", data, ctx()) as any;
    expect(out.data).toEqual([{ url: "https://i/1.png" }, { url: "https://i/2.png" }]);
  });

  test("normalizes a single image field", () => {
    const data = { image: "https://i/single.png" };
    const out = normalizeMediaResponse("fal", "images", data, ctx()) as any;
    expect(out.data).toEqual([{ url: "https://i/single.png" }]);
  });
});
