import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { applyModelSpecs } from "../model-specs";

interface CodexTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: string | number;
  email?: string;
  account_id?: string;
  method?: string;
}

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_SCOPE = "openid profile email offline_access";

/**
 * Parsed Codex usage — the credit model codex-lb uses. See parseCodexUsage.
 */
export interface CodexUsage {
  planType: string;
  /** 0-100. Primary window (rolling ~5h). */
  primaryUsedPercent: number;
  /** 0-100. Secondary window (rolling ~weekly). This is the hard ceiling. */
  secondaryUsedPercent: number;
  rateLimited: boolean;
  resetAt: Date | null;
  primaryResetAt: Date | null;
  secondaryResetAt: Date | null;
  /** Pay-as-you-go credits, if the account has any. */
  credits: { hasCredits: boolean; unlimited: boolean; balance: number };
  /** Extra rate-limit resets granted when a window fills (rare). */
  rateLimitResetCredits: { availableCount: number };
  /** Per-model additional limits (e.g. Codex-Spark), keyed by model name. */
  additionalRateLimits: Record<string, { usedPercent: number; resetAt: Date | null }>;
  /** Normalized for the proxy's quota snapshot. limit=100 (percent scale). */
  limit: number;
  used: number;
  remaining: number;
  /** True when credit-override keeps the account usable despite a full window. */
  creditOverrideActive: boolean;
}

/**
 * Parse a `wham/usage` JSON payload into the Codex credit model. Pure: no I/O,
 * never throws. Field names verified against codex-lb (Soju06/codex-lb) and the
 * Codex CLI's own usage check.
 *
 * Credit-override rule (the key fix vs. the old impl): an account counts as
 * having capacity when EITHER a rate window has headroom OR it has credits
 * (`unlimited` | `has_credits` | `balance > 0`). The old code marked the
 * account exhausted as soon as `remaining <= 0`, benching credit-backed
 * accounts that were still perfectly usable.
 */
export function parseCodexUsage(data: any): CodexUsage {
  const rl = data?.rate_limit || {};
  const primary = rl.primary_window || {};
  const secondary = rl.secondary_window || {};
  const credits = data?.credits || {};

  const primaryUsedPercent = Number(primary.used_percent ?? 0);
  const secondaryUsedPercent = Number(secondary.used_percent ?? 0);
  const rateLimited = Boolean(rl.limit_reached);

  const toDate = (v: any): Date | null =>
    v ? new Date(Number(v) * 1000) : null;
  const primaryResetAt = toDate(primary.reset_at);
  const secondaryResetAt = toDate(secondary.reset_at);
  // Prefer the window that resets soonest among those that are full; else the
  // primary reset. Used as the snapshot's resetAt.
  const resetAt = primaryResetAt;

  const hasCredits = Boolean(credits.has_credits);
  const unlimited = Boolean(credits.unlimited);
  const balance = Number(credits.balance ?? 0);

  const rlrc = data?.rate_limit_reset_credits || {};
  const availableCount = Number(rlrc.available_count ?? 0);

  const additional: Record<string, { usedPercent: number; resetAt: Date | null }> = {};
  const addl = data?.additional_rate_limits;
  if (addl && typeof addl === "object") {
    for (const [model, info] of Object.entries(addl)) {
      const i = (info || {}) as any;
      additional[model] = {
        usedPercent: Number(i.used_percent ?? 0),
        resetAt: toDate(i.reset_at),
      };
    }
  }

  // The secondary window is the hard ceiling. Credit-override: if it's full
  // but the account has credits, the account is still usable.
  const secondaryFull = secondaryUsedPercent >= 100 || rateLimited;
  const creditOverrideActive = secondaryFull && (unlimited || hasCredits || balance > 0 || availableCount > 0);

  // Normalized to a 100-point percent scale (the natural Codex unit).
  const limit = 100;
  const used = Math.min(100, Math.round(secondaryUsedPercent));
  const remaining = creditOverrideActive ? 100 : Math.max(0, limit - used);

  return {
    planType: String(data?.plan_type || ""),
    primaryUsedPercent,
    secondaryUsedPercent,
    rateLimited,
    resetAt,
    primaryResetAt,
    secondaryResetAt,
    credits: { hasCredits, unlimited, balance },
    rateLimitResetCredits: { availableCount },
    additionalRateLimits: additional,
    limit,
    used,
    remaining,
    creditOverrideActive,
  };
}

// Model map: proxy-facing `codex-*` ids → real Codex backend slugs.
// Fetched live 2026-07-03 from https://chatgpt.com/backend-api/codex/models
// ?client_version=1.0.18 (the same endpoint the Codex CLI uses). The backend
// currently exposes exactly FOUR slugs: gpt-5.5, gpt-5.4, gpt-5.4-mini,
// codex-auto-review — all 272k context, all vision-capable, all supporting
// reasoning levels low/medium/high/xhigh. Older slugs (gpt-5.3-codex, gpt-5.2,
// gpt-5.5-xhigh as a *model*) no longer exist and 400 on ChatGPT accounts.
//
// Note: "xhigh" is a REASONING LEVEL on gpt-5.5, not a separate model. Clients
// that send `gpt-5.5-xhigh` are aliased to gpt-5.5 (the proxy sets reasoning
// effort via the request, not the model name).
const codexModelMap: Record<string, string> = {
  // Default fallback — newest frontier model, verified working on ChatGPT accounts.
  "codex-auto": "gpt-5.5",
  // Real models (live-fetched).
  "codex-gpt-5.5": "gpt-5.5",
  "gpt-5.5": "gpt-5.5",
  "codex-gpt-5.4": "gpt-5.4",
  "gpt-5.4": "gpt-5.4",
  "codex-gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "codex-auto-review": "codex-auto-review",
  // Legacy aliases — these slugs no longer exist upstream; remap to gpt-5.5 so
  // old configs/clients keep working instead of 400ing.
  "codex-gpt-5.5-xhigh": "gpt-5.5",
  "gpt-5.5-xhigh": "gpt-5.5",
  "codex-gpt-5.3": "gpt-5.5",
  "codex-gpt-5.3-codex": "gpt-5.5",
  "gpt-5.3-codex": "gpt-5.5",
  "codex-gpt-5.2": "gpt-5.5",
  "gpt-5.2": "gpt-5.5",
  "gpt-5-codex": "gpt-5.5",
};

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface CodexReasoningConfig {
  effort?: string;
  summary?: "auto" | "detailed";
}

export class CodexProvider extends BaseProvider {
  name = "codex";

  override ownsModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.startsWith("codex-") || m === "gpt-5-codex" || m === "gpt-5.5-xhigh";
  }

  // Supported models — matches the live-fetched Codex backend (2026-07-03).
  // 4 real slugs, all 272k context, vision-capable, reasoning low/med/high/xhigh.
  // context_window verified upstream (was wrongly 200000 before).
  supportedModels: ModelInfo[] = applyModelSpecs([
    { id: "codex-auto", object: "model", created: Date.now(), owned_by: "codex", context_window: 272000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.5", object: "model", created: Date.now(), owned_by: "codex", context_window: 272000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.4", object: "model", created: Date.now(), owned_by: "codex", context_window: 272000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.4-mini", object: "model", created: Date.now(), owned_by: "codex", context_window: 272000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.005 / 1000, creditSource: "estimated" },
    { id: "codex-auto-review", object: "model", created: Date.now(), owned_by: "codex", context_window: 272000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01 / 1000, creditSource: "estimated" },
    // Legacy alias kept so existing configs referencing it still resolve via
    // codexModelMap (→ gpt-5.5). Not advertised as a distinct model.
    { id: "codex-gpt-5.5-xhigh", object: "model", created: Date.now(), owned_by: "codex", context_window: 272000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
  ], (m) => {
    // Return undefined so applyModelSpecs does NOT override our verified
    // 272k Codex context with the model-specs registry's API-tier value
    // (gpt-5.5 there is 1M — that's the OpenAI API limit, not the Codex/
    // ChatGPT-account limit, which is 272k per the live /codex/models fetch).
    return undefined;
  });

  override getModelInfo(model: string): ModelInfo | undefined {
    const normalized = model.toLowerCase();
    // gpt-5.5-xhigh is an alias for codex-gpt-5.5 (xhigh is a reasoning level,
    // not a separate model). codex-auto is the default → gpt-5.5.
    if (normalized === "gpt-5.5-xhigh") return super.getModelInfo("codex-gpt-5.5");
    if (normalized === "codex-auto") return super.getModelInfo("codex-gpt-5.5");
    return super.getModelInfo(model);
  }

  private getTokens(account: Account): CodexTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as CodexTokens;
    } catch { return null; }
  }

  private resolveModel(model: string): string {
    return codexModelMap[model.toLowerCase()] || model;
  }

  /**
   * Pure parser for the wham/usage response. Extracted so it can be unit-tested
   * without hitting the network. Mirrors the codex-lb (Soju06/codex-lb) credit
   * model:
   *
   * Codex accounts are plan-based with TWO rolling rate windows
   * (primary ~5h, secondary ~weekly) measured in `used_percent` (0-100), PLUS
   * an optional pay-as-you-go `credits` balance. The credit-override rule: an
   * account is only "exhausted" when BOTH the secondary window is full AND no
   * credits remain — credit-backed accounts stay usable past their plan limit.
   *
   * Returns a normalized shape plus the raw structured fields for metadata.
   */
  private contentToText(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" || block?.type === "input_text" || block?.type === "output_text") return block.text || "";
        if (block?.type === "tool_result") return this.contentToText(block.content) || String(block.content || "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private stringifyToolInput(input: unknown): string {
    if (typeof input === "string") return input;
    try { return JSON.stringify(input ?? {}); } catch { return "{}"; }
  }

  private normalizeTools(tools: any[] | undefined): any[] {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    return tools
      .map((tool) => {
        if (tool?.type === "function" && tool.function?.name) {
          return {
            type: "function",
            name: tool.function.name,
            description: tool.function.description || "",
            parameters: tool.function.parameters || { type: "object", properties: {} },
          };
        }
        if (tool?.name) {
          return {
            type: "function",
            name: tool.name,
            description: tool.description || "",
            parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  private normalizeToolChoice(toolChoice: any): any {
    if (toolChoice == null) return "auto";
    if (typeof toolChoice === "string") return toolChoice;
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "function", name: toolChoice.function.name };
    }
    if (toolChoice.type === "tool" && toolChoice.name) {
      return { type: "function", name: toolChoice.name };
    }
    return toolChoice;
  }

  private normalizeReasoningEffort(effort: unknown): string | undefined {
    if (typeof effort !== "string") return undefined;
    const normalized = effort.toLowerCase();
    if (["minimal", "low", "medium", "high", "xhigh"].includes(normalized)) return normalized;
    return undefined;
  }

  private effortFromThinkingBudget(budgetTokens: unknown): string | undefined {
    if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens <= 0) {
      return undefined;
    }
    if (budgetTokens >= 16_000) return "high";
    if (budgetTokens >= 4_000) return "medium";
    return "low";
  }

  private buildReasoning(request: ChatCompletionRequest): CodexReasoningConfig | undefined {
    const thinking = request.thinking as any;
    if (thinking?.type === "disabled" || request.reasoning_effort === "none") return undefined;

    const effort =
      this.normalizeReasoningEffort(request.reasoning_effort) ||
      this.normalizeReasoningEffort(thinking?.effort) ||
      this.effortFromThinkingBudget(thinking?.budget_tokens) ||
      (request.model.toLowerCase().includes("xhigh") ? "xhigh" : undefined) ||
      (thinking ? "medium" : undefined);

    const wantsVisibleSummary =
      (thinking && thinking.display !== "omitted") ||
      !!request.reasoning_effort ||
      request.model.toLowerCase().includes("xhigh");
    const summary = wantsVisibleSummary
      ? (thinking?.summary === "detailed" ? "detailed" : "auto")
      : undefined;

    if (!effort && !summary) return undefined;
    return { ...(effort ? { effort } : {}), ...(summary ? { summary } : {}) };
  }

  private textFromReasoningPart(part: any): string {
    if (!part) return "";
    if (typeof part === "string") return part;
    if (typeof part.text === "string") return part.text;
    if (typeof part.summary_text === "string") return part.summary_text;
    if (typeof part.content === "string") return part.content;
    if (Array.isArray(part.content)) {
      return part.content.map((inner: any) => this.textFromReasoningPart(inner)).filter(Boolean).join("\n");
    }
    return "";
  }

  private extractReasoningItemText(item: any): string {
    if (item?.type !== "reasoning") return "";
    const parts = [item.summary, item.content, item.text, item.reasoning].flatMap((value) => {
      if (Array.isArray(value)) return value;
      return value == null ? [] : [value];
    });
    return parts.map((part) => this.textFromReasoningPart(part)).filter(Boolean).join("\n");
  }

  private extractReasoningDelta(event: any): string {
    const type = event?.type || "";
    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning.delta"
    ) {
      return typeof event.delta === "string" ? event.delta : "";
    }
    return "";
  }

  private buildPayload(request: ChatCompletionRequest): { instructions: string; input: unknown[] } {
    const systemParts: string[] = [];
    const items: unknown[] = [];
    for (const msg of request.messages) {
      const rawRole = msg.role as string;
      const text = this.contentToText(msg.content);
      if (rawRole === "system") {
        if (text) systemParts.push(text);
        continue;
      }
      if (rawRole === "tool") {
        items.push({
          type: "function_call_output",
          call_id: msg.tool_call_id || crypto.randomUUID(),
          output: text,
        });
        continue;
      }

      const role = rawRole === "tool" ? "user" : rawRole;
      if (text) {
        items.push({
          type: "message",
          role,
          content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
        });
      }

      // After centralized normalization, tool_use/tool_result blocks are
      // already converted to OpenAI format (assistant.tool_calls / role:"tool").
      // This loop handles any remaining array content (e.g. text/image blocks).
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block?.type === "text" && typeof block.text === "string" && !text) {
            // If text wasn't extracted above (non-string content), use the first text block.
            items.push({
              type: "message",
              role: role === "assistant" ? "assistant" : "user",
              content: [{ type: role === "assistant" ? "output_text" : "input_text", text: block.text }],
            });
          }
        }
      }

      for (const call of msg.tool_calls || []) {
        const name = call?.function?.name;
        if (!name) continue;
        items.push({
          type: "function_call",
          call_id: call.id || crypto.randomUUID(),
          name,
          arguments: this.stringifyToolInput(call.function?.arguments),
        });
      }
    }
    return { instructions: systemParts.join("\n\n"), input: items };
  }

  private collectCompletedToolCalls(response: any, byIndex: Map<number, PendingToolCall>) {
    for (const [index, item] of (response?.output || []).entries()) {
      if (item?.type !== "function_call") continue;
      byIndex.set(index, {
        index,
        id: item.call_id || item.id || `call_${index}`,
        name: item.name || "",
        arguments: item.arguments || "",
      });
    }
  }

  private toolCallsFromMap(byIndex: Map<number, PendingToolCall>) {
    return [...byIndex.values()]
      .filter((call) => call.name)
      .sort((a, b) => a.index - b.index)
      .map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
  }

  private async makeRequest(account: Account, request: ChatCompletionRequest): Promise<Response> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) throw new Error("expired: no access_token");

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
      "OpenAI-Beta": "responses=experimental",
      "originator": "codex-cli",
    };
    if (tokens.account_id) headers["chatgpt-account-id"] = tokens.account_id;

    const { instructions, input } = this.buildPayload(request);
    // Guard: if every message was dropped (e.g. system-only, or all-empty
    // content), Codex's /responses rejects with 400 "must provide input /
    // previous_response_id / prompt / conversation_id". Fail fast with a clear
    // error instead of sending a guaranteed-to-fail request.
    if (input.length === 0) {
      throw new Error("Codex request has no input messages (all roles were empty or system-only).");
    }
    const tools = this.normalizeTools(request.tools);
    const reasoning = this.buildReasoning(request);
    const body = {
      model: this.resolveModel(request.model),
      instructions,
      input,
      tools,
      tool_choice: tools.length > 0 ? this.normalizeToolChoice(request.tool_choice) : "auto",
      parallel_tool_calls: tools.length > 0,
      store: false,
      stream: true,
      include: [],
      ...(reasoning ? { reasoning } : {}),
    };

    return this.fetchWithTimeout(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request);
      if (response.status === 401) {
        return { success: false, error: `expired: HTTP 401` };
      }
      if (response.status === 403) {
        return { success: false, error: `Account banned or restricted (HTTP 403)`, banned: true };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let reasoningText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCallsByIndex = new Map<number, PendingToolCall>();
      const reasoningByOutput = new Map<number, string>();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          let dataLine = "";
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) dataLine += line.slice(6);
            else if (line.startsWith("data:")) dataLine += line.slice(5);
          }
          if (!dataLine || dataLine === "[DONE]") continue;

          try {
            const obj = JSON.parse(dataLine);
            const t = obj.type || "";
            const reasoningDelta = this.extractReasoningDelta(obj);
            if (reasoningDelta) {
              const index = Number(obj.output_index ?? 0);
              reasoningByOutput.set(index, `${reasoningByOutput.get(index) || ""}${reasoningDelta}`);
              reasoningText += reasoningDelta;
            } else if (t === "response.reasoning_summary_text.done" || t === "response.reasoning_summary_part.done") {
              const index = Number(obj.output_index ?? 0);
              const doneText = typeof obj.text === "string" ? obj.text : this.textFromReasoningPart(obj.part);
              if (doneText && !reasoningByOutput.get(index)) {
                reasoningByOutput.set(index, doneText);
                reasoningText += doneText;
              }
            } else if (t === "response.output_text.delta") {
              text += obj.delta || "";
            } else if (t === "response.output_item.added" || t === "response.output_item.done") {
              const item = obj.item || {};
              if (item.type === "reasoning") {
                const index = Number(obj.output_index ?? 0);
                const itemText = this.extractReasoningItemText(item);
                if (itemText && !reasoningByOutput.get(index)) {
                  reasoningByOutput.set(index, itemText);
                  reasoningText += itemText;
                }
              } else if (item.type === "function_call") {
                const index = Number(obj.output_index ?? toolCallsByIndex.size);
                toolCallsByIndex.set(index, {
                  index,
                  id: item.call_id || item.id || `call_${index}`,
                  name: item.name || "",
                  arguments: item.arguments || toolCallsByIndex.get(index)?.arguments || "",
                });
              }
            } else if (t === "response.function_call_arguments.delta") {
              const index = Number(obj.output_index ?? 0);
              const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
              current.arguments += obj.delta || "";
              toolCallsByIndex.set(index, current);
            } else if (t === "response.function_call_arguments.done") {
              const index = Number(obj.output_index ?? 0);
              const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
              current.arguments = obj.arguments || current.arguments;
              toolCallsByIndex.set(index, current);
            } else if (t === "response.completed") {
              this.collectCompletedToolCalls(obj.response, toolCallsByIndex);
              const usage = obj.response?.usage;
              if (usage) {
                inputTokens = Number(usage.input_tokens) || 0;
                outputTokens = Number(usage.output_tokens) || 0;
              }
            }
          } catch { /* skip malformed */ }
        }
      }

      const promptTokens = inputTokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = outputTokens || this.estimateTokens(text);
      const toolCalls = this.toolCallsFromMap(toolCallsByIndex);

      const resp: ChatCompletionResponse = {
        id: this.generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: text,
            ...(reasoningText ? { reasoning_content: reasoningText } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          } as any,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };

      return { success: true, response: resp, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request);
      if (response.status === 401) {
        return { success: false, error: `expired: HTTP 401` };
      }
      if (response.status === 403) {
        return { success: false, error: `Account banned or restricted (HTTP 403)`, banned: true };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;
      const provider = this;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let started = false;
          let accumulated = "";
          let hasToolCalls = false;
          const toolCallsByIndex = new Map<number, PendingToolCall>();
          const emittedToolIndexes = new Set<number>();
          const reasoningByOutput = new Map<number, string>();

          const emit = (delta: any, finish_reason: string | null = null) => {
            const chunk: any = {
              id, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          const emitRole = () => {
            if (started) return;
            started = true;
            emit({ role: "assistant" });
          };

          const emitToolStart = (call: PendingToolCall) => {
            emitRole();
            hasToolCalls = true;
            emittedToolIndexes.add(call.index);
            emit({
              tool_calls: [{
                index: call.index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: "" },
              }],
            });
          };

          const emitToolArguments = (index: number, delta: string) => {
            if (!delta) return;
            emitRole();
            hasToolCalls = true;
            emit({
              tool_calls: [{
                index,
                function: { arguments: delta },
              }],
            });
          };

          const emitReasoning = (index: number, delta: string) => {
            if (!delta) return;
            emitRole();
            reasoningByOutput.set(index, `${reasoningByOutput.get(index) || ""}${delta}`);
            emit({ reasoning_content: delta });
          };

          const emitMissingCompletedToolCalls = () => {
            for (const pending of [...toolCallsByIndex.values()].sort((a, b) => a.index - b.index)) {
              if (!pending.name) continue;
              if (!emittedToolIndexes.has(pending.index)) {
                emitToolStart(pending);
                emitToolArguments(pending.index, pending.arguments || "{}");
              }
            }
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              let idx;
              while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const event = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);

                let dataLine = "";
                for (const line of event.split("\n")) {
                  if (line.startsWith("data: ")) dataLine += line.slice(6);
                  else if (line.startsWith("data:")) dataLine += line.slice(5);
                }
                if (!dataLine || dataLine === "[DONE]") continue;

                try {
                  const obj = JSON.parse(dataLine);
                  const t = obj.type || "";
                  const reasoningDelta = provider.extractReasoningDelta(obj);

                  if (reasoningDelta) {
                    emitReasoning(Number(obj.output_index ?? 0), reasoningDelta);
                  } else if (t === "response.reasoning_summary_text.done" || t === "response.reasoning_summary_part.done") {
                    const index = Number(obj.output_index ?? 0);
                    const doneText = typeof obj.text === "string" ? obj.text : provider.textFromReasoningPart(obj.part);
                    if (doneText && !reasoningByOutput.get(index)) emitReasoning(index, doneText);
                  } else if (t === "response.output_text.delta") {
                    const delta = obj.delta || "";
                    if (!delta) continue;
                    emitRole();
                    accumulated += delta;
                    emit({ content: delta });
                  } else if (t === "response.output_item.added" || t === "response.output_item.done") {
                    const item = obj.item || {};
                    if (item.type === "reasoning") {
                      const index = Number(obj.output_index ?? 0);
                      const itemText = provider.extractReasoningItemText(item);
                      if (itemText && !reasoningByOutput.get(index)) {
                        emitReasoning(index, itemText);
                      }
                    } else if (item.type === "function_call") {
                      const index = Number(obj.output_index ?? toolCallsByIndex.size);
                      const current = toolCallsByIndex.get(index) || {
                        index,
                        id: item.call_id || item.id || `call_${index}`,
                        name: item.name || "",
                        arguments: "",
                      };
                      current.id = item.call_id || item.id || current.id;
                      current.name = item.name || current.name;
                      current.arguments = item.arguments || current.arguments;
                      toolCallsByIndex.set(index, current);
                      if (current.name && !emittedToolIndexes.has(index)) {
                        emitToolStart(current);
                        if (current.arguments) emitToolArguments(index, current.arguments);
                      }
                    }
                  } else if (t === "response.function_call_arguments.delta") {
                    const index = Number(obj.output_index ?? 0);
                    const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
                    current.arguments += obj.delta || "";
                    toolCallsByIndex.set(index, current);
                    emitToolArguments(index, obj.delta || "");
                  } else if (t === "response.function_call_arguments.done") {
                    const index = Number(obj.output_index ?? 0);
                    const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
                    const previousLength = current.arguments.length;
                    current.arguments = obj.arguments || current.arguments;
                    toolCallsByIndex.set(index, current);
                    if (!emittedToolIndexes.has(index) && current.name) emitToolStart(current);
                    if (current.arguments.length > previousLength && previousLength === 0) emitToolArguments(index, current.arguments);
                  } else if (t === "response.completed" || t === "response.done") {
                    provider.collectCompletedToolCalls(obj.response, toolCallsByIndex);
                    emitMissingCompletedToolCalls();
                    emit({}, hasToolCalls ? "tool_calls" : "stop");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  } else if (t === "response.failed" || t === "error") {
                    emit({}, "stop");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }
                } catch { /* skip malformed */ }
              }
            }

            if (!started) emit({ role: "assistant", content: accumulated });
            emitMissingCompletedToolCalls();
            emit({}, hasToolCalls ? "tool_calls" : "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try { controller.error(err); } catch { /* already errored */ }
          }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) return { success: false, error: "No refresh token" };

    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: CODEX_CLIENT_ID,
        scope: CODEX_SCOPE,
      });

      const response = await this.fetchWithTimeout(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }, 15000);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `Refresh failed: HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      if (!data.access_token) return { success: false, error: "No access_token in refresh response" };

      const expiresIn = Number(data.expires_in) || 3600;
      const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);

      return {
        success: true,
        tokens: JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token || tokens.refresh_token,
          id_token: data.id_token || tokens.id_token,
          expires_at: expiresAt,
          email: tokens.email,
          account_id: tokens.account_id,
          method: tokens.method || "oauth_pkce",
        }),
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.access_token;
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: false, error: "No access_token" };

    try {
      const response = await this.fetchWithTimeout(CODEX_USAGE_URL, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${tokens.access_token}`,
          "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
          // Required for multi-workspace/team accounts: without it, wham/usage
          // can return the wrong workspace's limits or 4xx. Mirrors codex-lb.
          ...(tokens.account_id ? { "chatgpt-account-id": tokens.account_id } : {}),
        },
      }, config.providerQuotaTimeoutMs);

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      const parsed = parseCodexUsage(data);
      return {
        success: true,
        quota: { limit: parsed.limit, remaining: parsed.remaining, used: parsed.used, resetAt: parsed.resetAt },
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  override async healthCheck(account: Account) {
    const valid = await this.validateAccount(account);
    if (!valid) {
      return { kind: "missing_tokens" as const, success: false, error: "No valid tokens available" };
    }

    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      return { kind: "missing_tokens" as const, success: false, error: "No access_token" };
    }

    try {
      const response = await this.fetchWithTimeout(CODEX_USAGE_URL, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${tokens.access_token}`,
          "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
          // Required for multi-workspace/team accounts (mirrors the chat path).
          ...(tokens.account_id ? { "chatgpt-account-id": tokens.account_id } : {}),
        },
      }, config.providerQuotaTimeoutMs);

      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_error" as const, success: false, retryable: true, error: `expired: HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { kind: "transient_error" as const, success: false, retryable: true, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      const parsed = parseCodexUsage(data);

      // Exhausted only when the hard ceiling (secondary window) is full AND no
      // credit-override rescues it. Credit-backed accounts stay healthy.
      const exhausted = parsed.remaining <= 0 && !parsed.creditOverrideActive;

      return {
        kind: exhausted ? ("exhausted" as const) : ("healthy" as const),
        success: true,
        quota: {
          limit: parsed.limit,
          remaining: parsed.remaining,
          used: parsed.used,
          resetAt: parsed.resetAt,
          source: "codex.wham-usage",
          // Surface the credit balance as overage capacity when the plan limit
          // is full but credits keep the account usable.
          ...(parsed.creditOverrideActive
            ? {
                overage: {
                  enabled: true,
                  capable: true,
                  used: 0,
                  cap: parsed.credits.unlimited ? Infinity : parsed.credits.balance,
                  remaining: parsed.credits.unlimited ? Infinity : parsed.credits.balance,
                },
              }
            : {}),
        },
        metadata: {
          codex_quota: {
            plan_type: parsed.planType,
            primary: {
              used_percent: parsed.primaryUsedPercent,
              reset_at: parsed.primaryResetAt?.toISOString() ?? null,
            },
            secondary: {
              used_percent: parsed.secondaryUsedPercent,
              reset_at: parsed.secondaryResetAt?.toISOString() ?? null,
            },
            rate_limited: parsed.rateLimited,
            credits: parsed.credits,
            rate_limit_reset_credits: parsed.rateLimitResetCredits,
            additional_rate_limits: parsed.additionalRateLimits,
            credit_override_active: parsed.creditOverrideActive,
          },
        },
      };
    } catch (e) {
      return { kind: "transient_error" as const, success: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Liveness warmup probe (codex-lb style): send a minimal streaming
   * completion to /backend-api/codex/responses and confirm the account can
   * actually serve a turn — not just that its token parses. Returns "ok" on a
   * `response.completed` SSE event, "rate_limited" on 429/quota, "auth" on
   * 401/403, "failed" on response.failed/incomplete, "error" otherwise.
   *
   * Bounded by a short timeout; never throws. Used by healthCheck to validate
   * accounts that look healthy on paper (token present + quota > 0) but may be
   * silently dead — the wham/usage endpoint can report stale limits.
   */
  async probeLiveness(account: Account, model = "codex-auto"): Promise<"ok" | "rate_limited" | "auth" | "failed" | "error"> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return "auth";

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
      "OpenAI-Beta": "responses=experimental",
      "originator": "codex-cli",
    };
    if (tokens.account_id) headers["chatgpt-account-id"] = tokens.account_id;

    const body = JSON.stringify({
      model: this.resolveModel(model),
      instructions: "Reply with OK only.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "OK?" }] }],
      tools: [],
      store: false,
      stream: true,
      include: [],
      max_output_tokens: 4,
    });

    try {
      const response = await this.fetchWithTimeout(CODEX_RESPONSES_URL, {
        method: "POST",
        headers,
        body,
      }, 15_000);

      if (response.status === 401) return "auth";
      if (response.status === 403) return "auth";
      if (response.status === 429) return "rate_limited";
      if (!response.ok || !response.body) return response.status >= 500 ? "error" : "failed";

      // Scan the SSE stream for a terminal event. response.completed = alive.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines; parse `event:`/`data:` pairs.
        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const json = (() => { try { return JSON.parse(dataLine.slice(5).trim()); } catch { return null; } })();
          const t = json?.type || "";
          if (t === "response.completed") return "ok";
          if (t === "response.failed" || t === "response.incomplete") return "failed";
          if (t === "error") return "failed";
        }
      }
      // Stream ended without an explicit terminal event — treat as alive (the
      // model produced deltas) but uncertain; "ok" keeps a working account in
      // rotation, the usage check still gates quota.
      return "ok";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|abort/i.test(msg)) return "error";
      return "error";
    }
  }
}
