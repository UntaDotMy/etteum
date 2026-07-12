/**
 * Grok provider — grok.com web app-chat + console.x.ai API.
 *
 * Ported from grok2api (jiujiu532/grok2api) reverse-engineering of grok.com.
 *
 * Three upstream surfaces:
 *   1. grok.com web  — POST /rest/app-chat/conversations/new (SSE)
 *      Auth: SSO cookies (sso + sso-rw). Free web quota.
 *   2. console.x.ai  — POST /v1/chat/completions (OpenAI-compatible SSE)
 *      Auth: same SSO token as Bearer, OR an xAI API key.
 *      Separate console quota (free for basic accounts).
 *   3. cli-chat-proxy.grok.com — POST /v1/responses (OpenAI Responses API, SSE)
 *      Auth: OAuth2/OIDC access token from auth.x.ai (Bearer).
 *      Used by the official Grok CLI. Auto-refreshed via refresh_token.
 *
 * Model routing:
 *   - OAuth accounts (auth_method:"oauth")  → cli-chat-proxy Responses API
 *   - Models with modeId CONSOLE            → console.x.ai API
 *   - All other (SSO) models                → grok.com web app-chat
 */

import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
  type ProviderHealthResult,
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
import {
  GROK_OAUTH,
  isOAuthAccount,
  getOAuthTokens,
  ensureFreshAccessToken,
  exchangeRefreshToken,
  validateOAuthToken,
  getGrokCliVersion,
  fetchOAuthBillingQuota,
  type GrokOAuthTokens,
} from "./oauth";

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

/**
 * Conservative prompt-token estimate when the upstream reports no usage
 * (i.e. the SSO web surface). Uses a char/4 heuristic summed across all
 * message content. Used only as a fallback — OAuth/Responses surface reports
 * real usage.
 */
function estimatePromptTokens(request: ChatCompletionRequest): number {
  let chars = 0;
  for (const msg of request.messages ?? []) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") chars += part.length;
        else if (part && typeof part.text === "string") chars += part.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

const GROK_CREATED = 1_718_000_000;

/** Catalog entries shown in /v1/models and the dashboard. owned_by is always
 *  "grok" (single provider — no parallel "xai" group). Keep in sync with
 *  MODEL_TO_MODE in protocol.ts and ownsModel() below so active-account
 *  filtering (`?active=1`) surfaces every model an active grok account can serve. */
const GROK_MODELS: ModelInfo[] = [
  // OAuth / cli-chat-proxy (latest free-tier model)
  { id: "grok-4.5", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 500_000, max_output: 65_536, thinking: true, vision: true },
  { id: "grok-4.5-reasoning", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 500_000, max_output: 65_536, thinking: true, vision: true },
  // grok.com web app-chat modes (SSO)
  { id: "grok-4.3", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 1_000_000, max_output: 65_536, thinking: true, vision: true },
  { id: "grok-4.3-reasoning", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-4.3-heavy", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-4.20", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-4.20-fast", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-4.20-reasoning", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-4.20-heavy", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  // Convenience aliases → web app-chat modes
  { id: "grok-auto", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-fast", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: false, vision: false },
  { id: "grok-reasoning", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
  { id: "grok-heavy", object: "model", created: GROK_CREATED, owned_by: "grok", context_window: 256_000, max_output: 65_536, thinking: true, vision: false },
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
      const oauthAccount = isOAuthAccount(account);
      const tokens = oauthAccount ? null : this.getTokens(account);
      if (!oauthAccount && !tokens) throw new Error("expired: no tokens");

      const id = `chatcmpl-grok-${Date.now()}`;
      const created = now();
      const model = request.model;
      const useConsole = this.isConsoleModel(model);

      // Collect the full stream into a single response.
      let text = "";
      let reasoning = "";
      /** Real upstream usage if reported (OAuth/Responses surface); null = estimate. */
      const usageHolder: { value: { prompt_tokens: number; completion_tokens: number } | null } = { value: null };
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const stream = oauthAccount
        ? await this.makeCliProxyStream(account, request, id, created, (u) => { usageHolder.value = u; })
        : useConsole
          ? await this.makeConsoleStream(account, tokens!, request, id, created)
          : await this.makeWebStream(account, tokens!, request, id, created);

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

      // Token accounting: prefer the upstream-reported usage (OAuth/Responses
      // surface returns a real usage object). Fall back to a conservative
      // estimate only when the upstream reports nothing (SSO web surface).
      const promptTokens = usageHolder.value?.prompt_tokens
        ?? estimatePromptTokens(request);
      const completionTokens = usageHolder.value?.completion_tokens
        ?? Math.ceil(text.length / 4);

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
      const oauthAccount = isOAuthAccount(account);
      const tokens = oauthAccount ? null : this.getTokens(account);
      if (!oauthAccount && !tokens) throw new Error("expired: no tokens");

      const id = `chatcmpl-grok-${Date.now()}`;
      const created = now();
      const model = request.model;
      const useConsole = this.isConsoleModel(model);

      const stream = oauthAccount
        ? await this.makeCliProxyStream(account, request, id, created)
        : useConsole
          ? await this.makeConsoleStream(account, tokens!, request, id, created)
          : await this.makeWebStream(account, tokens!, request, id, created);

      if (!stream) {
        return { success: false, error: "Failed to create upstream stream" };
      }

      return { success: true, stream };
    } catch (err: any) {
      return this.classifyError(err);
    }
  }

  // -------------------------------------------------------------------------
  // cli-chat-proxy.grok.com chat/completions → ReadableStream<Uint8Array> (SSE)
  // OAuth surface used by the official Grok CLI. OpenAI-compatible SSE.
  // -------------------------------------------------------------------------

  /**
   * Stream a chat completion from the cli-chat-proxy chat/completions endpoint.
   * Auth: OAuth access token (auto-refreshed before expiry).
   *
   * Verified against the official Grok CLI v0.2.93 (binary strings + debug log
   * + live endpoint testing):
   *   - Endpoint: POST /v1/chat/completions (OpenAI-compatible; returns SSE
   *     in standard chat.completion.chunk format WITH usage).
   *   - Required header: x-grok-client-version (version gate; without it the
   *     proxy returns 426 "version (none) is outdated"). Resolved dynamically.
   *   - Model routing: x-grok-model-override header.
   *   - Model: "grok-4.5" (free tier works, returns model "grok-4.5-build-free").
   *     The "grok-build" alias 402s on free accounts (spending-limit).
   *   - Usage: real token accounting from the final chunk's `usage` field —
   *     prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
   *     cost_in_usd_ticks (0 on free tier).
   *
   * Verified live: cli-chat-proxy /chat/completions accepts the OAuth bearer
   * + x-grok-client-version header and returns OpenAI-format SSE WITH usage
   * (prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
   * cost_in_usd_ticks). Model must be "grok-4.5" (free tier works); the
   * "grok-build" alias 402s on free accounts.
   *
   * @param onUsage optional callback receiving the upstream usage object when
   *                the stream completes (used for real token/credit accounting).
   */
  private async makeCliProxyStream(
    account: Account,
    request: ChatCompletionRequest,
    id: string,
    created: number,
    onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void
  ): Promise<ReadableStream<Uint8Array> | null> {
    const bearer = await ensureFreshAccessToken(account, async (fresh) => {
      // Persist the refreshed token bundle back to the account row.
      account.tokens = fresh as unknown as Account["tokens"];
      try {
        const { db } = await import("../../../db/index");
        const { accounts } = await import("../../../db/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(accounts).set({ tokens: fresh as unknown as Account["tokens"] }).where(eq(accounts.id, account.id));
      } catch { /* best-effort persist; in-memory token still refreshed */ }
    });
    if (!bearer) throw new Error("expired: OAuth access token could not be refreshed");


    // Resolve the CLI version dynamically (rot-proof against CLI updates).
    const cliVersion = await getGrokCliVersion();

    // Map the etteum model slug to the upstream model id. "grok-4.5" works on
    // the free tier; the "grok-build" alias 402s on free accounts. The CLI's
    // own debug log confirmed: grok-build → 402, grok-4.5 → 200.
    const upstreamModel = request.model.startsWith("grok-4.5")
      ? "grok-4.5"
      : request.model;

    const body: Record<string, unknown> = {
      model: upstreamModel,
      messages: request.messages,
      stream: true,
    };
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.max_tokens != null) body.max_tokens = request.max_tokens;
    if (request.top_p != null) body.top_p = request.top_p;
    if (request.frequency_penalty != null) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty != null) body.presence_penalty = request.presence_penalty;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;

    const upstream = await fetch(`${GROK_OAUTH.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${bearer}`,
        "Accept": "text/event-stream",
        // Required version gate — resolved dynamically so it never rots.
        "x-grok-client-version": cliVersion,
        "x-grok-client-surface": "grok-shell",
        // Route to the requested model's cluster.
        "x-grok-model-override": upstreamModel,
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      throw new Error(`cli-chat-proxy error ${upstream.status}: ${text.slice(0, 200)}`);
    }

    const reader = upstream.body.getReader();
    const encoder = new TextEncoder();
    let buffer = "";

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value, { stream: true });

            // Process complete SSE events (separated by blank lines).
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const rawEvent = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              const payload = dataLine.slice(6).trim();
              if (payload === "[DONE]") continue;

              try {
                const chunk = JSON.parse(payload);

                // Capture upstream usage when present (final chunk or a
                // usage-only chunk). Real token accounting:
                //   prompt_tokens / completion_tokens / total_tokens
                //   + reasoning_tokens + cached_tokens + cost_in_usd_ticks
                const usage = chunk.usage;
                if (usage && typeof usage.prompt_tokens === "number") {
                  onUsage?.({
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens ?? 0,
                  });
                }

                // Pass the OpenAI-format chunk straight through (re-tagged
                // with our id/created/model for consistency).
                const out = {
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: request.model,
                  choices: chunk.choices ?? [],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
              } catch {
                /* skip malformed chunk */
              }
            }
          }
        } catch (err) {
          controller.error(err);
          return;
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
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
    // xAI "permission-denied" on chat is NOT an expired token — the access JWT
    // is valid (models/billing often still 200) but this principal/team has no
    // chat entitlement. Do not prefix with "expired:" or the router will
    // uselessly burn the refresh token trying to "fix" it.
    if (/permission-denied|chat endpoint is denied/i.test(msg)) {
      return {
        success: false,
        error: `forbidden: ${msg}`,
        banned: true,
      };
    }
    if (/expired|unauthorized|\b401\b/i.test(msg)) {
      return { success: false, error: `expired: ${msg}` };
    }
    if (/\b403\b/i.test(msg)) {
      return { success: false, error: `forbidden: ${msg}`, banned: true };
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
    // OAuth path — exchange refresh token for a fresh access token.
    if (isOAuthAccount(account)) {
      const oauthTokens = getOAuthTokens(account);
      if (!oauthTokens?.refresh_token) {
        return { success: false, error: "No refresh token to renew OAuth access" };
      }
      try {
        const fresh = await exchangeRefreshToken(oauthTokens.refresh_token);
        const tokensStr = JSON.stringify(fresh);
        return { success: true, tokens: tokensStr };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // SSO path — cookies don't have a refresh-token flow. Validate as-is.
    const tokens = this.getTokens(account);
    if (!tokens?.sso) {
      return { success: false, error: "No SSO cookie to refresh" };
    }
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
    quota?: { limit: number; remaining: number; used: number; resetAt: Date | null; source: string };
    error?: string;
  }> {
    // OAuth path — real billing from cli-chat-proxy /v1/billing (paid monthly
    // pool) and/or grok.com GetGrokCreditsConfig (shared weekly pool %).
    // Never invent a fake 100/100 placeholder.
    if (isOAuthAccount(account)) {
      const bearer = await ensureFreshAccessToken(account);
      if (!bearer) {
        return { success: false, error: "expired: OAuth access token needs refresh" };
      }
      try {
        const quota = await fetchOAuthBillingQuota(bearer, signal);
        if (quota) {
          return {
            success: true,
            quota: {
              limit: quota.limit,
              remaining: quota.remaining,
              used: quota.used,
              resetAt: quota.resetAt,
              source: quota.source,
            },
          };
        }
        return { success: false, error: "billing endpoints returned no usable quota" };
      } catch (err: any) {
        if (err?.name === "AbortError") return { success: false, error: "aborted" };
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    // SSO path — grok.com rate-limits endpoint.
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
        quota: { limit, remaining, used, resetAt, source: "grok.com-rate-limits" },
      };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { success: false, error: "aborted" };
      }
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Check if an account's tokens are still valid. Returns true if alive.
   *
   * - OAuth accounts: validated via GET /v1/models on cli-chat-proxy (no token
   *   cost), with proactive refresh if the access token is near expiry.
   * - SSO accounts: validated via the grok.com rate-limits endpoint.
   */
  /**
   * Override healthCheck so the BASE class's direct-refresh path (base.ts:195,
   * which calls this.refreshToken WITHOUT the coordinator lock and WITHOUT
   * persisting) can NEVER run for grok OAuth accounts. The base path would
   * brick rotating refresh tokens. We validate + fetch quota ourselves,
   * routing any needed refresh through validateOAuthToken → ensureFreshAccessToken
   * (which never rotates; it returns false and lets the scheduler/router handle it).
   */
  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    // OAuth path — safe validation (no rotation, free /v1/models probe).
    if (isOAuthAccount(account)) {
      const { alive } = await validateOAuthToken(account);
      if (!alive) {
        return { kind: "missing_tokens", success: false, error: "OAuth access token invalid or refresh failed" };
      }
      // Prefer absolute free Build credits already stored by farm/import.
      const oauth = getOAuthTokens(account);
      if (
        oauth?.credits_limit != null &&
        oauth.credits_limit > 0 &&
        oauth.credits_remaining != null
      ) {
        return {
          kind: "healthy",
          success: true,
          quota: {
            limit: Math.floor(oauth.credits_limit),
            remaining: Math.floor(oauth.credits_remaining),
            used: Math.max(0, Math.floor(oauth.credits_limit - oauth.credits_remaining)),
            resetAt: null,
            source: "stored-farm-credits",
          },
        };
      }
      // Live quota: billing / GetGrokCreditsConfig / rate-limit headers (farm-compatible).
      const quota = await this.fetchQuota(account, signal);
      return {
        kind: "healthy",
        success: true,
        quota: quota.success ? quota.quota : undefined,
      };
    }

    // SSO path — delegate to the base implementation.
    return super.healthCheck(account, signal);
  }

  async validateAccount(account: Account): Promise<boolean> {
    // OAuth path — refresh proactively, then probe /v1/models (free).
    if (isOAuthAccount(account)) {
      const { alive } = await validateOAuthToken(account, async (fresh) => {
        account.tokens = fresh as unknown as Account["tokens"];
        try {
          const { db } = await import("../../../db/index");
          const { accounts } = await import("../../../db/schema");
          const { eq } = await import("drizzle-orm");
          await db.update(accounts).set({ tokens: fresh as unknown as Account["tokens"] }).where(eq(accounts.id, account.id));
        } catch { /* best-effort */ }
      });
      return alive;
    }

    // SSO path.
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