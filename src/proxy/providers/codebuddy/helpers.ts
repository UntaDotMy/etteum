/** codebuddy helpers (auth, crypto, transforms). */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "../base";
import type { Account } from "../../../db/schema";
import { config } from "../../../config";
import { applyModelSpecs, resolveModelSpec } from "../../model-specs";
import { getUpstreamNameOverride } from "../custom-models";


/**
 * Detect if a system prompt belongs to a known AI agent/CLI tool.
 * Uses broad pattern matching to catch current and future variations.
 */
export const AGENT_SYSTEM_PROMPT_PATTERNS: RegExp[] = [
  // Claude Code (various phrasings)
  /you are claude code/i,
  /claude.?code.+official.+cli/i,
  /anthropic.+official.+cli/i,
  /anxthxropic.+official.+cli/i,
  // Cursor / Windsurf / Cline / Aider / other coding agents
  /you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)/i,
  // Generic agent identity patterns
  /you are an? (?:ai )?(?:coding |code )?agent/i,
  // Claude Code specific markers that appear in system prompts
  /cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)/i,
  /claude.?code.+issues/i,
  /give feedback.+claude.?code/i,
  // OpenCode / OhMyOpenCode / Sisyphus agent
  /you are .{0,30}(?:powerful )?ai agent/i,
  /orchestration capabilities/i,
  /OhMyOpenCode/i,
  // Generic: any system prompt with agent-like XML tags
  /<agent-identity>/i,
  /<Role>/i,
  /<Behavior_Instructions>/i,
  // Generic: very long system prompts (>2000 chars) are almost always agent prompts
];

export function isAgentSystemPrompt(content: string): boolean {
  if (content.length > 2000) return true;
  return AGENT_SYSTEM_PROMPT_PATTERNS.some((pattern) => pattern.test(content));
}

export interface CodeBuddyTokens {
  api_key?: string;
  access_token?: string;
  refresh_token?: string;
  session_token?: string;
  csrf_token?: string;
  cookies?: string;
  web_cookie?: string;
}

/** Map cb- prefixed model IDs to the actual CodeBuddy API model names. */
export const CB_MODEL_MAP: Record<string, string> = {
  // Claude
  "cb-opus-4.6": "claude-opus-4.6",
  "cb-opus-4.7": "claude-opus-4.7",
  "cb-opus-4.7-1m": "claude-opus-4.7-1m",
  "cb-opus-4.8": "claude-opus-4.8",
  "cb-opus-4.8-1m": "claude-opus-4.8-1m",
  "cb-sonnet-4.6": "claude-sonnet-4.6",
  "cb-haiku-4.5": "claude-haiku-4.5",
  // GPT
  "cb-gpt-5.1": "gpt-5.1",
  "cb-gpt-5.1-codex": "gpt-5.1-codex",
  "cb-gpt-5.1-codex-max": "gpt-5.1-codex-max",
  "cb-gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
  "cb-gpt-5.2": "gpt-5.2",
  "cb-gpt-5.2-codex": "gpt-5.2-codex",
  "cb-gpt-5.3-codex": "gpt-5.3-codex",
  "cb-gpt-5.4": "gpt-5.4",
  "cb-gpt-5.5": "gpt-5.5",
  "cb-gpt-5.5-xhigh": "gpt-5.5-xhigh",
  // Gemini
  "cb-gemini-2.5-flash": "gemini-2.5-flash",
  "cb-gemini-2.5-pro": "gemini-2.5-pro",
  "cb-gemini-3.0-flash": "gemini-3.0-flash",
  "cb-gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
  "cb-gemini-3.1-pro": "gemini-3.1-pro",
  "cb-gemini-3.5-flash": "gemini-3.5-flash",
  // DeepSeek
  "cb-deepseek-v3-2": "deepseek-v3-2-volc",
  // Kimi
  "cb-kimi-k2.5": "kimi-k2.5",
  // Other
  "cb-default": "codebuddy-default",
};

/**
 * CodeBuddy Provider - MAX tier
 * Supports Claude Opus, GPT-5.x, Gemini, DeepSeek, Kimi models
 */
