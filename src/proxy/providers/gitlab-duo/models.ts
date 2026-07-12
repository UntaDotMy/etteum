/**
 * GitLab Duo model catalog helpers and stored-account shapes.
 */
import type { ModelInfo } from "../base";

export interface DuoStoredTokens {
  gitlabBaseUrl: string;
  namespacePath: string;
  namespaceId: number;
  userId?: number;
}

export interface DuoStoredMetadata {
  defaultModel?: string;
  availableModels?: Array<{ name: string; ref: string }>;
  gitlabVersion?: string;
}

/** Reasonable defaults shown via `/v1/models` before any account is registered.
 *  Refreshed from each account's `availableModels` on `refreshModelsCache()`. */
export const FALLBACK_MODEL_REFS = [
  "claude_sonnet_4_6",
  "claude_haiku_4_5",
  "claude_opus_4_8",
  "gpt_5",
  "gpt_5_mini",
] as const;

export interface ModelMeta {
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
}

export function describeModel(ref: string): ModelMeta {
  if (ref.startsWith("claude_")) {
    return {
      context_window: 200_000,
      max_output: 64_000,
      thinking: ref.includes("opus") || ref.includes("sonnet"),
      vision: true,
    };
  }
  if (ref.startsWith("gpt_")) {
    // GPT-5.x models support reasoning/thinking
    const isGpt5 = ref.includes("5") || ref.includes("o1") || ref.includes("o3");
    return { context_window: 128_000, max_output: 16_384, thinking: isGpt5, vision: true };
  }
  if (ref.startsWith("gemini_")) {
    return { context_window: 1_000_000, max_output: 8_192, thinking: false, vision: true };
  }
  return { context_window: 32_768, max_output: 4_096, thinking: false, vision: false };
}

// ─── Provider ────────────────────────────────────────────────────────────────
