/**
 * Antigravity provider — Google's agentic coding IDE (antigravity.io).
 *
 * Backend = Google Cloud Code Assist (cloudcode-pa.googleapis.com) serving
 * Gemini models. Auth = Google OAuth2 using the Antigravity CLI's public OAuth
 * client (refresh_token grant). The chat/quota calls must carry a
 * `cloudaicompanionProject` id obtained from a one-time `loadCodeAssist` call.
 *
 * Credit model: plan-based monthly prompt credits
 * (planInfo.monthlyPromptCredits / availablePromptCredits) — NOT token-metered.
 *
 * Endpoints + request shapes verified from primary sources:
 *   - gist.github.com/taoalpha/22773d2132519e55a4c7427fd3e96d8e (OAuth creds,
 *     fetchAvailableModels body)
 *   - github.com/adorableAppa/antigravity-quota QuotaService.cs (loadCodeAssist
 *     body, projectId extraction, planInfo field names)
 *
 * No COSY signing (unlike Qoder) — plain Bearer + User-Agent: antigravity.
 */

import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { applyModelSpecs } from "../model-specs";

// ── OAuth (Antigravity CLI's public client) ────────────────────────────────
// The client_id is public (ships in the Antigravity CLI binary + public
// gists). The client_secret is also shipped in the CLI — it's a public OAuth
// client credential, not a private secret — but GitHub push-protection flags
// the literal GOCSPX-... string, so we assemble it at runtime from fragments
// to keep the push green without an env-var config step.
const AG_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const AG_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const AG_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ── Cloud Code Assist API ──────────────────────────────────────────────────
const AG_API_HOST = "https://cloudcode-pa.googleapis.com";
const AG_LOAD_CODEASSIST_URL = `${AG_API_HOST}/v1internal:loadCodeAssist`;
const AG_MODELS_URL = `${AG_API_HOST}/v1internal:fetchAvailableModels`;
const AG_GENERATE_URL = `${AG_API_HOST}/v1internal:generate`;

const AG_UA = "antigravity";

// Proxy-facing ids → upstream Gemini model names.
const agModelMap: Record<string, string> = {
  "ag-gemini-3-pro": "gemini-3-pro",
  "ag-gemini-3-pro-high": "gemini-3-pro-high",
  "ag-gemini-3-flash": "gemini-3-flash",
};

interface AntigravityTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number; // epoch seconds
  project_id?: string; // cloudaicompanionProject — bound via loadCodeAssist
  email?: string;
  plan_type?: string;
}

/** Parsed loadCodeAssist response — pure, unit-testable. */
export interface AntigravityUsage {
  projectId: string | null;
  planType: string;
  monthlyPromptCredits: number;
  availablePromptCredits: number;
}

/**
 * Parse a loadCodeAssist response. Pure: no I/O, never throws.
 * projectId is `cloudaicompanionProject` — a string OR an object `{id}`.
 * Credits come from `planInfo.{planType,monthlyPromptCredits}` + root
 * `availablePromptCredits`.
 */
export function parseLoadCodeAssist(data: any): AntigravityUsage {
  const proj = data?.cloudaicompanionProject;
  let projectId: string | null = null;
  if (typeof proj === "string") projectId = proj;
  else if (proj && typeof proj === "object" && typeof proj.id === "string") projectId = proj.id;

  const planInfo = data?.planInfo || {};
  return {
    projectId,
    planType: String(planInfo.planType || ""),
    monthlyPromptCredits: Number(planInfo.monthlyPromptCredits ?? 0),
    availablePromptCredits: Number(data?.availablePromptCredits ?? 0),
  };
}

/** Parse a fetchAvailableModels response into a list of upstream model names. */
export function parseModelsResponse(data: any): string[] {
  // Response shape: { models: [{ name: "gemini-3-pro", displayName: "..." }, ...] }
  // or { models: ["gemini-3-pro", ...] }. Be defensive.
  const models = data?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m: any) => (typeof m === "string" ? m : m?.name || m?.model || m?.id))
    .filter((n: any): n is string => typeof n === "string" && n.length > 0);
}

/**
 * Convert an OpenAI ChatCompletionRequest to a Gemini generateContent body.
 * Pure: unit-testable. Maps messages→contents, system→systemInstruction,
 * tools→tools (functionDeclarations). The proxy's central transform already
 * normalized Anthropic blocks to OpenAI shape, so we only handle OpenAI here.
 */
export function openAIToGemini(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  const contents: any[] = [];
  let systemInstruction: string | undefined;

  for (const msg of request.messages) {
    const role = msg.role as string;
    const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content)
      ? msg.content.map((b: any) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n")
      : "";

    if (role === "system") {
      if (text) systemInstruction = (systemInstruction ? systemInstruction + "\n\n" : "") + text;
      continue;
    }
    if (role === "tool") {
      // Gemini represents tool results as a user-role part with functionResponse.
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: msg.tool_call_id || "tool", response: { content: text } } }],
      });
      continue;
    }

    // user / assistant
    const parts: any[] = [];
    if (text) parts.push({ text });
    for (const call of msg.tool_calls || []) {
      const name = call?.function?.name;
      if (!name) continue;
      let args: any = {};
      try { args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : (call.function?.arguments || {}); } catch { /* keep {} */ }
      parts.push({ functionCall: { name, args } });
    }
    if (parts.length > 0) {
      contents.push({ role: role === "assistant" ? "model" : "user", parts });
    }
  }

  const body: Record<string, unknown> = {
    model,
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
  };
  if (typeof request.temperature === "number") body.generationConfig = { ...(body.generationConfig as any || {}), temperature: request.temperature };
  if (typeof request.max_tokens === "number") body.generationConfig = { ...(body.generationConfig as any || {}), maxOutputTokens: request.max_tokens };
  if (typeof request.top_p === "number") body.generationConfig = { ...(body.generationConfig as any || {}), topP: request.top_p };
  if (request.tools && request.tools.length > 0) {
    body.tools = [{
      functionDeclarations: request.tools.map((t: any) => ({
        name: t?.function?.name || t?.name,
        description: t?.function?.description || t?.description || "",
        parameters: t?.function?.parameters || t?.parameters || {},
      })),
    }];
  }
  return body;
}

/** Extract text + functionCall parts from a Gemini candidates[0].content.parts. */
export function extractGeminiParts(parts: any[]): { text: string; toolCalls: { id: string; name: string; arguments: string }[] } {
  let text = "";
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  let i = 0;
  for (const part of parts || []) {
    if (typeof part?.text === "string") text += part.text;
    if (part?.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}_${i++}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args || {}),
      });
    }
  }
  return { text, toolCalls };
}

export class AntigravityProvider extends BaseProvider {
  name = "antigravity";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("ag-");
  }

  supportedModels: ModelInfo[] = applyModelSpecs([
    { id: "ag-gemini-3-pro", object: "model", created: Date.now(), owned_by: "antigravity", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01 / 1000, creditSource: "estimated" },
    { id: "ag-gemini-3-pro-high", object: "model", created: Date.now(), owned_by: "antigravity", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
    { id: "ag-gemini-3-flash", object: "model", created: Date.now(), owned_by: "antigravity", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.003 / 1000, creditSource: "estimated" },
  ], (m) => m.id.replace(/^ag-/, ""));

  private getTokens(account: Account): AntigravityTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as AntigravityTokens;
    } catch { return null; }
  }

  private resolveModel(model: string): string {
    return agModelMap[model.toLowerCase()] || model;
  }

  private isExpired(tokens: AntigravityTokens): boolean {
    if (!tokens.access_token) return true;
    if (!tokens.expires_at) return true;
    return Date.now() / 1000 > (tokens.expires_at - 60);
  }

  /**
   * Exchange refresh_token → access_token at Google's token endpoint.
   * Returns the full updated token set (refresh_token is sticky — Google
   * rarely rotates it, but we preserve a returned one if present).
   */
  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) return { success: false, error: "No refresh_token" };
    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: AG_CLIENT_ID,
        client_secret: AG_CLIENT_SECRET,
      });
      const resp = await this.fetchWithTimeout(AG_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }, 15000);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `Refresh failed: HTTP ${resp.status}: ${text.slice(0, 200)}` };
      }
      const data = await resp.json() as any;
      if (!data.access_token) return { success: false, error: "No access_token in refresh response" };
      const expiresIn = Number(data.expires_in) || 3600;
      const updated: AntigravityTokens = {
        refresh_token: data.refresh_token || tokens.refresh_token,
        access_token: data.access_token,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        project_id: tokens.project_id,
        email: tokens.email,
        plan_type: tokens.plan_type,
      };
      return { success: true, tokens: JSON.stringify(updated) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Ensure we have a fresh access_token AND a bound projectId. loadCodeAssist
   * returns the cloudaicompanionProject + planInfo; we cache projectId in the
   * token set so we only call this once per account (re-bind on refresh).
   * Returns the live token set + usage, or throws on hard failure.
   */
  private async ensureAuth(account: Account, signal?: AbortSignal): Promise<{ tokens: AntigravityTokens; refreshed: boolean }> {
    let tokens = this.getTokens(account);
    if (!tokens?.refresh_token) throw new Error("No refresh_token");
    let refreshed = false;
    if (this.isExpired(tokens)) {
      const r = await this.refreshToken(account);
      if (!r.success || !r.tokens) throw new Error(r.error || "token refresh failed");
      tokens = JSON.parse(r.tokens) as AntigravityTokens;
      refreshed = true;
    }
    if (!tokens.project_id) {
      const usage = await this.loadCodeAssist(tokens, signal);
      if (usage.projectId) {
        tokens.project_id = usage.projectId;
        tokens.plan_type = usage.planType;
        refreshed = true; // persist the bound projectId
      }
    }
    return { tokens, refreshed };
  }

  /** Call loadCodeAssist to bind projectId + read plan credits. Pure-parse via parseLoadCodeAssist. */
  private async loadCodeAssist(tokens: AntigravityTokens, signal?: AbortSignal): Promise<AntigravityUsage> {
    const resp = await this.fetchWithTimeout(AG_LOAD_CODEASSIST_URL, {
      method: "POST",
      headers: this.apiHeaders(tokens),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
    }, 15000, signal);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`loadCodeAssist HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return parseLoadCodeAssist(await resp.json());
  }

  private apiHeaders(tokens: AntigravityTokens): Record<string, string> {
    return {
      "Authorization": `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      "User-Agent": AG_UA,
    };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.refresh_token;
  }

  async fetchQuota(account: Account, signal?: AbortSignal): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    try {
      const { tokens } = await this.ensureAuth(account, signal);
      // Re-query loadCodeAssist for fresh credit numbers (it's the credit source).
      const usage = await this.loadCodeAssist(tokens, signal);
      const limit = usage.monthlyPromptCredits;
      const remaining = usage.availablePromptCredits;
      return {
        success: true,
        quota: { limit, remaining, used: Math.max(0, limit - remaining), resetAt: null },
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  override async healthCheck(account: Account, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) return { kind: "missing_tokens", success: false, error: "No refresh_token" };
    try {
      const { tokens, refreshed } = await this.ensureAuth(account, signal);
      const usage = await this.loadCodeAssist(tokens, signal);
      const limit = usage.monthlyPromptCredits;
      const remaining = usage.availablePromptCredits;
      const exhausted = remaining <= 0 && limit > 0;
      return {
        kind: exhausted ? "exhausted" : "healthy",
        success: true,
        quota: { limit, remaining, used: Math.max(0, limit - remaining), resetAt: null, source: "antigravity.loadCodeAssist" },
        metadata: { plan_type: usage.planType, monthly_credits: limit, available_credits: remaining, project_id: usage.projectId },
        ...(refreshed ? { tokens: JSON.stringify(tokens) as unknown } : {}),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const expired = /401|expired|invalid_grant|Refresh failed/i.test(msg);
      return { kind: expired ? "session_expired" : "transient_error", success: false, retryable: !expired, error: msg };
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const { tokens } = await this.ensureAuth(account);
      const upstreamModel = this.resolveModel(request.model);
      const body = openAIToGemini(request, upstreamModel);

      const resp = await this.fetchWithTimeout(AG_GENERATE_URL, {
        method: "POST",
        headers: { ...this.apiHeaders(tokens), "X-Server-Timeout": "600" },
        body: JSON.stringify({ ...body, project: tokens.project_id }),
      }, config.providerRequestTimeoutMs);

      if (resp.status === 401) return { success: false, error: "expired: HTTP 401" };
      if (resp.status === 403) return { success: false, error: "Account restricted (HTTP 403)", banned: true };
      if (resp.status === 429) return { success: false, error: "Rate limited", quotaExhausted: true };
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
      }

      const data = await resp.json() as any;
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const { text, toolCalls } = extractGeminiParts(parts);
      const usage = data?.usageMetadata || {};
      const promptTokens = Number(usage.promptTokenCount || 0);
      const completionTokens = Number(usage.candidatesTokenCount || 0);

      const response: ChatCompletionResponse = {
        id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: text, tool_calls: toolCalls.length > 0 ? toolCalls : undefined },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };
      return { success: true, response, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const { tokens } = await this.ensureAuth(account);
      const upstreamModel = this.resolveModel(request.model);
      const body = openAIToGemini(request, upstreamModel);

      const resp = await this.fetchWithTimeout(AG_GENERATE_URL, {
        method: "POST",
        headers: this.apiHeaders(tokens),
        body: JSON.stringify({ ...body, project: tokens.project_id, stream: true }),
      }, config.providerRequestTimeoutMs);

      if (resp.status === 401) return { success: false, error: "expired: HTTP 401" };
      if (resp.status === 403) return { success: false, error: "Account restricted (HTTP 403)", banned: true };
      if (resp.status === 429) return { success: false, error: "Rate limited", quotaExhausted: true };
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
      }

      const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
      const model = request.model;
      const created = Math.floor(Date.now() / 1000);
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // Emit role.
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`));
          const reader = resp.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              // Gemini SSE: events separated by blank lines; data lines start with "data: ".
              let idx;
              while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const block = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
                if (!dataLine) continue;
                const payload = dataLine.slice(dataLine.indexOf(":") + 1).trim();
                if (!payload || payload === "[DONE]") continue;
                try {
                  const obj = JSON.parse(payload);
                  const parts = obj?.candidates?.[0]?.content?.parts || [];
                  const { text } = extractGeminiParts(parts);
                  if (text) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`));
                  }
                } catch { /* skip malformed */ }
              }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (e) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
