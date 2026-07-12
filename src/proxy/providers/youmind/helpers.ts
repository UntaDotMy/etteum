/** youmind helpers (auth, crypto, transforms). */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import { decrypt } from "../../../utils/crypto";
import { normalizeMessagesToOpenAI } from "../../transforms/anthropic";
import { applyModelSpecs } from "../../model-specs";
import { getUpstreamNameOverride } from "../custom-models";
import { safeJsonParse } from "../../../utils/safe-json";

// ============================================================================
// YouMind Provider — youmind.com OpenAPI Relay
//
// YouMind exposes two vendor-compatible relay endpoints under the same API key:
//   • Anthropic Messages API → /openapi/v1/chat/anthropic/v1/messages
//   • OpenAI Chat Completions → /openapi/v1/chat/openai/v1/chat/completions
//
// Auth: Authorization: Bearer sk-ym-...
//
// All upstream-facing model IDs are exposed under the `ym-` prefix. The
// resolveModel() dispatcher maps each prefix to its real upstream id and the
// route (anthropic | openai) to use. Adding/removing a model = touching
// YM_MODEL_MAP only.
// ============================================================================

export const YOUMIND_BASE = "https://youmind.com";
export const ANTHROPIC_RELAY_URL = `${YOUMIND_BASE}/openapi/v1/chat/anthropic/v1/messages`;
export const OPENAI_RELAY_URL = `${YOUMIND_BASE}/openapi/v1/chat/openai/v1/chat/completions`;
export const ANTHROPIC_MODELS_URL = `${YOUMIND_BASE}/openapi/v1/chat/anthropic/v1/models`;
export const LIST_BOARDS_URL = `${YOUMIND_BASE}/openapi/v1/listBoards`;
export const ANTHROPIC_VERSION = "2023-06-01";

export type YouMindRoute = "anthropic" | "openai";

export interface YouMindModelDef {
  /** Proxy-facing id (ym-*) */
  id: string;
  /** Real upstream id passed in the relay request body */
  upstream: string;
  /** Which relay endpoint serves this model */
  route: YouMindRoute;
  context_window: number;
  max_output: number;
  thinking: boolean;
  vision: boolean;
  /** USD cost per 1k tokens — used for credit accounting (estimated). */
  creditRate: number;
}

/**
 * Curated catalog of YouMind models verified live against the relay endpoints.
 * Models that exist in the YouMind UI but are NOT exposed via the relay
 * (Gemini, DeepSeek, Kimi, GLM, MiniMax, Sonnet 4.5, Sonnet 4.6 not in some
 * accounts) are intentionally omitted — adding them would surface "Model not
 * supported" errors the user can't fix.
 *
 * Verification: GET /openapi/v1/chat/anthropic/v1/models returns the
 * authoritative Claude list; the OpenAI relay has no models endpoint, so
 * `gpt-5.5` and `gpt-4o` were confirmed by trial calls.
 */
export const YM_MODELS: YouMindModelDef[] = [
  // Anthropic relay — Claude family
  {
    id: "ym-claude-opus-4.6",
    upstream: "claude-opus-4-6",
    route: "anthropic",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    // Claude Opus pricing ≈ $15/$75 per M tokens — average ≈ $0.045 / 1k.
    creditRate: 0.045 / 1000,
  },
  {
    id: "ym-claude-opus-4.7",
    upstream: "claude-opus-4-7",
    route: "anthropic",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.045 / 1000,
  },
  {
    id: "ym-claude-opus-4.8",
    upstream: "claude-opus-4-8",
    route: "anthropic",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.045 / 1000,
  },
  {
    id: "ym-claude-sonnet-4.6",
    upstream: "claude-sonnet-4-6",
    route: "anthropic",
    context_window: 200000,
    max_output: 64000,
    thinking: true,
    vision: true,
    // Sonnet pricing ≈ $3/$15 per M tokens — average ≈ $0.009 / 1k.
    creditRate: 0.009 / 1000,
  },
  // OpenAI relay — GPT family
  {
    id: "ym-gpt-5.5",
    upstream: "gpt-5.5",
    route: "openai",
    context_window: 272000,
    max_output: 16000,
    thinking: true,
    vision: true,
    // GPT-5.5 pricing ≈ $5/$30 per M tokens — average ≈ $0.0175 / 1k.
    creditRate: 0.0175 / 1000,
  },
  {
    id: "ym-gpt-4o",
    upstream: "gpt-4o",
    route: "openai",
    context_window: 128000,
    max_output: 16000,
    thinking: false,
    vision: true,
    // GPT-4o pricing ≈ $2.50/$10 per M tokens — average ≈ $0.00625 / 1k.
    creditRate: 0.00625 / 1000,
  },
];

export const MODEL_BY_ID: Record<string, YouMindModelDef> = Object.fromEntries(
  YM_MODELS.map((m) => [m.id.toLowerCase(), m]),
);

/** GPT-5.x family rejects `max_tokens` and requires `max_completion_tokens`. */
export function isGpt5Family(upstream: string): boolean {
  return /^gpt-5(\.|$)/i.test(upstream);
}

/**
 * Identity payload returned by /openapi/v1/listBoards. We only consume what we
 * need to derive a stable email-like account label.
 */
export interface ListBoardsItem {
  id?: string;
  space_id?: string;
  creator_id?: string;
  name?: string;
  snips_count?: number;
  thoughts_count?: number;
  crafts_count?: number;
}

