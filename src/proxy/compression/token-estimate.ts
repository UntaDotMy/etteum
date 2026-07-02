/**
 * Token estimation — char/4 baseline.
 *
 * This is intentionally cheap: a real tokenizer (tiktoken/anthropic) would
 * add 5-50ms to the proxy hot path. The 4 chars/token heuristic is accurate
 * within ~10% for English + code, which is fine for telemetry (the upstream
 * usage object is the source of truth for billing).
 */

import type { ChatCompletionRequest, ChatMessage } from "../providers/base";

const CHARS_PER_TOKEN = 4;

export function estimateTokensFromString(s: string | undefined | null): number {
  if (!s) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Recursively walk a content block tree and sum text length. */
function blockChars(block: any): number {
  if (block == null) return 0;
  if (typeof block === "string") return block.length;
  if (Array.isArray(block)) return block.reduce((acc: number, b: any) => acc + blockChars(b), 0);
  if (typeof block !== "object") return String(block).length;

  // Common shapes:
  if (typeof block.text === "string") return block.text.length;
  if (block.type === "tool_use") {
    return (block.name?.length || 0) + JSON.stringify(block.input || {}).length;
  }
  if (block.type === "tool_result") {
    if (typeof block.content === "string") return block.content.length;
    if (Array.isArray(block.content)) return blockChars(block.content);
    return JSON.stringify(block.content || "").length;
  }
  if (block.type === "image" || block.type === "image_url") {
    // Images: estimate based on resolution metadata if present, else fixed cost.
    // Anthropic charges ~1.15 tokens per pixel-block; we use a pessimistic flat
    // cost of 1500 tokens per image so dedupe savings are visible in stats.
    return 1500 * CHARS_PER_TOKEN;
  }
  // Unknown shape — fall back to JSON length.
  return JSON.stringify(block).length;
}

export function estimateMessageTokens(msg: ChatMessage): number {
  const contentChars =
    typeof msg.content === "string" ? msg.content.length : blockChars(msg.content);
  // 4 chars + role overhead (~4 tokens per message envelope)
  return Math.ceil(contentChars / CHARS_PER_TOKEN) + 4;
}

export function estimateRequestTokens(req: ChatCompletionRequest): number {
  let total = 0;
  // System prompt — may be string OR array of blocks (Anthropic style).
  const sys = (req as any).system;
  if (typeof sys === "string") {
    total += estimateTokensFromString(sys);
  } else if (Array.isArray(sys)) {
    total += Math.ceil(blockChars(sys) / CHARS_PER_TOKEN);
  }
  for (const m of req.messages || []) total += estimateMessageTokens(m);
  // Tool definitions
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      total += estimateTokensFromString(JSON.stringify(t));
    }
  }
  return total;
}
