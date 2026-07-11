/**
 * Grok provider — grok.com web app-chat + console.x.ai API.
 *
 * Ported from grok2api (jiujiu532/grok2api) reverse-engineering of grok.com.
 *
 * Two upstream surfaces:
 *   1. grok.com web  — POST /rest/app-chat/conversations/new (SSE)
 *      Auth: SSO cookies (sso + sso-rw). Free web quota.
 *   2. console.x.ai  — POST /v1/chat/completions (OpenAI-compatible SSE)
 *      Auth: same SSO token as Bearer, OR an xAI API key.
 *      Separate console quota (free for basic accounts).
 *
 * Model routing:
 *   - Models with modeId CONSOLE  → console.x.ai API
 *   - All other models            → grok.com web app-chat
 */

import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import {
  GROK_ENDPOINTS,
  MODEL_TO_MODE,
  type GrokModeId,
  buildChatPayload,
  StreamAdapter,
  parseSseEvents,
  consoleChunkToEvents,
} from "./protocol";

// ---------------------------------------------------------------------------
// Token structure
// ---------------------------------------------------------------------------

export interface GrokTokens {
  /** grok.com SSO cookie value (the `sso` cookie). */
  sso?: string;
  /** grok.com SSO-RW cookie value (the `sso-rw` cookie). */
  ssoRw?: string;
  /** console.x.ai API key (optional — if absent, SSO is reused as Bearer). */
  apiKey?: string;
  /** Account tier: basic / super / heavy — controls which models are available. */
  tier?: "basic" | "super" | "heavy";
  email?: string;
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

const GROK_MODELS: ModelInfo[] = [
  // grok.com web surface
  { id: "grok-4.20", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-4.20-fast", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-4.20-reasoning", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-4.20-super", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-4.20-heavy", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-4.3", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-4.3-beta", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-4.3-reasoning", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-4.3-heavy", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  // Console API surface
  { id: "grok-4.5", object: "model", created: 1718000000, owned_by: "xai", context_window: 500_000, max_output: 65_536, thinking: true, vision: true },
  { id: "grok-4.5-reasoning", object: "model", created: 1718000000, owned_by: "xai", context_window: 500_000, max_output: 65_536, thinking: true, vision: true },
  // Web-surface aliases
  { id: "grok-auto", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-fast", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-reasoning", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-heavy", object: "model", created: 1718000000, owned_by: "xai", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
];

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GrokProvider extends BaseProvider {
  name = "grok";
  supportedModels = GROK_MODELS;

  override ownsModel(model: string): boolean {
    const m = model.toLowerCase();
    // Claim any grok-4.x model and the generic grok-* aliases.
    // We explicitly do NOT claim "grok-2" or "grok-beta" (legacy console models
    // that may be served by other providers).
    return m.startsWith("grok-4") || m.startsWith("grok-4.") ||
           m === "grok-auto" || m === "grok-fast" ||
           m === "grok-reasoning" || m === "grok-heavy";
  }

  private resolveMode(model: string): GrokModeId {
    const m = model.toLowerCase();
    return MODEL_TO_MODE[m] ?? "AUTO";
  }

  private isConsoleModel(model: string): boolean {
    return this.resolveMode(model) === "CONSOLE";
  }

  private getTokens(account: Account): GrokTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as GrokTokens;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Chat completion (non-streaming)
  // -------------------------------------------------------------------------

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    try {
      const tokens = this.getTokens(account);
      if (!tokens) throw new Error("expired: no tokens");

      const id = `chatcmpl-grok-${Date.now()}`;
      const created = now();
      const model = request.model;
      const useConsole = this.isConsoleModel(model);

      // Collect the full stream into a single response.
      let text = "";
      let reasoning = "";
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const stream = useConsole
        ? await this.makeConsoleStream(account, tokens, request, id, created)
        : await this.makeWebStream(account, tokens, request, id, created);

      if (!stream) {
        return { success: false, error: "Failed to create upstream stream" };
      }

      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value, { stream: true });
        // Parse SSE chunks from our own stream output.
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) text += delta.content;
            if ((delta as any)?.reasoning_content) reasoning += (delta as any).reasoning_content;
          } catch { /* ignore */ }
        }
      }

      const promptTokens = (request.messages?.length ?? 0) * 100;
      const completionTokens = Math.ceil(text.length / 4);

      const response: ChatCompletionResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text || "",
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };

      return { success: true, response, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (err: any) {
      return this.classifyError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Chat completion (streaming)
  // -------------------------------------------------------------------------

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    try {
      const tokens = this.getTokens(account);
      if (!tokens) throw new Error("expired: no tokens");

      const id = `chatcmpl-grok-${Date.now()}`;
      const created = now();
      const model = request.model;
      const useConsole = this.isConsoleModel(model);

      const stream = useConsole
        ? await this.makeConsoleStream(account, tokens, request, id, created)
        : await this.makeWebStream(account, tokens, request, id, created);

      if (!stream) {
        return { success: false, error: "Failed to create upstream stream" };
      }

      return { success: true, stream };
    } catch (err: any) {
      return this.classifyError(err);
    }
  }

  // -------------------------------------------------------------------------
  // grok.com web app-chat → ReadableStream<Uint8Array> (SSE-encoded)
  // -------------------------------------------------------------------------

  private async makeWebStream(
    account: Account,
    tokens: GrokTokens,
    request: ChatCompletionRequest,
    id: string,
    created: number
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (!tokens.sso) throw new Error("expired: no SSO cookie");

    const model = request.model;
    const modeId = this.resolveMode(model);
    const systemPrompt = request.messages?.find((m) => m.role === "system")?.content;
    const systemText = typeof systemPrompt === "string" ? systemPrompt : "";
    const history = (request.messages ?? [])
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));
    const lastUser = history.filter((m) => m.role === "user").pop();
    const priorHistory = history.slice(0, -1);
    const userMessage = lastUser?.content ?? "";

    const wantReasoning = (request as any).reasoning === true ||
      (request as any).reasoning_effort != null ||
      model.includes("reasoning") ||
      modeId === "EXPERT" || modeId === "HEAVY";

    const payload = buildChatPayload({
      message: userMessage,
      modeId,
      systemPrompt: systemText,
      reasoning: wantReasoning,
      history: priorHistory,
    });

    const response = await fetch(GROK_ENDPOINTS.APP_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/event-stream",
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`expired: HTTP ${response.status}`);
    }
    if (response.status === 429) {
      throw new Error("rate_limited: HTTP 429");
    }
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      throw new Error(`error: HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const upstream = response.body;
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const adapter = new StreamAdapter({ showSearchSources: true });
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let started = false;
        let finished = false;

        const emit = (delta: Record<string, any>, finish_reason: string | null = null) => {
          const chunk = {
            id, object: "chat.completion.chunk" as const,
            created, model,
            choices: [{ index: 0, delta, finish_reason }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        const emitRole = () => {
          if (started) return;
          started = true;
          emit({ role: "assistant" });
        };

        try {
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE events (separated by double newlines).
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const rawEvent = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);

              const dataLines = parseSseEvents(rawEvent);
              for (const data of dataLines) {
                const events = adapter.feed(data);
                for (const evt of events) {
                  switch (evt.type) {
                    case "text":
                      emitRole();
                      emit({ content: evt.text });
                      break;
                    case "reasoning":
                      emitRole();
                      emit({ reasoning_content: evt.text });
                      break;
                    case "tool_use":
                      emitRole();
                      emit({
                        tool_calls: [{
                          index: 0,
                          id: `call_grok_${Date.now()}`,
                          type: "function",
                          function: { name: evt.toolName ?? "", arguments: evt.toolArgs ?? "" },
                        }],
                      });
                      break;
                    case "citation":
                      // Citations are already rendered inline in the text token.
                      break;
                    case "error":
                      throw new Error(
                        evt.errorStatus === 429
                          ? `rate_limited: ${evt.errorMessage}`
                          : `error: ${evt.errorMessage}`
                      );
                    case "done":
                      finished = true;
                      break;
                  }
                }
              }
            }
          }
        } catch (err: any) {
          controller.error(err);
          return;
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }

        // Append sources footer if configured.
        const footer = adapter.getSourcesFooter();
        if (footer) {
          emitRole();
          emit({ content: footer });
        }

        // Final chunk with finish_reason.
        emit({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  // -------------------------------------------------------------------------
  // console.x.ai API → ReadableStream<Uint8Array> (SSE-encoded)
  // -------------------------------------------------------------------------

  private async makeConsoleStream(
    account: Account,
    tokens: GrokTokens,
    request: ChatCompletionRequest,
    id: string,
    created: number
  ): Promise<ReadableStream<Uint8Array> | null> {
    const auth = tokens.apiKey ?? tokens.sso;
    if (!auth) throw new Error("expired: no API key or SSO token for console");

    const consoleModel = this.mapConsoleModel(request.model);

    const body: Record<string, any> = {
      model: consoleModel,
      messages: request.messages,
      stream: true,
    };
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.max_tokens != null) body.max_tokens = request.max_tokens;
    if ((request as any).tools) body.tools = (request as any).tools;

    const response = await fetch(GROK_ENDPOINTS.CONSOLE_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth}`,
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`expired: HTTP ${response.status}`);
    }
    if (response.status === 429) {
      throw new Error("rate_limited: HTTP 429");
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`error: HTTP ${response.status} ${text.slice(0, 200)}`);
    }

    const upstream = response.body;
    const encoder = new TextEncoder();
    const model = request.model;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let started = false;
        let finished = false;

        const emit = (delta: Record<string, any>, finish_reason: string | null = null) => {
          const chunk = {
            id, object: "chat.completion.chunk" as const,
            created, model,
            choices: [{ index: 0, delta, finish_reason }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        const emitRole = () => {
          if (started) return;
          started = true;
          emit({ role: "assistant" });
        };

        try {
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const rawEvent = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);

              const dataLines = parseSseEvents(rawEvent);
              for (const data of dataLines) {
                if (data === "[DONE]") {
                  finished = true;
                  continue;
                }

                let chunk: any;
                try {
                  chunk = JSON.parse(data);
                } catch {
                  continue;
                }

                const events = consoleChunkToEvents(chunk);
                for (const evt of events) {
                  switch (evt.type) {
                    case "text":
                      emitRole();
                      emit({ content: evt.text });
                      break;
                    case "reasoning":
                      emitRole();
                      emit({ reasoning_content: evt.text });
                      break;
                    case "tool_use":
                      emitRole();
                      emit({
                        tool_calls: [{
                          index: 0,
                          id: `call_grok_${Date.now()}`,
                          type: "function",
                          function: { name: evt.toolName ?? "", arguments: evt.toolArgs ?? "" },
                        }],
                      });
                      break;
                    case "done":
                      finished = true;
                      break;
                  }
                }
              }
            }
          }
        } catch (err: any) {
          controller.error(err);
          return;
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }

        emit({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Map an etteum grok model slug to the console.x.ai API model name. */
  private mapConsoleModel(model: string): string {
    const m = model.toLowerCase();
    if (m.startsWith("grok-4.5")) return "grok-4.5";
    if (m.startsWith("grok-4.3")) return "grok-4.3";
    return "grok-4.5"; // default to latest
  }

  /** Classify an error into a ProviderResult failure. */
  private classifyError(err: any): ProviderResult {
    const msg = err?.message ?? String(err);
    if (/expired|unauthorized|401|403/i.test(msg)) {
      return { success: false, error: `expired: ${msg}` };
    }
    if (/rate_limit|429|too many/i.test(msg)) {
      return { success: false, error: `rate_limited: ${msg}`, rateLimited: true };
    }
    return { success: false, error: `error: ${msg}` };
  }

  // -------------------------------------------------------------------------
  // Token refresh (SSO cookies are long-lived — no refresh needed)
  // -------------------------------------------------------------------------

  async refreshToken(account: Account): Promise<{
    success: boolean;
    tokens?: string;
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.sso) {
      return { success: false, error: "No SSO cookie to refresh" };
    }
    // SSO cookies don't have a refresh-token flow. Validate and return as-is.
    const valid = await this.validateAccount(account);
    if (!valid) {
      return { success: false, error: "expired: SSO cookie invalid" };
    }
    return {
      success: true,
      tokens: JSON.stringify({
        sso: tokens.sso,
        ssoRw: tokens.ssoRw ?? tokens.sso,
        ...(tokens.apiKey ? { apiKey: tokens.apiKey } : {}),
        ...(tokens.tier ? { tier: tokens.tier } : {}),
        ...(tokens.email ? { email: tokens.email } : {}),
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Quota fetching
  // -------------------------------------------------------------------------

  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{
    success: boolean;
    quota?: {
      limit: number;
      remaining: number;
      used: number;
      resetAt?: Date | string | null;
    };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.sso) {
      return { success: false, error: "No SSO cookie" };
    }

    try {
      const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
        method: "GET",
        headers: {
          "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Referer": "https://grok.com/",
        },
        signal,
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;

      // Normalize grok.com rate-limit response into the quota shape.
      const limit = data?.totalQueries ?? data?.total ?? 100;
      const remaining = data?.remainingQueries ?? data?.remaining ?? 0;
      const used = limit - remaining;
      const resetAt = data?.windowSeconds
        ? new Date(Date.now() + data.windowSeconds * 1000)
        : null;

      return {
        success: true,
        quota: { limit, remaining, used, resetAt },
      };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { success: false, error: "aborted" };
      }
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Check if an account's tokens are still valid by hitting the rate-limits
   * endpoint. Returns true if the account is alive.
   */
  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    if (!tokens?.sso) return false;

    try {
      const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
        method: "GET",
        headers: {
          "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch the account's current rate-limit / quota status from grok.com.
   * Returns the raw quota object or null on failure.
   */
  async getQuota(account: Account): Promise<any | null> {
    const tokens = this.getTokens(account);
    if (!tokens?.sso) return null;

    try {
      const response = await fetch(GROK_ENDPOINTS.RATE_LIMITS, {
        method: "GET",
        headers: {
          "Cookie": `sso=${tokens.sso}; sso-rw=${tokens.ssoRw ?? tokens.sso}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }
}