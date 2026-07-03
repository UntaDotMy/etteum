import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";
import { normalizeMessagesToOpenAI } from "../transforms/anthropic";
import { normalizeMessagesToOpenAI, normalizeToolsToOpenAI } from "../transforms/anthropic";
import { applyModelSpecs } from "../model-specs";

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

const YOUMIND_BASE = "https://youmind.com";
const ANTHROPIC_RELAY_URL = `${YOUMIND_BASE}/openapi/v1/chat/anthropic/v1/messages`;
const OPENAI_RELAY_URL = `${YOUMIND_BASE}/openapi/v1/chat/openai/v1/chat/completions`;
const ANTHROPIC_MODELS_URL = `${YOUMIND_BASE}/openapi/v1/chat/anthropic/v1/models`;
const LIST_BOARDS_URL = `${YOUMIND_BASE}/openapi/v1/listBoards`;
const ANTHROPIC_VERSION = "2023-06-01";

type YouMindRoute = "anthropic" | "openai";

interface YouMindModelDef {
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
const YM_MODELS: YouMindModelDef[] = [
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

const MODEL_BY_ID: Record<string, YouMindModelDef> = Object.fromEntries(
  YM_MODELS.map((m) => [m.id.toLowerCase(), m]),
);

/** GPT-5.x family rejects `max_tokens` and requires `max_completion_tokens`. */
function isGpt5Family(upstream: string): boolean {
  return /^gpt-5(\.|$)/i.test(upstream);
}

/**
 * Identity payload returned by /openapi/v1/listBoards. We only consume what we
 * need to derive a stable email-like account label.
 */
interface ListBoardsItem {
  id?: string;
  space_id?: string;
  creator_id?: string;
  name?: string;
  snips_count?: number;
  thoughts_count?: number;
  crafts_count?: number;
}

export class YouMindProvider extends BaseProvider {
  name = "youmind";

  /**
   * Native wire format. We pick "openai" because client-facing requests come
   * in OpenAI shape (Bun's /v1/chat/completions edge); the dispatcher inside
   * this provider handles the openai↔anthropic translation when the resolved
   * route is `anthropic`.
   */
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("ym-");
  }

  supportedModels: ModelInfo[] = applyModelSpecs(YM_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "youmind",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: m.thinking,
    vision: m.vision,
    creditUnit: "token" as const,
    creditRate: m.creditRate,
    creditSource: "estimated" as const,
  })), (m) => m.id.replace(/^ym-/, ""));

  // ── Helpers ────────────────────────────────────────────────────────

  private resolveModel(model: string): YouMindModelDef | null {
    return MODEL_BY_ID[model.toLowerCase()] ?? null;
  }

  /**
   * The real API key lives in `password` (XOR-encrypted at rest). We never
   * store it elsewhere — `tokens` JSON is reserved for ephemeral metadata
   * (e.g. last validation timestamp).
   */
  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      return "";
    }
  }

  // ── Provider Interface ─────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown YouMind model: ${request.model}` };
    return def.route === "anthropic"
      ? this.chatCompletionAnthropic(account, def, request)
      : this.chatCompletionOpenAI(account, def, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown YouMind model: ${request.model}` };
    return def.route === "anthropic"
      ? this.chatCompletionStreamAnthropic(account, def, request)
      : this.chatCompletionStreamOpenAI(account, def, request);
  }

  /** YouMind keys are static — user manages rotation upstream. */
  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  /**
   * YouMind doesn't expose per-account credit numbers in its public OpenAPI
   * (the dashboard shows credits but no documented endpoint surfaces them).
   * We probe `/listBoards` as a cheap liveness check — it's the smallest
   * authenticated POST that returns 401 if the key is revoked. Quota is
   * reported as `-1` (sentinel for "unlimited / unknown") so the warmup
   * runner won't flip the account to exhausted on a real positive limit.
   */
  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    try {
      const resp = await this.fetchWithTimeout(LIST_BOARDS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: "{}",
      }, undefined, signal);

      if (resp.status === 401) {
        return { success: false, error: `expired: HTTP 401` };
      }
      if (resp.status === 403) {
        return { success: false, error: `banned: HTTP 403` };
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `YouMind quota probe HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }
      // Drain body — even if we don't use the data, leaving the socket dirty
      // can leak fd handles under bun's keepalive.
      await resp.text().catch(() => "");
      return {
        success: true,
        // YouMind doesn't expose a real quota via listBoards — return
        // undefined to preserve existing DB values.
        quota: undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic relay ────────────────────────────────────────────────

  private async chatCompletionAnthropic(
    account: Account,
    def: YouMindModelDef,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toAnthropicRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(ANTHROPIC_RELAY_URL, {
        method: "POST",
        headers: this.anthropicHeaders(apiKey),
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp, "YouMind anthropic");
      if (errResult) return errResult;

      const data = (await resp.json()) as any;
      const response = this.fromAnthropicResponse(data, request.model);
      const promptTokens = response.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = response.usage.completion_tokens || 0;

      return {
        success: true,
        response,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamAnthropic(
    account: Account,
    def: YouMindModelDef,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toAnthropicRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(ANTHROPIC_RELAY_URL, {
        method: "POST",
        headers: { ...this.anthropicHeaders(apiKey), Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp, "YouMind anthropic stream");
      if (errResult) return errResult;
      if (!resp.body) return { success: false, error: "YouMind response missing body" };

      const stream = this.transformAnthropicStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── OpenAI relay ───────────────────────────────────────────────────

  private async chatCompletionOpenAI(
    account: Account,
    def: YouMindModelDef,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toOpenAIRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(OPENAI_RELAY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp, "YouMind openai");
      if (errResult) return errResult;

      const data = (await resp.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };

      const promptTokens = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(request.messages);
      const completionTokens =
        data.usage?.completion_tokens ??
        this.estimateTokens(typeof choice.message?.content === "string" ? choice.message.content : "");

      // Return the original ym- prefixed model id to the client.
      data.model = request.model;

      return {
        success: true,
        response: data,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamOpenAI(
    account: Account,
    def: YouMindModelDef,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toOpenAIRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(OPENAI_RELAY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp, "YouMind openai stream");
      if (errResult) return errResult;
      if (!resp.body) return { success: false, error: "YouMind response missing body" };

      const stream = this.passthroughOpenAIStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Header builders ────────────────────────────────────────────────

  private anthropicHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  /**
   * Single source of truth for upstream HTTP error mapping. Returns a
   * ProviderResult when the response should NOT proceed; returns null when
   * the caller should keep parsing the body.
   */
  private async handleErrorResponse(
    resp: Response,
    label: string,
  ): Promise<ProviderResult | null> {
    if (resp.ok) return null;
    if (resp.status === 401) {
      return { success: false, error: `expired: HTTP 401` };
    }
    if (resp.status === 403) {
      return { success: false, error: `banned: HTTP 403`, banned: true };
    }
    if (resp.status === 429) {
      const text = await resp.text().catch(() => "");
      // YouMind Relay returns 429 both for upstream rate limit AND for
      // exhausted YouMind credits. Conservatively treat as rate limit so we
      // don't poison the account on a transient burst; warmup runs the
      // proper liveness probe to confirm.
      return { success: false, error: text || "Rate limited", rateLimited: true };
    }
    const text = await resp.text().catch(() => "");
    return { success: false, error: `${label} HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  // ── OpenAI request shaping ─────────────────────────────────────────

  /**
   * Build the OpenAI Chat Completions body. Two responsibilities:
   *
   * 1. Sanitize the message array. The internal `ChatCompletionRequest` shape
   *    is OpenAI-flavored, but agentic clients (Claude Code, Cline, etc.)
   *    routinely send Anthropic-style content blocks — `tool_use`,
   *    `tool_result`, `image` (with `source.base64`) — sometimes mixed with
   *    OpenAI-style ones in the same request. The OpenAI relay rejects every
   *    block type it doesn't natively know with errors like:
   *      "Invalid value: 'tool_use'. Supported values are: 'text', …"
   *    so we convert each message into the canonical OpenAI shape:
   *      • `tool_use` blocks → assistant.tool_calls
   *      • `tool_result` blocks → separate role:"tool" messages
   *      • Anthropic image source → image_url data URL
   *
   * 2. Translate `max_tokens` → `max_completion_tokens` for GPT-5.x, which
   *    rejects the legacy field name ("Unsupported parameter: 'max_tokens'").
   */
  private toOpenAIRequest(
    request: ChatCompletionRequest,
    def: YouMindModelDef,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: def.upstream,
      messages: this.normalizeMessagesForOpenAI(request.messages),
      stream,
    };

    if (request.max_tokens !== undefined) {
      if (isGpt5Family(def.upstream)) {
        body.max_completion_tokens = request.max_tokens;
      } else {
        body.max_tokens = request.max_tokens;
      }
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.tools && request.tools.length > 0) body.tools = this.normalizeToolsForOpenAI(request.tools);
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;

    // Forward reasoning / thinking config to the OpenAI relay.
    // GPT-5.x models support `reasoning_effort` (openai format).
    if (def.thinking) {
      const isThinkingModel = request.model.toLowerCase().endsWith("-thinking");
      const effort = request.reasoning_effort
        || (request.thinking as any)?.effort
        || (isThinkingModel ? "high" : undefined);
      if (effort) {
        body.reasoning_effort = effort;
      }
    }

    return body;
  }

  /**
   * Tools may also arrive in Anthropic shape (`{name, description,
   * input_schema}`) when the client is Anthropic-native. The OpenAI relay
   * needs `{type:"function", function:{name, description, parameters}}`.
   */
  private normalizeToolsForOpenAI(tools: any[]): any[] {
    return tools
      .map((t) => {
        if (t?.type === "function" && t.function?.name) return t;
        if (t?.name) {
          return {
            type: "function",
            function: {
              name: t.name,
              description: t.description || "",
              parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
            },
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Pass through an OpenAI-compatible SSE stream, rewriting `id` and `model`
   * to the proxy-facing values so clients see a stable id and the original
   * `ym-*` model echo'd back. We intentionally don't re-parse deltas — the
   * upstream is fully OpenAI-compatible and this keeps the hot path tight.
   */
  private passthroughOpenAIStream(
    upstream: ReadableStream<Uint8Array>,
    originalModel: string,
  ): ReadableStream<Uint8Array> {
    const id = this.generateId();
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              const payload = dataLine.slice(6).trim();
              if (!payload) continue;
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              try {
                const chunk = JSON.parse(payload);
                chunk.id = id;
                chunk.model = originalModel;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                // Skip malformed chunks rather than tearing down the stream.
              }
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch { /* already errored */ }
        } finally {
          try { reader.releaseLock(); } catch { /* noop */ }
        }
      },
    });
  }

  // ── Anthropic request shaping ──────────────────────────────────────

  /**
   * Convert an OpenAI-shaped ChatCompletionRequest into the Anthropic
   * Messages API request body. Mirrors the converter in BYOK, but driven by
   * the model definition (so we can respect `max_output` per model).
   *
   * - System messages are merged into the top-level `system` field.
   * - `tool` role messages become `user` turns carrying tool_result blocks.
   * - Anthropic has no native `frequency_penalty` / `presence_penalty`; we
   *   drop those silently (matches BYOK behavior).
   */
  private toAnthropicRequest(
    request: ChatCompletionRequest,
    def: YouMindModelDef,
    stream: boolean,
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (text) systemParts.push(text);
        continue;
      }

      // Anthropic expects only "user" / "assistant" roles; tool results are
      // user-side content blocks.
      const role = msg.role === "tool" ? "user" : msg.role;

      // Map an OpenAI tool message to an Anthropic tool_result block.
      if (msg.role === "tool") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? (msg.content as any[]).map((b) => (b?.type === "text" ? b.text : JSON.stringify(b))).join("\n")
              : "";
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: (msg as any).tool_call_id,
              content,
            },
          ],
        });
        continue;
      }

      // Map an OpenAI assistant message with tool_calls to Anthropic's
      // tool_use blocks.
      if (msg.role === "assistant" && (msg as any).tool_calls?.length) {
        const blocks: any[] = [];
        if (typeof msg.content === "string" && msg.content) {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const tc of (msg as any).tool_calls as any[]) {
          let input: any = {};
          try {
            input = typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {};
          } catch {
            input = { _raw: tc.function?.arguments };
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name,
            input,
          });
        }
        messages.push({ role: "assistant", content: blocks });
        continue;
      }

      messages.push({ role, content: msg.content });
    }

    const body: Record<string, unknown> = {
      model: def.upstream,
      messages,
      max_tokens: Math.min(request.max_tokens || 4096, def.max_output),
      stream,
    };
    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    // Forward thinking/reasoning config to the Anthropic relay.
    // YouMind passes this through to upstream Claude models that support
    // extended thinking. The -thinking model suffix is the proxy's own
    // convention; translate it to the Anthropic thinking block.
    const isThinkingSuffix = request.model.toLowerCase().endsWith("-thinking");
    if (def.thinking && (isThinkingSuffix || request.thinking || request.reasoning_effort)) {
      const budget = request.thinking?.budget_tokens
        ? Math.min(request.thinking.budget_tokens, def.max_output)
        : Math.min(def.max_output, 16000);
      body.thinking = {
        type: "enabled",
        budget_tokens: budget,
        ...(request.thinking?.display ? { display: request.thinking.display } : {}),
        ...(request.thinking?.summary ? { summary: request.thinking.summary } : {}),
        ...(request.thinking?.effort || request.reasoning_effort
          ? { effort: request.thinking?.effort || request.reasoning_effort }
          : {}),
      };
    }
    if (request.tools && request.tools.length > 0) {
      // Convert OpenAI tool defs `{type:"function", function:{name,description,parameters}}`
      // to Anthropic `{name, description, input_schema}` shape. Pass already-
      // Anthropic-shaped tools through.
      body.tools = request.tools
        .map((t: any) => {
          if (t?.name && t?.input_schema) return t;
          const fn = t?.function;
          if (!fn?.name) return null;
          return {
            name: fn.name,
            description: fn.description || "",
            input_schema: fn.parameters || { type: "object", properties: {} },
          };
        })
        .filter(Boolean);
    }
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;

    return body;
  }

  /** Convert Anthropic non-stream response → OpenAI ChatCompletionResponse. */
  private fromAnthropicResponse(data: any, originalModel: string): ChatCompletionResponse {
    const content: any[] = Array.isArray(data?.content) ? data.content : [];
    const textContent = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text || "")
      .join("");

    // Extract thinking/reasoning content from Anthropic thinking blocks.
    const reasoningContent = content
      .filter((c: any) => c?.type === "thinking")
      .map((c: any) => c.thinking || c.text || "")
      .join("");

    const toolCalls = content
      .filter((c: any) => c?.type === "tool_use")
      .map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name || "", arguments: JSON.stringify(c.input || {}) },
      }));

    const inputTokens = Number(data?.usage?.input_tokens) || 0;
    const outputTokens = Number(data?.usage?.output_tokens) || 0;
    const finishReason =
      data?.stop_reason === "tool_use"
        ? "tool_calls"
        : data?.stop_reason === "max_tokens"
          ? "length"
          : "stop";

    return {
      id: data?.id || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          } as any,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Transform an Anthropic SSE stream → OpenAI-compatible SSE stream.
   *
   * Handles the Anthropic event types that carry data we care about:
   *   • message_start        — emit role:"assistant" first delta
   *   • content_block_delta  — emit content text deltas
   *   • content_block_start  — start tool_use blocks
   *   • input_json_delta     — emit tool_calls.function.arguments deltas
   *   • message_delta        — capture output_tokens
   *   • message_stop         — emit final stop chunk + [DONE]
   *
   * The stop_reason from message_delta drives finish_reason mapping.
   */
  private transformAnthropicStream(
    upstream: ReadableStream<Uint8Array>,
    originalModel: string,
  ): ReadableStream<Uint8Array> {
    const id = this.generateId();
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let started = false;
        let finishEmitted = false;
        let stopReason: string | null = null;

        // Tool-call assembly: Anthropic streams tool calls as a sequence of
        // content_block_start (with the tool_use header) followed by N
        // input_json_delta events. We keep an index → (id, name) map so we
        // can emit OpenAI-style deltas with the right index/id.
        const toolByBlockIdx = new Map<number, { idx: number; id: string; name: string }>();
        let nextToolIdx = 0;

        const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: originalModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          };
          return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        const ensureStarted = () => {
          if (started) return;
          started = true;
          controller.enqueue(makeChunk({ role: "assistant" }));
        };

        const mapStopReason = (s: string | null): string => {
          if (s === "tool_use") return "tool_calls";
          if (s === "max_tokens") return "length";
          return "stop";
        };

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;

              const payload = dataLine.slice(6).trim();
              if (!payload) continue;
              if (payload === "[DONE]") {
                if (!finishEmitted) controller.enqueue(makeChunk({}, mapStopReason(stopReason)));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              let event: any;
              try { event = JSON.parse(payload); } catch { continue; }

              const t = event?.type;
              if (t === "message_start") {
                ensureStarted();
                continue;
              }

              if (t === "content_block_start") {
                ensureStarted();
                const block = event.content_block;
                const blockIndex = Number(event.index ?? 0);
                if (block?.type === "tool_use") {
                  const idx = nextToolIdx++;
                  toolByBlockIdx.set(blockIndex, {
                    idx,
                    id: block.id || `call_${idx}`,
                    name: block.name || "",
                  });
                  controller.enqueue(makeChunk({
                    tool_calls: [{
                      index: idx,
                      id: block.id || `call_${idx}`,
                      type: "function",
                      function: { name: block.name || "", arguments: "" },
                    }],
                  }));
                }
                // thinking blocks — no init needed, deltas arrive in content_block_delta
                continue;
              }

              if (t === "content_block_delta") {
                ensureStarted();
                const blockIndex = Number(event.index ?? 0);
                const delta = event.delta;
                if (delta?.type === "text_delta" && typeof delta.text === "string") {
                  if (delta.text) controller.enqueue(makeChunk({ content: delta.text }));
                  continue;
                }
                if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                  if (delta.thinking) controller.enqueue(makeChunk({ reasoning_content: delta.thinking }));
                  continue;
                }
                if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                  const tool = toolByBlockIdx.get(blockIndex);
                  if (tool) {
                    controller.enqueue(makeChunk({
                      tool_calls: [{
                        index: tool.idx,
                        id: tool.id,
                        type: "function",
                        function: { arguments: delta.partial_json },
                      }],
                    }));
                  }
                  continue;
                }
                continue;
              }

              if (t === "message_delta") {
                if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
                continue;
              }

              if (t === "message_stop") {
                ensureStarted();
                controller.enqueue(makeChunk({}, mapStopReason(stopReason)));
                finishEmitted = true;
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              // ping, content_block_stop, error → ignore (or handled by [DONE]).
            }
          }

          // Upstream closed without an explicit message_stop. Emit a clean tail.
          if (!started) controller.enqueue(makeChunk({ role: "assistant", content: "" }));
          if (!finishEmitted) controller.enqueue(makeChunk({}, mapStopReason(stopReason)));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch { /* already errored */ }
        } finally {
          try { reader.releaseLock(); } catch { /* noop */ }
        }
      },
    });
  }

  // ── Health check ───────────────────────────────────────────────────

  /**
   * Override the default healthCheck. Default implementation calls
   * fetchQuota; we already do that, but YouMind also returns an `accounts`
   * array on listBoards we could enrich metadata from. Keep it lean for
   * warmup hot path — fetchQuota already validates auth + liveness.
   */
  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key" };
    }

    const quota = await this.fetchQuota(account, signal);
    if (!quota.success) {
      const msg = quota.error || "quota check failed";
      if (/^expired:/i.test(msg)) {
        return { kind: "session_expired", success: false, error: msg };
      }
      return { kind: "transient_error", success: false, retryable: true, error: msg };
    }

    return {
      kind: "healthy",
      success: true,
      // YouMind doesn't expose a real quota API — return undefined to preserve
      // existing DB values instead of clobbering them with -1/-1.
      quota: undefined,
    };
  }
}

// ============================================================================
// Public helpers (used by accounts API for add-account flow)
// ============================================================================

export interface YouMindActivation {
  email: string;
  metadata: Record<string, unknown>;
}

/**
 * Validate a YouMind API key and derive a stable email-like identifier from
 * the listBoards response. We don't have access to the user's real email
 * via this OpenAPI surface, so we synthesize a deterministic label keyed on
 * the space_id (which is constant per account). That guarantees idempotent
 * upserts: pasting the same key twice updates the same row.
 *
 * Throws a human-readable Error on validation failure.
 */
export async function activateYouMindKey(apiKey: string): Promise<YouMindActivation> {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("sk-ym-")) {
    throw new Error("YouMind API key must start with sk-ym-");
  }

  // Probe 1 — listBoards. Cheapest authenticated endpoint, returns the
  // user's space_id even when the account has zero boards (empty array).
  let listBoardsResp: Response;
  try {
    listBoardsResp = await fetch(LIST_BOARDS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": trimmed,
      },
      body: "{}",
    });
  } catch (err) {
    throw new Error(`Network error contacting YouMind: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (listBoardsResp.status === 401 || listBoardsResp.status === 403) {
    throw new Error(`API key rejected (HTTP ${listBoardsResp.status})`);
  }
  if (!listBoardsResp.ok) {
    const text = await listBoardsResp.text().catch(() => "");
    throw new Error(`YouMind listBoards HTTP ${listBoardsResp.status}: ${text.slice(0, 160)}`);
  }

  const boards = (await listBoardsResp.json().catch(() => [])) as ListBoardsItem[];

  // space_id is constant per YouMind account; creator_id is the user UUID.
  // We prefer space_id for the synthetic email so multiple keys created by
  // the same user collapse onto a single account row.
  const spaceId =
    boards.find((b) => b?.space_id)?.space_id ??
    boards.find((b) => b?.creator_id)?.creator_id ??
    // No boards at all — fall back to a hash of the key tail so different
    // keys still produce distinct rows.
    `keytail-${trimmed.slice(-8)}`;

  const email = `youmind-${spaceId}@apikey`;

  // Probe 2 — best-effort models list. Used only to enrich metadata; a
  // failure here is non-fatal (key was already validated by probe 1).
  let availableModels: string[] = [];
  try {
    const modelsResp = await fetch(ANTHROPIC_MODELS_URL, {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    if (modelsResp.ok) {
      const modelsData = (await modelsResp.json().catch(() => null)) as
        | { data?: Array<{ id?: string }> }
        | null;
      if (modelsData?.data) {
        availableModels = modelsData.data.map((m) => m.id || "").filter(Boolean);
      }
    }
  } catch { /* non-fatal */ }

  const metadata: Record<string, unknown> = {
    space_id: boards.find((b) => b?.space_id)?.space_id ?? null,
    creator_id: boards.find((b) => b?.creator_id)?.creator_id ?? null,
    boards_count: boards.length,
    available_anthropic_models: availableModels,
    validated_at: new Date().toISOString(),
  };

  return { email, metadata };
}
