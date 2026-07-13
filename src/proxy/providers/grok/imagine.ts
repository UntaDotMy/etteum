/**
 * Grok Imagine — image & video generation via api.x.ai
 *
 * Images: POST /v1/images/generations  (OpenAI-compatible)
 * Videos: POST /v1/videos/generations  + poll GET /v1/videos/{id}
 *
 * Auth: Bearer xAI API key or account OAuth access_token (when entitled).
 */
import type { Account } from "../../../db/schema";
import {
  ensureFreshAccessToken,
  getOAuthTokens,
  isOAuthAccount,
} from "./oauth";

export const GROK_IMAGINE_IMAGE_MODELS = [
  "grok-imagine-image",
  "grok-imagine-image-quality",
  "grok-imagine-image-pro",
  "grok-imagine-image-quality-latest",
] as const;

export const GROK_IMAGINE_VIDEO_MODELS = [
  "grok-imagine-video",
  "grok-imagine-video-1.5",
] as const;

const XAI_API = "https://api.x.ai/v1";

export function isGrokImagineImageModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("grok-imagine-image") ||
    (GROK_IMAGINE_IMAGE_MODELS as readonly string[]).includes(m)
  );
}

export function isGrokImagineVideoModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("grok-imagine-video") ||
    (GROK_IMAGINE_VIDEO_MODELS as readonly string[]).includes(m)
  );
}

export function isGrokImagineModel(model: string): boolean {
  return isGrokImagineImageModel(model) || isGrokImagineVideoModel(model);
}

/** Normalize aliases to a canonical API model id. */
export function resolveImagineModelId(model: string): string {
  const m = model.toLowerCase().trim();
  if (m === "grok-imagine-image-pro" || m === "grok-imagine-image-quality-latest") {
    return "grok-imagine-image-quality";
  }
  if (m.startsWith("grok-imagine-image-quality")) return "grok-imagine-image-quality";
  if (m.startsWith("grok-imagine-image")) return "grok-imagine-image";
  if (m.includes("video-1.5") || m === "grok-imagine-video-1.5") return "grok-imagine-video-1.5";
  if (m.startsWith("grok-imagine-video")) return "grok-imagine-video";
  return model;
}

async function resolveBearer(account: Account): Promise<string | null> {
  // Prefer explicit xAI API key on the account or env (Imagine is a paid API surface).
  const tokens =
    typeof account.tokens === "string"
      ? (() => {
          try {
            return JSON.parse(account.tokens as string) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : (account.tokens as Record<string, unknown> | null);

  const apiKey =
    (typeof tokens?.apiKey === "string" && tokens.apiKey) ||
    (typeof tokens?.api_key === "string" && tokens.api_key) ||
    process.env.XAI_API_KEY ||
    process.env.GROK_API_KEY ||
    "";

  if (apiKey.trim()) return apiKey.trim();

  if (isOAuthAccount(account)) {
    const bearer = await ensureFreshAccessToken(account);
    if (bearer) return bearer;
    return getOAuthTokens(account)?.access_token || null;
  }

  const sso = tokens?.sso;
  if (typeof sso === "string" && sso) return sso;

  return null;
}

export interface ImagineResult {
  ok: boolean;
  urls: string[];
  error?: string;
  raw?: unknown;
}

/**
 * Text → image via Grok Imagine.
 */
export async function grokImagineGenerateImage(
  account: Account,
  opts: {
    prompt: string;
    model: string;
    n?: number;
    aspectRatio?: string;
  },
): Promise<ImagineResult> {
  const bearer = await resolveBearer(account);
  if (!bearer) {
    return {
      ok: false,
      urls: [],
      error:
        "No xAI credentials for Imagine. Set account apiKey / XAI_API_KEY, or use a Grok OAuth account.",
    };
  }

  const model = resolveImagineModelId(opts.model);
  const n = Math.min(10, Math.max(1, opts.n ?? 1));
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    n,
  };
  // xAI accepts aspect_ratio on some clients; pass when present.
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;

  try {
    const res = await fetch(`${XAI_API}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-json */
    }

    if (!res.ok) {
      const msg =
        json?.error?.message ||
        json?.error ||
        text.slice(0, 400) ||
        `HTTP ${res.status}`;
      return {
        ok: false,
        urls: [],
        error: `Grok Imagine image failed: ${msg}`,
        raw: json ?? text.slice(0, 500),
      };
    }

    const urls: string[] = [];
    const data = Array.isArray(json?.data) ? json.data : [];
    for (const item of data) {
      if (typeof item?.url === "string" && item.url) urls.push(item.url);
      else if (typeof item?.b64_json === "string" && item.b64_json) {
        urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    // SDK-style single url
    if (urls.length === 0 && typeof json?.url === "string") urls.push(json.url);

    if (urls.length === 0) {
      return { ok: false, urls: [], error: "Imagine returned no image URL", raw: json };
    }
    return { ok: true, urls, raw: json };
  } catch (e) {
    return {
      ok: false,
      urls: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Text → video via Grok Imagine (async poll).
 */
export async function grokImagineGenerateVideo(
  account: Account,
  opts: {
    prompt: string;
    model: string;
    duration?: number;
    aspectRatio?: string;
    imageUrl?: string;
  },
): Promise<ImagineResult> {
  const bearer = await resolveBearer(account);
  if (!bearer) {
    return {
      ok: false,
      urls: [],
      error:
        "No xAI credentials for Imagine video. Set account apiKey / XAI_API_KEY, or use a Grok OAuth account.",
    };
  }

  const model = resolveImagineModelId(opts.model);
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
  };
  if (opts.duration) body.duration = Math.min(15, Math.max(1, opts.duration));
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (opts.imageUrl) body.image = { url: opts.imageUrl };

  try {
    const start = await fetch(`${XAI_API}/videos/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const startText = await start.text();
    let startJson: any = null;
    try {
      startJson = startText ? JSON.parse(startText) : null;
    } catch {
      /* ignore */
    }

    if (!start.ok) {
      const msg =
        startJson?.error?.message ||
        startJson?.error ||
        startText.slice(0, 400) ||
        `HTTP ${start.status}`;
      return {
        ok: false,
        urls: [],
        error: `Grok Imagine video failed: ${msg}`,
        raw: startJson ?? startText.slice(0, 500),
      };
    }

    // Sync response with URL
    const directUrl =
      startJson?.video?.url ||
      startJson?.url ||
      startJson?.data?.[0]?.url;
    if (typeof directUrl === "string" && directUrl) {
      return { ok: true, urls: [directUrl], raw: startJson };
    }

    const requestId =
      startJson?.request_id || startJson?.id || startJson?.requestId;
    if (!requestId) {
      return {
        ok: false,
        urls: [],
        error: "Video job started but no request_id or URL returned",
        raw: startJson,
      };
    }

    // Poll up to ~5 minutes
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const poll = await fetch(`${XAI_API}/videos/${encodeURIComponent(String(requestId))}`, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
        },
      });
      const pollText = await poll.text();
      let pollJson: any = null;
      try {
        pollJson = pollText ? JSON.parse(pollText) : null;
      } catch {
        continue;
      }
      const status = String(pollJson?.status || "").toLowerCase();
      if (status === "done" || status === "completed" || status === "succeeded") {
        const url =
          pollJson?.video?.url ||
          pollJson?.url ||
          pollJson?.data?.[0]?.url;
        if (typeof url === "string" && url) {
          return { ok: true, urls: [url], raw: pollJson };
        }
        return {
          ok: false,
          urls: [],
          error: "Video done but no URL in response",
          raw: pollJson,
        };
      }
      if (status === "failed" || status === "expired" || status === "error") {
        return {
          ok: false,
          urls: [],
          error: `Video generation ${status}: ${pollJson?.error?.message || pollJson?.error || ""}`,
          raw: pollJson,
        };
      }
    }

    return { ok: false, urls: [], error: "Video generation timed out while polling" };
  } catch (e) {
    return {
      ok: false,
      urls: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
