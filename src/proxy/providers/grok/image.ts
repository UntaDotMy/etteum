/**
 * Grok image generation — free web first, SuperGrok CLI second.
 *
 * 1) FREE (confirmed on grok.com web for free accounts; public clients
 *    gpt4free Grok / grok2api match this wire):
 *   POST https://grok.com/rest/app-chat/conversations/new
 *   Cookie: sso=…; sso-rw=…
 *   body: enableImageGeneration:true, enableImageStreaming:true, temporary:true
 *   SSE: result.response.modelResponse.generatedImageUrls[]
 *        + streamingImageGenerationResponse.imageUrl
 *   Assets: https://assets.grok.com/<path> (fetch with same SSO cookie → data URL)
 *
 * 2) SUPERGROK-only (official CLI 0.2.112 image_gen tool):
 *   POST https://cli-chat-proxy.grok.com/v1/responses
 *   tools:[{type:"image_generation"}], tool_choice forced
 *   Free/X Basic: "Image generation is a SuperGrok feature…" — do not fleet-retry.
 *
 * Not paid api.x.ai. Not the removed grok-imagine-* catalog models.
 */

import type { Account } from "../../../db/schema";
import {
  ensureFreshAccessToken,
  getOAuthTokens,
  GROK_OAUTH,
  isOAuthAccount,
} from "./oauth";
import { buildCliProxyHeaders } from "./cli-proxy-wire";
import {
  GROK_ENDPOINTS,
  buildChatPayload,
  parseSseEvents,
  resolveGrokAssetUrl,
  StreamAdapter,
} from "./protocol";

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
  /** data:image/…;base64,… or https image URLs for markdown / Image Studio. */
  urls: string[];
  error?: string;
  raw?: unknown;
}

/** Official CLI copy when free/X Basic hits image_gen (Do not retry). */
export const GROK_IMAGE_SUPERGROK_MSG =
  "Image generation is a SuperGrok feature and isn't available on the free or X Basic tier. Unlock via https://grok.com/supergrok (or use canva-image for free Image Studio generation).";

/**
 * True when Grok refused image gen for plan/entitlement (not a flaky account).
 * Router must fail-fast — every free OAuth farm account will hit the same wall.
 */
export function isGrokImageEntitlementError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const n = msg.toLowerCase();
  return (
    n.includes("supergrok") ||
    (n.includes("image generation") &&
      (n.includes("free or x basic") ||
        n.includes("x basic tier") ||
        n.includes("isn't available on the free") ||
        n.includes("not available on the free"))) ||
    n.includes("image_generation_not_entitled") ||
    n.includes("no_web_sso_and_cli_not_entitled") ||
    // Synthesized fail-fast when HTTP 200 but no image payload + SuperGrok text
    (n.includes("no image_generation_call") && n.includes("supergrok"))
  );
}

/** Pull human-readable refusal / status text from a Responses-style payload. */
export function summarizeGrokImageResponseText(payload: unknown): string {
  const bits: string[] = [];
  const seen = new Set<string>();
  const push = (s: unknown) => {
    if (typeof s !== "string") return;
    const t = s.trim();
    if (t.length < 8 || t.length > 2000) return;
    // Skip raw base64 blobs
    if (t.startsWith("/9j/") || t.startsWith("iVBOR") || t.startsWith("data:image/")) return;
    if (seen.has(t)) return;
    seen.add(t);
    bits.push(t);
  };
  const walk = (node: unknown, depth: number) => {
    if (node == null || depth > 10) return;
    if (typeof node === "string") {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    // Prefer message-ish fields
    for (const k of ["message", "text", "refusal", "status", "error", "detail", "reason"]) {
      if (k in o) walk(o[k], depth + 1);
    }
    if (Array.isArray(o.content)) {
      for (const c of o.content) {
        if (c && typeof c === "object") {
          const block = c as Record<string, unknown>;
          push(block.text);
          push(block.output_text);
          push(block.refusal);
        } else {
          walk(c, depth + 1);
        }
      }
    }
    for (const k of ["output", "items", "response", "choices", "results"]) {
      if (k in o) walk(o[k], depth + 1);
    }
  };
  walk(payload, 0);
  return bits.slice(0, 6).join(" | ");
}

function parseAccountTokens(account: Account): Record<string, unknown> | null {
  if (!account.tokens) return null;
  if (typeof account.tokens === "object") return account.tokens as Record<string, unknown>;
  try {
    return JSON.parse(account.tokens as string) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Free web Imagine needs grok.com SSO cookies (farm activates web and should store sso). */
export function getGrokWebSso(account: Account): { sso: string; ssoRw: string } | null {
  const t = parseAccountTokens(account);
  if (!t) return null;
  const sso =
    (typeof t.sso === "string" && t.sso) ||
    (typeof t.sso_cookie === "string" && t.sso_cookie) ||
    "";
  if (!sso.trim()) return null;
  const ssoRw =
    (typeof t.ssoRw === "string" && t.ssoRw) ||
    (typeof t["sso-rw"] === "string" && (t["sso-rw"] as string)) ||
    (typeof t.sso_rw === "string" && t.sso_rw) ||
    sso;
  return { sso: sso.trim(), ssoRw: String(ssoRw).trim() || sso.trim() };
}

async function resolveBearer(account: Account): Promise<string | null> {
  if (isOAuthAccount(account)) {
    const bearer = await ensureFreshAccessToken(account);
    if (bearer) return bearer;
    return getOAuthTokens(account)?.access_token || null;
  }

  const tokens = parseAccountTokens(account);
  const apiKey =
    (typeof tokens?.apiKey === "string" && tokens.apiKey) ||
    (typeof tokens?.api_key === "string" && tokens.api_key) ||
    process.env.XAI_API_KEY ||
    process.env.GROK_API_KEY ||
    "";
  if (apiKey.trim()) return apiKey.trim();
  return null;
}

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Collect free-web asset paths from a full app-chat SSE body (or JSON lines).
 * Paths are relative (users/…/generated/x.jpg) or absolute assets.grok.com URLs.
 */
export function extractWebGeneratedImagePaths(sseOrJsonText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    const t = u.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  const adapter = new StreamAdapter();
  // Prefer SSE event split; also accept raw JSON lines.
  const chunks = sseOrJsonText.includes("\n\n") || sseOrJsonText.includes("data:")
    ? (() => {
        const parts = sseOrJsonText.split(/\n\n+/);
        const data: string[] = [];
        for (const part of parts) {
          data.push(...parseSseEvents(part));
          // bare JSON block without data: prefix
          const bare = part.trim();
          if (bare.startsWith("{")) data.push(bare);
        }
        return data;
      })()
    : sseOrJsonText.split("\n").map((l) => l.replace(/^data:\s?/, "").trim()).filter(Boolean);

  for (const line of chunks) {
    if (!line || line === "[DONE]") continue;
    for (const evt of adapter.feed(line.startsWith("{") ? line : line)) {
      if (evt.type === "image" && evt.imageUrl) push(evt.imageUrl);
    }
    // Direct parse fallback for modelResponse without going through adapter state
    try {
      const obj = JSON.parse(line);
      const resp = obj?.result?.response;
      const urls = resp?.modelResponse?.generatedImageUrls;
      if (Array.isArray(urls)) {
        for (const u of urls) if (typeof u === "string") push(u);
      }
      const streamUrl = resp?.streamingImageGenerationResponse?.imageUrl;
      if (typeof streamUrl === "string") push(streamUrl);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Download assets.grok.com path with SSO cookie → data URL (assets often need auth). */
export async function fetchGrokAssetAsDataUrl(
  pathOrUrl: string,
  sso: { sso: string; ssoRw: string },
): Promise<string | null> {
  const url = resolveGrokAssetUrl(pathOrUrl);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        Cookie: `sso=${sso.sso}; sso-rw=${sso.ssoRw}`,
        "User-Agent": WEB_UA,
        Referer: "https://grok.com/",
        Origin: "https://grok.com",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    let mime = "image/jpeg";
    if (ct.includes("png") || buf[0] === 0x89) mime = "image/png";
    else if (ct.includes("webp")) mime = "image/webp";
    else if (ct.includes("gif") || (buf[0] === 0x47 && buf[1] === 0x49)) mime = "image/gif";
    else if (ct.includes("jpeg") || ct.includes("jpg") || (buf[0] === 0xff && buf[1] === 0xd8)) {
      mime = "image/jpeg";
    }
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Free web Imagine via grok.com app-chat + SSO cookies.
 */
export async function grokGenerateImageViaWeb(
  account: Account,
  opts: { prompt: string; n?: number },
): Promise<GrokImageResult> {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) {
    return { ok: false, urls: [], error: "Empty prompt for Grok image generation" };
  }
  const sso = getGrokWebSso(account);
  if (!sso) {
    return {
      ok: false,
      urls: [],
      error:
        "no_web_sso: Account has no grok.com sso cookie. Free web Imagine needs SSO (farm activate_grok_com must capture sso/sso-rw). OAuth-only tokens cannot call free web image gen.",
    };
  }

  const n = Math.min(4, Math.max(1, Math.floor(opts.n ?? 2)));
  const payload = buildChatPayload({
    message: `Generate an image: ${prompt}`,
    modeId: "AUTO",
    enableImageGeneration: true,
    imageGenerationCount: n,
  });

  try {
    const res = await fetch(GROK_ENDPOINTS.APP_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `sso=${sso.sso}; sso-rw=${sso.ssoRw}`,
        "User-Agent": WEB_UA,
        Accept: "text/event-stream",
        Origin: "https://grok.com",
        Referer: "https://grok.com/",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        urls: [],
        error: `expired: web Imagine HTTP ${res.status} (SSO cookie rejected)`,
        raw: text.slice(0, 500),
      };
    }
    if (res.status === 429) {
      return {
        ok: false,
        urls: [],
        error: `rate_limited: web Imagine HTTP 429 ${text.slice(0, 400)}`,
        raw: text.slice(0, 500),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        urls: [],
        error: `error: web Imagine HTTP ${res.status} ${text.slice(0, 400)}`,
        raw: text.slice(0, 500),
      };
    }

    const paths = extractWebGeneratedImagePaths(text);
    if (paths.length === 0) {
      const hint = summarizeGrokImageResponseText(
        (() => {
          try {
            // try last JSON object in stream
            const lines = text.split("\n").filter((l) => l.includes("{"));
            return JSON.parse(lines[lines.length - 1]!.replace(/^data:\s?/, ""));
          } catch {
            return text.slice(0, 800);
          }
        })(),
      );
      return {
        ok: false,
        urls: [],
        error:
          `web_imagine_no_images: app-chat returned no generatedImageUrls` +
          (hint ? ` (${hint.slice(0, 240)})` : ""),
        raw: text.slice(0, 800),
      };
    }

    const urls: string[] = [];
    for (const p of paths) {
      const dataUrl = await fetchGrokAssetAsDataUrl(p, sso);
      if (dataUrl) {
        urls.push(dataUrl);
      } else {
        // Fall back to absolute URL — some CDNs are public briefly
        const abs = resolveGrokAssetUrl(p);
        if (abs) urls.push(abs);
      }
    }
    if (urls.length === 0) {
      return {
        ok: false,
        urls: [],
        error: "web_imagine_asset_fetch_failed: got paths but could not download assets.grok.com",
        raw: { paths },
      };
    }
    return { ok: true, urls, raw: { paths, count: urls.length } };
  } catch (err) {
    return {
      ok: false,
      urls: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

function looksLikeImageHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  // Asset hosts used by Grok / generic image CDNs; also bare image file URLs.
  if (/\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(s)) return true;
  return /assets\.grok\.com|imaginary\.|cdn\.x\.ai|grok\.com\/.*image/i.test(s);
}

/**
 * Walk a Responses / tool-call style JSON payload and collect image base64
 * or https image URLs (CLI may return either).
 */
export function extractImageGenerationBase64(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return;
    const t = v.trim();
    if (t.startsWith("data:image/") || looksLikeBase64Image(t)) {
      const url = toDataUrl(t);
      if (seen.has(url)) return;
      seen.add(url);
      out.push(url);
      return;
    }
    if (looksLikeImageHttpUrl(t)) {
      if (seen.has(t)) return;
      seen.add(t);
      out.push(t);
    }
  };

  const pushFromObject = (o: Record<string, unknown>) => {
    push(o.result);
    push(o.image);
    push(o.image_url);
    push(o.url);
    push(o.b64_json);
    push(o.base64);
    push(o.data);
    if (o.output && typeof o.output === "object" && !Array.isArray(o.output)) {
      pushFromObject(o.output as Record<string, unknown>);
    }
    if (o.image && typeof o.image === "object" && !Array.isArray(o.image)) {
      pushFromObject(o.image as Record<string, unknown>);
    }
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
      type.includes("image_generation") ||
      type.includes("image_gen")
    ) {
      pushFromObject(o);
    }

    // OpenAI-ish image data array
    if (Array.isArray(o.data)) {
      for (const d of o.data) {
        if (d && typeof d === "object") {
          pushFromObject(d as Record<string, unknown>);
        } else {
          push(d);
        }
      }
    }

    // message content blocks that embed images
    if (Array.isArray(o.content)) {
      for (const c of o.content) {
        if (c && typeof c === "object") {
          const block = c as Record<string, unknown>;
          const bt = String(block.type || "").toLowerCase();
          if (bt.includes("image") || bt === "output_image") {
            pushFromObject(block);
          }
        }
        visit(c, depth + 1);
      }
    }

    for (const key of ["output", "items", "response", "results", "choices"]) {
      if (key in o) visit(o[key], depth + 1);
    }
  };

  visit(payload, 0);
  return out;
}

/**
 * Build the Responses API body for one image generation call.
 * tool_choice forces the hosted image_generation tool (avoids text-only replies
 * that look like "no image_generation_call" on entitled accounts).
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
    // Do NOT set tool_choice here. Verified live against cli-chat-proxy: the
    // hosted image_generation tool object is accepted, but ANY tool_choice
    // variant is rejected — the bare {type:"image_generation"} errored with
    // "did not match any variant of untagged enum ModelToolChoice", and the
    // string form errored with "tool_choice was set but no tools were
    // specified" (the hosted tool isn't in the tool_choice enum). Omitting it
    // returns HTTP 200; the prompt's "Use the image_generation tool" drives
    // generation on entitled (SuperGrok) accounts, while free/X Basic still
    // answer with a SuperGrok text refusal we surface.
    reasoning: { effort: "low" },
    max_output_tokens: 1024,
    stream: false,
  };
}

function diagnoseEmptyImagePayload(json: unknown, httpStatus: number): string {
  const hints = summarizeGrokImageResponseText(json);
  const combined = `${hints} ${typeof json === "string" ? json : JSON.stringify(json ?? "").slice(0, 800)}`;
  if (isGrokImageEntitlementError(combined) || /supergrok|x basic|free tier/i.test(combined)) {
    return `image_generation_not_entitled: ${GROK_IMAGE_SUPERGROK_MSG}${hints ? ` Upstream: ${hints.slice(0, 300)}` : ""}`;
  }
  if (hints) {
    return (
      `Grok image response had no image_generation_call result (base64/url). ` +
      `HTTP ${httpStatus}. Upstream text: ${hints.slice(0, 400)}`
    );
  }
  return (
    `Grok image response had no image_generation_call result (base64/url). ` +
    `HTTP ${httpStatus}. Free/X Basic OAuth is not entitled — SuperGrok required, or use canva-image.`
  );
}

/**
 * SuperGrok CLI path (cli-chat-proxy image_generation tool). Free accounts fail
 * with SuperGrok entitlement — only used when web SSO is missing or web failed
 * non-entitlement, and a bearer exists.
 */
async function grokGenerateImageViaCli(
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
        "No Grok OAuth credentials for CLI image generation. Free web needs sso cookies; SuperGrok CLI needs OAuth access_token.",
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
        const msgStr = typeof msg === "string" ? msg : JSON.stringify(msg);
        if (isGrokImageEntitlementError(msgStr) || /supergrok/i.test(msgStr)) {
          return {
            ok: false,
            urls,
            error: `image_generation_not_entitled: ${GROK_IMAGE_SUPERGROK_MSG} Upstream: ${msgStr.slice(0, 300)}`,
            raw: lastRaw,
          };
        }
        lastError = `Grok image failed (cli-chat-proxy /responses): ${msgStr}`;
        if (
          res.status === 401 ||
          res.status === 402 ||
          res.status === 403 ||
          /free-usage-exhausted|quota|credit|payment/i.test(msgStr)
        ) {
          return { ok: false, urls, error: lastError, raw: lastRaw };
        }
        continue;
      }

      const found = extractImageGenerationBase64(json);
      if (found.length === 0) {
        lastError = diagnoseEmptyImagePayload(json, res.status);
        if (isGrokImageEntitlementError(lastError)) {
          return { ok: false, urls, error: lastError, raw: lastRaw };
        }
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

/**
 * Generate image(s): prefer free grok.com web Imagine (SSO), then SuperGrok CLI tool.
 */
export async function grokGenerateImage(
  account: Account,
  opts: { prompt: string; n?: number },
): Promise<GrokImageResult> {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) {
    return { ok: false, urls: [], error: "Empty prompt for Grok image generation" };
  }

  // 1) Free web path when SSO cookies exist (what users can do on grok.com).
  if (getGrokWebSso(account)) {
    const web = await grokGenerateImageViaWeb(account, opts);
    if (web.ok && web.urls.length > 0) return web;
    // Expired SSO → try CLI only if SuperGrok might work; still surface web error if CLI missing.
    const webErr = web.error || "";
    if (!/expired|401|403/i.test(webErr)) {
      // Web worked auth-wise but no images / rate limit — don't hide that behind SuperGrok.
      // Still attempt CLI once for SuperGrok accounts that also have SSO.
      const cli = await grokGenerateImageViaCli(account, opts);
      if (cli.ok && cli.urls.length > 0) return cli;
      if (isGrokImageEntitlementError(cli.error || "") || /image_generation_not_entitled/i.test(cli.error || "")) {
        // Prefer the web error if it was more specific; else SuperGrok message is wrong for free web.
        return {
          ok: false,
          urls: [],
          error: webErr || cli.error,
          raw: { web: web.raw, cli: cli.raw },
        };
      }
      return {
        ok: false,
        urls: [],
        error: webErr || cli.error || "Grok image generation returned no images",
        raw: { web: web.raw, cli: cli.raw },
      };
    }
  }

  // 2) No SSO (OAuth-only farm rows today) or expired SSO → CLI SuperGrok tool.
  const cli = await grokGenerateImageViaCli(account, opts);
  if (cli.ok) return cli;

  // Make OAuth-only free fleet failures actionable: need web sso, not SuperGrok alone.
  if (
    isGrokImageEntitlementError(cli.error || "") ||
    /image_generation_not_entitled|no image_generation_call/i.test(cli.error || "")
  ) {
    return {
      ok: false,
      urls: [],
      error:
        `no_web_sso_and_cli_not_entitled: Free Grok image gen uses grok.com web (SSO cookies + enableImageGeneration). ` +
        `This account has no sso cookie and CLI image_generation is SuperGrok-only. ` +
        `Re-farm / activate_grok_com must store sso+sso-rw on the account tokens, or use canva-image. ` +
        `(${cli.error})`,
      raw: cli.raw,
    };
  }
  return cli;
}
