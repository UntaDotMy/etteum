/**
 * Grok image generation via cli-chat-proxy Responses API + image_generation tool.
 *
 * Contract (live Grok CLI / cli-chat-proxy):
 *   POST https://cli-chat-proxy.grok.com/v1/responses
 *   body: {
 *     model: "grok-4.5",
 *     input: [{ role: "user", content: [{ type: "input_text", text: "..." }] }],
 *     tools: [{ type: "image_generation" }],
 *     stream: false
 *   }
 *   response: items/output with type "image_generation_call", result = base64 JPEG
 *
 * Auth matches Grok OAuth chat: Bearer access_token + x-grok-client-version.
 * Not a separate /v1/images endpoint and not the removed grok-imagine-* models.
 */

import type { Account } from "../../../db/schema";
import {
  ensureFreshAccessToken,
  getOAuthTokens,
  GROK_OAUTH,
  isOAuthAccount,
} from "./oauth";
import { buildCliProxyHeaders } from "./cli-proxy-wire";

/** Catalog model id for Image Studio / Chat media generation. */
export const GROK_IMAGE_MODEL = "grok-image";

/** Upstream chat model that hosts the image_generation tool. */
export const GROK_IMAGE_UPSTREAM_MODEL = "grok-4.5";

export function isGrokImageModel(model: string | null | undefined): boolean {
  const m = (model || "").toLowerCase().trim();
  return m === GROK_IMAGE_MODEL || m === "grok-4.5-image" || m === "grok-image-generation";
}

export interface GrokImageResult {
  ok: boolean;
  /** data:image/jpeg;base64,... (or png) URLs for markdown / Image Studio. */
  urls: string[];
  error?: string;
  raw?: unknown;
}

async function resolveBearer(account: Account): Promise<string | null> {
  if (isOAuthAccount(account)) {
    const bearer = await ensureFreshAccessToken(account);
    if (bearer) return bearer;
    return getOAuthTokens(account)?.access_token || null;
  }

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
  return null;
}

async function cliProxyHeaders(bearer: string): Promise<Record<string, string>> {
  return buildCliProxyHeaders(bearer, {
    modelOverride: GROK_IMAGE_UPSTREAM_MODEL,
    accept: "application/json",
    surface: "grok-shell",
    identifier: "grok-build",
  });
}

function looksLikeBase64Image(s: string): boolean {
  if (!s || s.length < 64) return false;
  // Strip optional data-url prefix for detection.
  const b64 = s.includes("base64,") ? s.split("base64,").pop()! : s;
  if (b64.length < 64) return false;
  // JPEG / PNG magic in base64
  return (
    b64.startsWith("/9j/") || // JPEG
    b64.startsWith("iVBOR") || // PNG
    b64.startsWith("R0lGOD") || // GIF
    b64.startsWith("UklGR") // WEBP (RIFF)
  );
}

function toDataUrl(b64OrDataUrl: string): string {
  const s = b64OrDataUrl.trim();
  if (s.startsWith("data:image/")) return s;
  const mime = s.startsWith("iVBOR")
    ? "image/png"
    : s.startsWith("R0lGOD")
      ? "image/gif"
      : s.startsWith("UklGR")
        ? "image/webp"
        : "image/jpeg";
  return `data:${mime};base64,${s}`;
}

/**
 * Walk a Responses / tool-call style JSON payload and collect image base64.
 */
export function extractImageGenerationBase64(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return;
    const t = v.trim();
    if (!looksLikeBase64Image(t) && !t.startsWith("data:image/")) return;
    const url = toDataUrl(t);
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  const visit = (node: unknown, depth: number) => {
    if (node == null || depth > 12) return;
    if (typeof node === "string") {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;

    const type = String(o.type || o.item_type || "").toLowerCase();
    if (
      type === "image_generation_call" ||
      type === "image_generation" ||
      type.includes("image_generation")
    ) {
      push(o.result);
      push(o.image);
      push(o.b64_json);
      push(o.base64);
      if (o.output && typeof o.output === "object") {
        const outObj = o.output as Record<string, unknown>;
        push(outObj.result);
        push(outObj.b64_json);
        push(outObj.base64);
      }
    }

    // OpenAI-ish image data array
    if (Array.isArray(o.data)) {
      for (const d of o.data) {
        if (d && typeof d === "object") {
          const row = d as Record<string, unknown>;
          push(row.b64_json);
          push(row.base64);
          if (typeof row.url === "string" && row.url.startsWith("data:image/")) push(row.url);
        }
      }
    }

    for (const key of ["output", "items", "response", "content", "results", "choices"]) {
      if (key in o) visit(o[key], depth + 1);
    }
  };

  visit(payload, 0);
  return out;
}

/**
 * Build the Responses API body for one image generation call.
 */
export function buildGrokImageResponsesBody(prompt: string): Record<string, unknown> {
  const text =
    `Generate an image: ${prompt.trim()}. Use the image_generation tool.`;
  return {
    model: GROK_IMAGE_UPSTREAM_MODEL,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ],
    tools: [{ type: "image_generation" }],
    stream: false,
  };
}

/**
 * Generate image(s) via cli-chat-proxy /v1/responses + image_generation tool.
 * `n` is sequential calls (API returns one image_generation_call per request).
 */
export async function grokGenerateImage(
  account: Account,
  opts: { prompt: string; n?: number },
): Promise<GrokImageResult> {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) {
    return { ok: false, urls: [], error: "Empty prompt for Grok image generation" };
  }

  const bearer = await resolveBearer(account);
  if (!bearer) {
    return {
      ok: false,
      urls: [],
      error:
        "No Grok OAuth credentials for image generation. Import a Grok refresh token (same as chat).",
    };
  }

  const n = Math.min(4, Math.max(1, Math.floor(opts.n ?? 1)));
  const headers = await cliProxyHeaders(bearer);
  const urls: string[] = [];
  let lastRaw: unknown;
  let lastError: string | undefined;

  for (let i = 0; i < n; i++) {
    try {
      const res = await fetch(`${GROK_OAUTH.apiBaseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildGrokImageResponsesBody(prompt)),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-json */
      }
      lastRaw = json ?? text.slice(0, 500);

      if (!res.ok) {
        const msg =
          (json as any)?.error?.message ||
          (json as any)?.error ||
          text.slice(0, 400) ||
          `HTTP ${res.status}`;
        lastError = `Grok image failed (cli-chat-proxy /responses): ${msg}`;
        // Exhaustion / auth should fail the whole batch immediately.
        if (
          res.status === 401 ||
          res.status === 402 ||
          res.status === 403 ||
          /free-usage-exhausted|quota|credit|payment/i.test(String(msg))
        ) {
          return { ok: false, urls, error: lastError, raw: lastRaw };
        }
        continue;
      }

      const found = extractImageGenerationBase64(json);
      if (found.length === 0) {
        lastError =
          "Grok image response had no image_generation_call result (base64)";
        continue;
      }
      urls.push(...found);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (urls.length === 0) {
    return {
      ok: false,
      urls: [],
      error: lastError || "Grok image generation returned no images",
      raw: lastRaw,
    };
  }

  return { ok: true, urls, raw: lastRaw };
}
