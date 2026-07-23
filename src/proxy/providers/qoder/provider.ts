/** qoder provider class. */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyModelSpecs } from "../../model-specs";
import { getUpstreamNameOverride } from "../custom-models";
import {
  ACTIVITY_URL,
  APPCODE,
  BUSINESS_PRODUCT,
  BUSINESS_TYPE,
  BUSINESS_VERSION,
  C2S,
  CHAT_URL,
  CHAT_URL_FALLBACK,
  COSY_SCENE,
  COSY_VERSION,
  CUSTOM_ALPHABET,
  CUSTOM_PAD,
  JOB_TOKEN_URL,
  MODEL_CONFIGS,
  QODER_MODELS,
  QOTA_USAGE_URL,
  S2C,
  SERVER_PUBKEY_PEM,
  SIG_SECRET,
  STD_ALPHABET,
  USER_STATUS_URL,
  aesEncryptCbc,
  bearerFetch,
  buildChatBody,
  buildIdentity,
  buildPayloadB64,
  buildQoderMessages,
  buildSessionContext,
  deriveSessionId,
  encodeQoderPayload,
  exchangeJobToken,
  extractLatestUserImages,
  extractLatestUserPrompt,
  generateMachineIdentity,
  generateOpenAIToolId,
  hasQoderCredentials,
  loadTemplate,
  md5Hex,
  normalizeImageBlock,
  normalizeQoderTokens,
  normalizeToolCallId,
  openApiHeaders,
  parseSseLine,
  pathSigFromUrl,
  rfc1123Date,
  rsaEncryptKey,
  signBearerRequest,
  signSignatureHeader,
  signatureHeaders,
} from "./helpers";
import type {
  ActivityResponse,
  AuthIdentity,
  BearerCallOptions,
  JobTokenResponse,
  ParsedDelta,
  QoderActivity,
  QoderActivitySnapshot,
  QoderModelDef,
  QoderTokens,
  SessionContext,
  ToolCallAcc,
} from "./helpers";

export class QoderProvider extends BaseProvider {
  name = "qoder";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("qd-");
  }

  // Derive the canonical model name from the qoder id (qd-Qwen3.7-Max ->
  // qwen3.7-max) so specs resolve from the central registry (a model's
  // context/max_output is a property of the model, not the provider).
  private static toCanonical(id: string): string {
    return id.replace(/^qd-/i, "").toLowerCase();
  }

  supportedModels: ModelInfo[] = applyModelSpecs(QODER_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "qoder",
    context_window: m.max_input_tokens,
    // Default max_output; applyModelSpecs overrides from canonical registry
    // (kimi-k3 → 1M combined window / large max_output).
    max_output: m.id === "qd-Kimi-K3" ? 131072 : 64000,
    thinking: m.is_reasoning,
    vision: m.is_vl,
    creditUnit: "credit" as const,
    creditRate: (0.004 * Math.max(0.001, m.price_factor)) / 1000,
    creditSource: "estimated" as const,
  })), (m) => QoderProvider.toCanonical(m.id));

  private parseTokens(account: Account): QoderTokens | null {
    if (!account.tokens) return null;
    try {
      const raw = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return normalizeQoderTokens(raw);
    } catch {
      return null;
    }
  }

  private async ensureFreshAuth(tokens: QoderTokens): Promise<{ tokens: QoderTokens; refreshed: boolean }> {
    const now = Date.now();
    const hasSession = Boolean(tokens.securityOauthToken);
    const sessionExpired =
      typeof tokens.expireTime === "number" &&
      Number.isFinite(tokens.expireTime) &&
      tokens.expireTime - 60_000 < now;

    // Device-session accounts: securityOauthToken IS the device poll token.
    // Never call jobToken with it (401 personal token is invalid).
    if (!tokens.personalToken) {
      if (!hasSession) {
        throw new Error(
          "Qoder device session missing securityOauthToken — re-login via browser or import a console PAT",
        );
      }
      if (sessionExpired) {
        throw new Error(
          "Qoder device session expired — re-login via browser (device tokens are not refreshable via jobToken)",
        );
      }
      return { tokens, refreshed: false };
    }

    // PAT path: mint/refresh securityOauthToken via jobToken.
    const needsRefresh = !hasSession || !tokens.userId || sessionExpired;
    if (!needsRefresh) return { tokens, refreshed: false };

    const jt = await exchangeJobToken(tokens);
    if (!jt.id) {
      throw new Error("jobToken response missing user id");
    }

    const updated: QoderTokens = {
      ...tokens,
      authMode: "pat",
      userId: jt.id,
      userName: jt.name || tokens.userName || "",
      securityOauthToken: jt.securityOauthToken || tokens.securityOauthToken || "",
      refreshToken: jt.refreshToken || tokens.refreshToken || "",
      userType: jt.userType || tokens.userType || "personal_standard",
      plan: jt.plan || tokens.plan,
      expireTime: jt.expireTime || tokens.expireTime,
      email: jt.email || tokens.email,
    };
    return { tokens: updated, refreshed: true };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const result = await this.chatCompletionStream(account, request);
    if (!result.success || !result.stream) return result;

    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    const toolCalls: ToolCallAcc[] = [];
    let finishReason: string | null = null;
    let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    try {
      // Buffer raw bytes across reads: a single SSE `data:` line can be split
      // across TCP segments, so splitting per-read would feed a partial JSON
      // string to JSON.parse (silently dropped by the catch) and lose tokens.
      let sseBuffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        // Process complete lines (terminated by \n). The trailing partial line
        // stays in the buffer for the next read.
        let nlIdx: number;
        while ((nlIdx = sseBuffer.indexOf("\n")) >= 0) {
          const line = sseBuffer.slice(0, nlIdx);
          sseBuffer = sseBuffer.slice(nlIdx + 1);
          if (!line.startsWith("data: ")) continue;
          if (line === "data: [DONE]") continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            // Extract usage from final chunk (has empty choices array)
            if (chunk.usage && chunk.usage.total_tokens > 0) {
              finalUsage = {
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
              };
            }
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) fullContent += delta.content;
            else if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
              fullContent += delta.reasoning_content;
            } else if (typeof delta?.reasoning === "string" && delta.reasoning) {
              fullContent += delta.reasoning;
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? toolCalls.length;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { index: idx, id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
            if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Fall back to estimation if upstream didn't report usage
    if (finalUsage.total_tokens === 0) {
      const estimated = this.estimateMessagesTokens(request.messages);
      finalUsage = { prompt_tokens: estimated, completion_tokens: this.estimateTokens(fullContent), total_tokens: estimated + this.estimateTokens(fullContent) };
    }

    const filledToolCalls = toolCalls.filter((t) => t && t.id);
    const response: ChatCompletionResponse = {
      id: this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: fullContent || "",
          ...(filledToolCalls.length > 0 ? { tool_calls: filledToolCalls } : {}),
        },
        finish_reason: finishReason || (filledToolCalls.length > 0 ? "tool_calls" : "stop"),
      }],
      usage: finalUsage,
    };

    return {
      ...result,
      success: true,
      response,
      stream: undefined,
      tokensUsed: finalUsage.total_tokens,
      promptTokens: finalUsage.prompt_tokens,
      completionTokens: finalUsage.completion_tokens,
    };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const parsed = this.parseTokens(account);
    if (!hasQoderCredentials(parsed)) {
      return { success: false, error: "No Qoder credentials (need console PAT or device session)" };
    }

    let tokens: QoderTokens;
    let refreshed = false;
    try {
      const auth = await this.ensureFreshAuth(parsed!);
      tokens = auth.tokens;
      refreshed = auth.refreshed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `expired: ${msg}` };
    }
    if (!tokens.securityOauthToken) {
      return { success: false, error: "No securityOauthToken after auth" };
    }

    const body = buildChatBody(request, tokens);
    let resp: Response;
    try {
      const cfg = MODEL_CONFIGS[request.model] || QODER_MODELS[0]!;
      // Honor the override for the x-model-key header too.
      const upstreamOverride = getUpstreamNameOverride(request.model);
      const modelKey = upstreamOverride || cfg.upstream;
      const modelSource = body?.model_config?.source || "system";
      const extraHeaders = {
        "x-model-key": modelKey,
        "x-model-source": modelSource,
      };
      // Prefer api2 (working bridges). Fall back to api3 once on transport/5xx.
      resp = await bearerFetch(tokens, {
        url: CHAT_URL,
        body,
        stream: true,
        extraHeaders,
      });
      if (!resp.ok && resp.status >= 500) {
        resp = await bearerFetch(tokens, {
          url: CHAT_URL_FALLBACK,
          body,
          stream: true,
          extraHeaders,
        });
      }
    } catch (e) {
      // Network failure on api2 — try api3 once.
      try {
        const cfg = MODEL_CONFIGS[request.model] || QODER_MODELS[0]!;
        const upstreamOverride = getUpstreamNameOverride(request.model);
        const modelKey = upstreamOverride || cfg.upstream;
        resp = await bearerFetch(tokens, {
          url: CHAT_URL_FALLBACK,
          body,
          stream: true,
          extraHeaders: {
            "x-model-key": modelKey,
            "x-model-source": body?.model_config?.source || "system",
          },
        });
      } catch (e2) {
        return { success: false, error: e2 instanceof Error ? e2.message : String(e2) };
      }
    }

    if (resp.status === 401) {
      return { success: false, error: `expired: HTTP 401` };
    }
    if (resp.status === 403) {
      // Cosy returns 403 for many non-quota reasons (signature, path, free-bucket
      // miss, rate-limit-per-second). Do NOT set quotaExhausted here — that parks
      // the whole account (including qd-Lite). Let the pool/warmup decide.
      const text = await resp.text().catch(() => "");
      return {
        success: false,
        error: `Qoder chat HTTP 403: ${text.slice(0, 200) || "forbidden"}`,
        rateLimited: /rate|limit|too many|throttle/i.test(text),
      };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: `Qoder chat HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    if (!resp.body) {
      return { success: false, error: "Qoder response missing body" };
    }

    const upstream = resp.body;
    const id = this.generateId();
    const model = request.model;
    const encoder = new TextEncoder();

    // Track usage across the stream — will be emitted in final chunk
    let accumulatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sentRole = false;
        let finishEmitted = false;
        const toolIndex = new Map<string, number>();
        let nextToolIdx = 0;
        const pendingToolCalls = new Map<number, { id: string; function: { name: string; arguments: string } }>();
        let lastActivity = Date.now();
        const STREAM_TIMEOUT = 300000; // 5 minutes
        let streamActive = true;

        const enqueue = (delta: any, finishReason: string | null = null, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => {
          if (!streamActive) {
            return; // Skip enqueue if stream is already closed
          }
          try {
            const chunk: any = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            };
            // Include usage in the finish chunk per OpenAI spec
            if (usage) {
              chunk.usage = usage;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch (e) {
            // Controller closed or error - mark stream as inactive
            streamActive = false;
            console.log(`[Qoder] Stream enqueue failed (client likely disconnected): ${e instanceof Error ? e.message : String(e)}`);
          }
        };

        try {
          while (streamActive) {
            // Check timeout
            if (Date.now() - lastActivity > STREAM_TIMEOUT) {
              console.error(`[Qoder] Stream timeout after ${STREAM_TIMEOUT}ms`);
              break;
            }

            // Use Promise.race for timeout on read. IMPORTANT: clear the timer
            // when readPromise wins (the normal case) — otherwise each loop
            // iteration leaks a dangling setTimeout that holds its reject fn
            // alive for STREAM_TIMEOUT ms. On long streams this accumulated
            // thousands of timers (memory leak → OOM).
            const readPromise = reader.read();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Stream read timeout")), STREAM_TIMEOUT);
            });

            let result;
            try {
              result = await Promise.race([readPromise, timeoutPromise]);
            } catch (e) {
              if (timer) clearTimeout(timer);
              console.error(`[Qoder] Stream read error: ${e instanceof Error ? e.message : String(e)}`);
              break;
            }
            if (timer) clearTimeout(timer);

            if (result.done) break;
            lastActivity = Date.now();

            buffer += decoder.decode(result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const raw of lines) {
              const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
              if (!line) continue;

              // Detect Qoder error responses in SSE body (HTTP 200 but error in JSON).
              // Only treat as fatal when the payload clearly indicates quota/auth death.
              // Path/signature/rate-limit 403s must NOT park the account as exhausted.
              if (line.startsWith("data:")) {
                const dataStr = line.slice(5).trim();
                if (dataStr && dataStr !== "[DONE]") {
                  try {
                    const wrapper = JSON.parse(dataStr);
                    const svc = Number(wrapper.statusCodeValue || wrapper.status || 0);
                    if (svc && svc >= 400) {
                      const errStatus = String(wrapper.statusCode || wrapper.code || "");
                      let errMsg = wrapper.message || "";
                      if (typeof errMsg === "string" && errMsg.startsWith("{")) {
                        try { const p = JSON.parse(errMsg); errMsg = p.pricingUrl || JSON.stringify(p); } catch {}
                      }
                      const fullErr = `Qoder HTTP ${svc} ${errStatus}: ${errMsg.slice(0, 200) || "upstream error"}`;
                      console.error(`[Qoder] ${fullErr}`);
                      const quotaish = /quota|credit|exceed|NoQuota|usage.?exhaust|subscription|pricing/i.test(
                        `${errStatus} ${errMsg}`,
                      );
                      try {
                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify({
                              type: "upstream_error",
                              error: fullErr,
                              quotaExhausted: quotaish,
                            })}\n\n`,
                          ),
                        );
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                      } catch {}
                      streamActive = false;
                      finishEmitted = true;
                      break;
                    }
                  } catch {}
                }
              }

              const parsedDelta = parseSseLine(line);
              if (!parsedDelta) continue;

              // Track usage from upstream (usually in final chunk)
              if (parsedDelta.usage) {
                accumulatedUsage = parsedDelta.usage;
              }

              // Build delta object, combining role with first content (OpenAI spec)
              const delta: any = {};

              if (!sentRole) {
                // Include role in the first chunk that has any content
                if (parsedDelta.reasoningContent || parsedDelta.content || parsedDelta.toolCalls) {
                  delta.role = "assistant";
                  sentRole = true;
                }
              }

              if (parsedDelta.reasoningContent) {
                delta.reasoning_content = parsedDelta.reasoningContent;
              }

              if (parsedDelta.content) {
                delta.content = parsedDelta.content;
              } else if (parsedDelta.reasoningContent) {
                // Thinking models (Kimi K3) often stream only reasoning_* first.
                // Promote into content so Chat UIs that ignore reasoning_content
                // don't show a blank reply.
                delta.content = parsedDelta.reasoningContent;
              }

              if (parsedDelta.toolCalls) {
                const remapped: any[] = [];
                for (const tc of parsedDelta.toolCalls) {
                  const key = typeof tc.index === "number" ? `idx-${tc.index}` : (tc.id || `tool-${nextToolIdx}`);
                  let idx = toolIndex.get(key);
                  if (idx === undefined) {
                    idx = nextToolIdx++;
                    toolIndex.set(key, idx);
                    pendingToolCalls.set(idx, { id: "", function: { name: "", arguments: "" } });
                    // Generate stable ID once per tool call (not per chunk)
                    const stableId = normalizeToolCallId(tc.id, idx);
                    pendingToolCalls.get(idx)!.id = stableId;
                  }
                  // Use stable ID from pendingToolCalls (consistent across chunks)
                  const stableId = pendingToolCalls.get(idx)!.id;
                  if (tc.function?.name) pendingToolCalls.get(idx)!.function.name = tc.function.name;
                  if (tc.function?.arguments) pendingToolCalls.get(idx)!.function.arguments += tc.function.arguments;
                  remapped.push({
                    index: idx,
                    id: stableId,
                    ...(tc.type ? { type: tc.type } : { type: "function" }),
                    ...(tc.function ? { function: tc.function } : {}),
                  });
                }
                delta.tool_calls = remapped;
              }

              // Only enqueue if delta has content (not empty)
              if (Object.keys(delta).length > 0) {
                enqueue(delta);
              }

              if (parsedDelta.finishReason) {
                // Include usage in the finish chunk (OpenAI spec)
                enqueue({}, parsedDelta.finishReason, accumulatedUsage.total_tokens > 0 ? accumulatedUsage : undefined);
                finishEmitted = true;
              }
            }
          }

          if (!finishEmitted && streamActive) {
            // Include usage in the final stop chunk per OpenAI spec
            enqueue({}, "stop", accumulatedUsage.total_tokens > 0 ? accumulatedUsage : undefined);
          }

          if (streamActive) {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (e) {
              streamActive = false;
            }
          }
        } catch (error) {
          streamActive = false;
          const msg = error instanceof Error ? error.message : String(error);
          // Don't log client disconnects as errors
          if (msg.includes("cancelled") || msg.includes("aborted") || msg.includes("closed")) {
            console.log(`[Qoder] Stream ${msg}`);
          } else {
            console.error(`[Qoder] Stream error: ${msg}`);
          }
          // Try to send error to client (if stream still open)
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: "api_error" } })}\n\n`));
          } catch {
            // Controller already closed, ignore
          }
        } finally {
          streamActive = false;
          try { controller.close(); } catch {}
          try { reader.releaseLock(); } catch {}
        }
      },
    });

    return {
      success: true,
      stream,
      tokensUsed: accumulatedUsage.total_tokens,
      promptTokens: accumulatedUsage.prompt_tokens,
      completionTokens: accumulatedUsage.completion_tokens,
      ...(refreshed ? { tokens: JSON.stringify(tokens) } : {}),
    };
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const parsed = this.parseTokens(account);
    if (!hasQoderCredentials(parsed)) {
      return { success: false, error: "No Qoder credentials" };
    }
    // Device sessions cannot be refreshed via jobToken — only PAT can.
    if (!parsed!.personalToken) {
      return {
        success: false,
        error: "Device-session accounts cannot refresh via jobToken — re-login via browser or import a PAT",
      };
    }
    try {
      const { tokens } = await this.ensureFreshAuth({
        ...parsed!,
        securityOauthToken: "",
        userId: "",
      });
      return { success: true, tokens: JSON.stringify(tokens) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    return hasQoderCredentials(this.parseTokens(account));
  }

  /**
   * Whether a given Qoder model id is covered by a Free-promo bucket on
   * `/activity`. Currently only `qmodel_latest` (Qwen3.7-Max) has a promo;
   * other models hit the account-wide credit pool from `/quota/usage`.
   *
   * Used by the proxy to route per-request decrement to the correct counter.
   */
  isFreeModel(modelId: string): boolean {
    const def = MODEL_CONFIGS[modelId];
    return def?.upstream === "qmodel_latest";
  }

  /**
   * Verify whether a Qoder account is *actually* quota-exhausted by probing the
   * cheapest model (`qd-Lite`, price_factor=0). Live request 403s are noisy:
   * rate limits, signature replay, transient auth issues all surface as 403.
   * Use this before flipping status to `exhausted` so we don't poison accounts
   * that can still serve requests.
   *
   * Returns:
   *   - true  → probe definitively says quota is exhausted (mark exhausted)
   *   - false → probe succeeded or failed transiently (don't mark, retry later)
   */
  async probeQuotaExhausted(account: Account): Promise<boolean> {
    try {
      const probe = await this.chatCompletion(account, {
        model: "qd-Lite",
        messages: [{ role: "user", content: "OK" }],
        max_tokens: 4,
      });
      // Probe succeeded → account is alive. Don't poison.
      if (probe.success) return false;
      // Probe explicitly says quota exhausted → trust it.
      if (probe.quotaExhausted) return true;
      // Anything else (transient, network, auth) — treat as inconclusive.
      return false;
    } catch {
      // Throwing means we can't verify — be conservative, don't mark.
      return false;
    }
  }

  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const parsed = this.parseTokens(account);
    if (!hasQoderCredentials(parsed)) return { success: false, error: "No Qoder credentials" };

    try {
      const { tokens } = await this.ensureFreshAuth(parsed!);
      if (!tokens.securityOauthToken) {
        return { success: false, error: "No securityOauthToken after auth" };
      }

      const resp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(tokens.securityOauthToken),
        signal,
      });

      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: `Qoder quota rejected (${resp.status})` };
      }
      if (!resp.ok) {
        return { success: false, error: `Qoder quota HTTP ${resp.status}` };
      }

      const data = (await resp.json()) as {
        userQuota?: { total?: number; used?: number; remaining?: number };
        expiresAt?: number;
        isQuotaExceeded?: boolean;
      };

      const limit = Number(data.userQuota?.total) || 0;
      const used = Number(data.userQuota?.used) || 0;
      const remaining = Number(data.userQuota?.remaining ?? Math.max(0, limit - used));
      const resetAt = data.expiresAt ? new Date(data.expiresAt) : null;

      return { success: true, quota: { limit, remaining, used, resetAt } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Fetch per-model promo quotas (e.g. Qwen3.7-Max 200/day) from
   * `/algo/api/v2/activity`. COSY-signed GET — same auth as chat calls.
   *
   * Best-effort: callers should treat failures as non-fatal and fall back to
   * the account-wide `quota/usage` data.
   */
  private async fetchActivityQuota(tokens: QoderTokens): Promise<QoderActivitySnapshot> {
    const resp = await bearerFetch(tokens, { url: ACTIVITY_URL, method: "GET" });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`activity HTTP ${resp.status}: ${text.slice(0, 120)}`);
    }
    const data = (await resp.json()) as ActivityResponse;
    if (data.code !== 0) {
      throw new Error(`activity code=${data.code} msg=${data.msg ?? "unknown"}`);
    }
    return {
      activities: Array.isArray(data.data?.activities) ? data.data!.activities! : [],
      queryAt: Number(data.data?.queryAt ?? Date.now()),
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetch /api/v3/user/status (COSY-signed) for the authoritative account
   * whitelist state. The quota/usage endpoint reports credit balance + a
   * coarse isQuotaExceeded flag, but NOT the whitelist reasons an account can
   * be unusable while still holding credits: NoLicense, AppDisable,
   * LoginExpire, NoIpPermission, etc. This catches those.
   *
   * Best-effort: returns null on any failure so healthCheck degrades to the
   * quota/usage path. Mirrors the qoder2api / qodercli status check.
   */
  private async fetchUserStatus(tokens: QoderTokens): Promise<{
    whitelistStatus?: string;
    userType?: string;
    nickname?: string;
  } | null> {
    try {
      const resp = await bearerFetch(tokens, { url: USER_STATUS_URL, method: "GET" });
      if (!resp.ok) return null;
      const data: any = await resp.json().catch(() => null);
      // Response shape: { code, data: { whitelistStatus, userType, nickname } }
      // or flat { whitelistStatus, ... }. Be defensive.
      const inner = (data && (data.data || data)) || {};
      return {
        whitelistStatus: typeof inner.whitelistStatus === "string" ? inner.whitelistStatus : undefined,
        userType: typeof inner.userType === "string" ? inner.userType : undefined,
        nickname: typeof inner.nickname === "string" ? inner.nickname : undefined,
      };
    } catch {
      return null;
    }
  }

  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const parsed = this.parseTokens(account);
    if (!hasQoderCredentials(parsed)) {
      return {
        kind: "missing_tokens",
        success: false,
        error: "No Qoder credentials (need console PAT or device session)",
      };
    }

    let tokens: QoderTokens;
    let refreshed = false;
    try {
      const auth = await this.ensureFreshAuth(parsed!);
      tokens = auth.tokens;
      refreshed = auth.refreshed;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Device session expired / missing → needs human re-login, not a transient retry.
      if (/device session|re-login/i.test(msg)) {
        return { kind: "session_expired", success: false, error: msg };
      }
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: msg,
      };
    }
    if (!tokens.securityOauthToken) {
      return { kind: "session_expired", success: false, error: "No securityOauthToken after auth" };
    }

    // ---- Account-wide credit (the "All" bar) ----
    let result: ProviderHealthResult;
    try {
      const resp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(tokens.securityOauthToken),
        signal,
      });

      if (resp.status === 401 || resp.status === 403) {
        return { kind: "session_expired", success: false, error: `Qoder rejected (${resp.status})` };
      }
      if (!resp.ok) {
        return { kind: "transient_error", success: false, retryable: true, error: `Qoder HTTP ${resp.status}` };
      }

      const data = (await resp.json()) as {
        userType?: string;            // e.g. "personal_standard" (= Community/free)
        usageType?: string;           // "credits"
        totalUsagePercentage?: number;
        userQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string };
        expiresAt?: number;
        isQuotaExceeded?: boolean;
      };

      const limit = Number(data.userQuota?.total) || 0;
      const used = Number(data.userQuota?.used) || 0;
      const remaining = Number(data.userQuota?.remaining ?? Math.max(0, limit - used));
      const resetAt = data.expiresAt ? new Date(data.expiresAt) : undefined;

      // ---- Authoritative whitelist state (catches exhaustion quota/usage misses) ----
      // quota/usage reports credit balance + isQuotaExceeded, but NOT the
      // whitelist reasons an account is unusable: NoLicense, AppDisable,
      // LoginExpire, NoIpPermission, NoQuota, EXPIRED. These mean the account
      // is dead even if it nominally holds credits.
      const userStatus = await this.fetchUserStatus(tokens);
      const whitelistStatus = userStatus?.whitelistStatus;
      // PASS / undefined = healthy; anything else = the account is blocked.
      const WHITELIST_EXHAUSTED = new Set([
        "NoQuota", "EXPIRED", "NoLicense", "AppDisable", "LoginExpire", "NoIpPermission",
      ]);
      const whitelistBlocked = !!whitelistStatus && whitelistStatus !== "PASS" && WHITELIST_EXHAUSTED.has(whitelistStatus);

      // Paid-credit exhaustion: the account has no spendable credits for paid
      // models. isQuotaExceeded=true on a zero-balance (Community) account means
      // exactly this. BUT it does NOT mean the account is useless — qd-Lite
      // (upstream "lite", price_factor 0) is always-free and works on
      // zero-credit accounts (verified live). So we keep the account healthy
      // (it can serve free models + any /activity promo buckets) and only flag
      // paidCreditsExhausted so the pool/dashboard know paid models won't work.
      const paidCreditsExhausted = data.isQuotaExceeded === true || remaining < 0 || (remaining <= 0 && limit > 0);

      // The account is only truly exhausted (benched from the pool entirely)
      // when it's administratively blocked, OR paid credits are exhausted AND
      // it has no free-model capacity. qd-Lite is always free, so a valid-auth
      // account always has at least free-model capacity — only whitelist
      // blocking fully benches it.
      const exceeded = whitelistBlocked;
      const quota = { limit, remaining, used, resetAt, source: "qoder.openapi" };

      result = {
        kind: exceeded ? "exhausted" : "healthy",
        success: true,
        quota,
        metadata: {
          plan: data.userType || userStatus?.userType || "",
          usageType: data.usageType || "",
          totalUsagePercentage: Number(data.totalUsagePercentage ?? 0),
          isQuotaExceeded: data.isQuotaExceeded === true,
          paidCreditsExhausted,
          freeModelAvailable: true, // qd-Lite is always free; verified live
          whitelistStatus: whitelistStatus ?? null,
          whitelistBlocked,
          ...(userStatus?.nickname ? { nickname: userStatus.nickname } : {}),
        },
        ...(refreshed ? { tokens } : {}),
      };
    } catch (error) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // ---- Per-model promo quota (the "Free" bar) — best-effort enrichment ----
    // We deliberately swallow errors here: a flaky activity endpoint must not
    // poison an otherwise-healthy account. Failures are recorded as a
    // breadcrumb in metadata for observability.
    try {
      const activity = await this.fetchActivityQuota(tokens);
      result.metadata = { ...(result.metadata || {}), activityQuota: activity };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.metadata = {
        ...(result.metadata || {}),
        activityQuotaError: msg.slice(0, 200),
      };
    }

    return result;
  }
}

// ============================================================================
// Public helpers (used by accounts API for add-account flow)
// ============================================================================

export async function activateQoderPat(personalToken: string): Promise<{ tokens: QoderTokens; jobToken: JobTokenResponse }> {
  const machine = generateMachineIdentity();
  const seed: QoderTokens = {
    personalToken,
    authMode: "pat",
    machineId: machine.machineId,
    machineToken: machine.machineToken,
    machineType: machine.machineType,
    machineCode: machine.machineCode,
    machineOs: machine.machineOs,
  };
  const jt = await exchangeJobToken(seed);
  if (!jt.id) throw new Error("Qoder jobToken response missing id");
  const tokens: QoderTokens = {
    ...seed,
    userId: jt.id,
    userName: jt.name || "",
    securityOauthToken: jt.securityOauthToken || "",
    refreshToken: jt.refreshToken || "",
    userType: jt.userType || "personal_standard",
    plan: jt.plan,
    expireTime: jt.expireTime,
    email: jt.email,
  };
  return { tokens, jobToken: jt };
}
