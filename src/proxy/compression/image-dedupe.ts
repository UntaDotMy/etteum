/**
 * Image Dedupe.
 *
 * Detect duplicate image content blocks (same base64 bytes) within a single
 * request and replace later occurrences with a textual reference:
 *   `[duplicate of image in message #N]`
 *
 * This is lossless when the model is allowed to refer back to earlier
 * messages (Anthropic + OpenAI both support this naturally via context).
 *
 * No image resizing here — that needs a real decoder (sharp/imagemagick) and
 * would balloon the dependency tree. We only dedup, which is pure-string.
 */

import type { ChatCompletionRequest } from "../providers/base";
import type { ImageDedupeConfig } from "./types";

function imageBytesKey(block: any): string | null {
  if (!block || typeof block !== "object") return null;
  // Anthropic shape: { type: "image", source: { type: "base64", data: "...", media_type: "image/png" } }
  if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
    // Use first+last 64 chars + length as a cheap fingerprint (collision-resistant
    // enough for "same image attached twice" within a single request).
    const d = block.source.data;
    return `b64:${d.length}:${d.slice(0, 64)}:${d.slice(-64)}`;
  }
  // Anthropic url shape
  if (block.type === "image" && block.source?.type === "url" && typeof block.source.url === "string") {
    return `url:${block.source.url}`;
  }
  // OpenAI shape: { type: "image_url", image_url: { url: "data:image/png;base64,..." | "https://..." } }
  if (block.type === "image_url" && block.image_url?.url) {
    const url: string = block.image_url.url;
    if (url.startsWith("data:")) {
      const idx = url.indexOf(",");
      const data = idx >= 0 ? url.slice(idx + 1) : url;
      return `b64:${data.length}:${data.slice(0, 64)}:${data.slice(-64)}`;
    }
    return `url:${url}`;
  }
  return null;
}

function blockSizeChars(block: any): number {
  if (block?.source?.data) return String(block.source.data).length;
  if (block?.image_url?.url) return String(block.image_url.url).length;
  return JSON.stringify(block || "").length;
}

export function applyImageDedupe(
  request: ChatCompletionRequest,
  cfg: ImageDedupeConfig
): { request: ChatCompletionRequest; saved: number } {
  if (!cfg.enabled) return { request, saved: 0 };
  if (!Array.isArray(request.messages)) return { request, saved: 0 };

  const seen = new Map<string, number>(); // fp -> first message index (1-based)
  let saved = 0;
  let mutated = false;

  const newMessages = request.messages.map((msg, i) => {
    if (!Array.isArray(msg.content)) return msg;
    const newContent = (msg.content as any[]).map((b) => {
      const fp = imageBytesKey(b);
      if (!fp) return b;
      const firstSeen = seen.get(fp);
      if (firstSeen === undefined) {
        seen.set(fp, i + 1);
        return b;
      }
      const before = blockSizeChars(b);
      const stub = {
        type: "text",
        text: `[duplicate of image in message #${firstSeen}]`,
      };
      const after = stub.text.length;
      saved += Math.max(0, before - after);
      mutated = true;
      return stub;
    });
    return { ...msg, content: newContent };
  });

  if (!mutated) return { request, saved: 0 };
  return { request: { ...request, messages: newMessages }, saved };
}
