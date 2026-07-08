/**
 * Media-provider catalog — vendor-specific ttsConfig/sttConfig/imageConfig/embeddingConfig.
 * TS port of the reference proxy's open-sse/providers/registry media adapters, consolidated
 * into one data-driven catalog. Closes the media-breadth gap structurally: any
 * vendor here is servable via the generic media router once a user registers an
 * API key, instead of needing a per-vendor adapter file.
 *
 * Each entry mirrors the reference proxy's registry shape: serviceKinds + per-modality config.
 */
export type MediaModality = "tts" | "stt" | "embeddings" | "images";

export interface MediaModel {
  id: string;
  name?: string;
}

export interface MediaConfig {
  baseUrl: string;
  authType: "apikey" | "bearer" | "none";
  authHeader?: string; // header name for the api key (default: authorization)
  format: "openai" | "elevenlabs" | "deepgram" | "assemblyai" | "stability" | "fal" | "generic";
  models?: MediaModel[];
  /** Path suffix appended to baseUrl for the request (default depends on modality). */
  path?: string;
}

export interface MediaProviderEntry {
  id: string;
  name: string;
  category: "apikey" | "free";
  serviceKinds: MediaModality[];
  ttsConfig?: MediaConfig;
  sttConfig?: MediaConfig;
  embeddingConfig?: MediaConfig;
  imageConfig?: MediaConfig;
  apiKeyUrl?: string;
  color?: string;
}

export const MEDIA_CATALOG: MediaProviderEntry[] = [
  // --- TTS ---
  {
    id: "elevenlabs", name: "ElevenLabs", category: "apikey", serviceKinds: ["tts"], color: "#6C47FF",
    apiKeyUrl: "https://elevenlabs.io/app/settings/api-keys",
    ttsConfig: { baseUrl: "https://api.elevenlabs.io/v1/text-to-speech", authType: "apikey", authHeader: "xi-api-key", format: "elevenlabs", models: [{ id: "eleven_multilingual_v2", name: "Multilingual v2" }, { id: "eleven_turbo_v2_5", name: "Turbo v2.5" }] },
  },
  {
    id: "aws-polly", name: "Amazon Polly", category: "apikey", serviceKinds: ["tts"],
    ttsConfig: { baseUrl: "https://polly.us-east-1.amazonaws.com/v1/speech", authType: "apikey", format: "generic", models: [{ id: "standard", name: "Standard" }, { id: "neural", name: "Neural" }] },
  },
  {
    id: "cartesia", name: "Cartesia", category: "apikey", serviceKinds: ["tts"],
    ttsConfig: { baseUrl: "https://api.cartesia.ai/tts/bytes", authType: "bearer", format: "generic", models: [{ id: "sonic-2", name: "Sonic 2" }] },
  },
  {
    id: "playht", name: "PlayHT", category: "apikey", serviceKinds: ["tts"],
    ttsConfig: { baseUrl: "https://api.play.ht/api/v2/tts/stream", authType: "apikey", authHeader: "X-USER-ID", format: "generic" },
  },
  {
    id: "google-tts", name: "Google Cloud TTS", category: "apikey", serviceKinds: ["tts"],
    ttsConfig: { baseUrl: "https://texttospeech.googleapis.com/v1/text:synthesize", authType: "bearer", format: "generic" },
  },
  {
    id: "edge-tts", name: "Microsoft Edge TTS", category: "free", serviceKinds: ["tts"],
    ttsConfig: { baseUrl: "https://speech.platform.bing.com/consumer/speech/synthesize", authType: "none", format: "generic" },
  },
  // --- STT ---
  {
    id: "deepgram", name: "Deepgram", category: "apikey", serviceKinds: ["stt"],
    sttConfig: { baseUrl: "https://api.deepgram.com/v1/listen", authType: "bearer", format: "deepgram", models: [{ id: "nova-2", name: "Nova-2" }] },
  },
  {
    id: "assemblyai", name: "AssemblyAI", category: "apikey", serviceKinds: ["stt"],
    sttConfig: { baseUrl: "https://api.assemblyai.com/v2/transcript", authType: "apikey", authHeader: "assemblyai-api-key", format: "assemblyai" },
  },
  {
    id: "openai-whisper", name: "OpenAI Whisper", category: "apikey", serviceKinds: ["stt"],
    sttConfig: { baseUrl: "https://api.openai.com/v1/audio/transcriptions", authType: "bearer", format: "openai", models: [{ id: "whisper-1", name: "Whisper" }] },
  },
  // --- Image generation ---
  {
    id: "black-forest-labs", name: "Black Forest Labs (FLUX)", category: "apikey", serviceKinds: ["images"],
    imageConfig: { baseUrl: "https://api.bfl.ai/v1/flux-1.1-pro", authType: "bearer", format: "fal", models: [{ id: "flux-1.1-pro", name: "FLUX 1.1 Pro" }] },
  },
  {
    id: "stability-ai", name: "Stability AI", category: "apikey", serviceKinds: ["images"],
    imageConfig: { baseUrl: "https://api.stability.ai/v2beta/stable-image/generate", authType: "bearer", format: "stability", models: [{ id: "stable-image-core", name: "Core" }, { id: "stable-image-ultra", name: "Ultra" }] },
  },
  {
    id: "fal-ai", name: "Fal.ai", category: "apikey", serviceKinds: ["images"],
    imageConfig: { baseUrl: "https://fal.run", authType: "apikey", authHeader: "Authorization", format: "fal", models: [{ id: "flux/schnell", name: "FLUX Schnell" }] },
  },
  {
    id: "recraft", name: "Recraft", category: "apikey", serviceKinds: ["images"],
    imageConfig: { baseUrl: "https://external.api.recraft.ai/v1/images/generations", authType: "bearer", format: "openai" },
  },
  {
    id: "runwayml", name: "RunwayML", category: "apikey", serviceKinds: ["images"],
    imageConfig: { baseUrl: "https://api.runwayml.com/v1/image_to_video", authType: "bearer", format: "generic", models: [{ id: "gen4", name: "Gen-4" }] },
  },
  {
    id: "cloudflare-ai", name: "Cloudflare AI", category: "apikey", serviceKinds: ["images", "tts"],
    imageConfig: { baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run", authType: "bearer", format: "generic" },
    ttsConfig: { baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run", authType: "bearer", format: "generic" },
  },
  // --- Embeddings ---
  {
    id: "voyage-ai", name: "Voyage AI", category: "apikey", serviceKinds: ["embeddings"],
    embeddingConfig: { baseUrl: "https://api.voyageai.com/v1/embeddings", authType: "bearer", format: "openai", models: [{ id: "voyage-3", name: "Voyage 3" }, { id: "voyage-3-lite", name: "Voyage 3 Lite" }] },
  },
  {
    id: "cohere", name: "Cohere", category: "apikey", serviceKinds: ["embeddings"],
    embeddingConfig: { baseUrl: "https://api.cohere.ai/v1/embed", authType: "bearer", format: "generic", models: [{ id: "embed-english-v3.0", name: "English v3" }] },
  },
  {
    id: "jina-ai", name: "Jina AI", category: "apikey", serviceKinds: ["embeddings"],
    embeddingConfig: { baseUrl: "https://api.jina.ai/v1/embeddings", authType: "bearer", format: "openai", models: [{ id: "jina-embeddings-v3", name: "v3" }] },
  },
];

/** Look up a media provider by id. */
export function getMediaProvider(id: string): MediaProviderEntry | null {
  return MEDIA_CATALOG.find((p) => p.id === id) || null;
}

/** List providers supporting a given modality. */
export function listMediaProviders(modality?: MediaModality): MediaProviderEntry[] {
  if (!modality) return MEDIA_CATALOG;
  return MEDIA_CATALOG.filter((p) => p.serviceKinds.includes(modality));
}
