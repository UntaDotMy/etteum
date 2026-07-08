/**
 * Cursor direct provider (Connect-RPC + protobuf).
 *
 * 1:1 with the reference proxy open-sse/executors/cursor.js. Encodes an
 * OpenAI-shaped chat request into Cursor's Connect-RPC protobuf wire format,
 * sends it to api2.cursor.sh with the checksum + machine-id headers, and
 * streams the response frames back as OpenAI-shaped SSE chunks.
 *
 * Replaces the prior generic MITM-passthrough Cursor handling with a real
 * executor: the request is shaped to Cursor's native protocol and the response
 * is decoded from Connect-RPC protobuf.
 */
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import { generateCursorBody, parseConnectRPCFrame, extractTextFromResponse } from "./cursorProtobuf";
import { buildCursorHeaders } from "./cursorChecksum";
import zlib from "node:zlib";

const CURSOR_ENDPOINT = "https://api2.cursor.sh/aiserver.v1.AiService/StreamUnifiedChatWithTools";

const COMPRESS_FLAG = { NONE: 0x00, GZIP: 0x01, TRAILER: 0x02, GZIP_TRAILER: 0x03 };

interface CursorTokens {
  access_token: string;
  machineId?: string;
  ghostMode?: boolean;
}

/** Decompress a frame payload per its compression flags. */
function decompressPayload(payload: Uint8Array, flags: number): Uint8Array {
  // Cursor sometimes returns a JSON error body (starts with {"error).
  if (payload.length > 10 && payload[0] === 0x7b && payload[1] === 0x22) {
    return payload;
  }
  if (flags === COMPRESS_FLAG.GZIP || flags === COMPRESS_FLAG.TRAILER || flags === COMPRESS_FLAG.GZIP_TRAILER) {
    try {
      return zlib.gunzipSync(Buffer.from(payload));
    } catch {
      return payload;
    }
  }
  return payload;
}

export class CursorProvider extends BaseProvider {
  name = "cursor";

  supportedModels: ModelInfo[] = [
    { id: "cursor-fast", object: "model", created: 0, owned_by: "cursor" },
    { id: "cursor-small", object: "model", created: 0, owned_by: "cursor" },
    { id: "gpt-4", object: "model", created: 0, owned_by: "cursor" },
    { id: "gpt-4o", object: "model", created: 0, owned_by: "cursor" },
    { id: "claude-3.5-sonnet", object: "model", created: 0, owned_by: "cursor" },
  ];

  override ownsModel(model: string): boolean {
    const m = (model || "").toLowerCase();
    return m.startsWith("cursor-") || ["gpt-4", "gpt-4o", "claude-3.5-sonnet"].includes(m);
  }

  /** Cursor tokens (WorkosCursor bearer) don't refresh client-side. */
  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getTokens(account)?.access_token;
  }

  async fetchQuota(): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    // Cursor doesn't expose a usage/quota endpoint.
    return { success: true, quota: { limit: 0, remaining: 0, used: 0 } };
  }

  private getTokens(account: Account): CursorTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as CursorTokens;
    } catch {
      return null;
    }
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const stream = await this.chatCompletionStream(account, request);
    if (!stream.success || !stream.stream) return stream;
    // Drain the stream into a single non-streaming response.
    const reader = stream.stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let toolCalls: any[] = [];
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split("\n\n")) {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const data = dataLine.startsWith("data: ") ? dataLine.slice(6) : dataLine.slice(5);
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) text += delta.content;
          if (delta?.tool_calls) toolCalls.push(...delta.tool_calls);
        } catch { /* skip malformed */ }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
    const response: ChatCompletionResponse = {
      id: `chatcmpl-cursor-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return { success: true, response };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: false, error: "Cursor account missing access_token" };

    const forceAgentMode = String(request.tools?.length ?? 0) !== "0";
    const body = generateCursorBody(request.messages as any[], request.model, request.tools || [], request.reasoning_effort || null, forceAgentMode);
    const headers = buildCursorHeaders(tokens.access_token, tokens.machineId || null, tokens.ghostMode !== false);

    const response = await fetch(CURSOR_ENDPOINT, { method: "POST", headers, body });
    if (response.status === 401) return { success: false, error: "expired: HTTP 401" };
    if (response.status === 403) return { success: false, error: "Account banned or restricted (HTTP 403)", banned: true };
    if (response.status === 429) return { success: false, error: "Rate limited", rateLimited: true };
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      return { success: false, error: `Cursor HTTP ${response.status}: ${text.slice(0, 200)}` };
    }

    const id = `chatcmpl-cursor-${Date.now()}`;
    const model = request.model;
    const encoder = new TextEncoder();
    const upstream = response.body;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader();
        let buffer = new Uint8Array(0);
        let started = false;
        let offset = 0;
        let toolIndex = 0;

        const emit = (delta: any, finish_reason: string | null = null) => {
          const chunk = {
            id, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta, finish_reason }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };
        const emitRole = () => { if (!started) { started = true; emit({ role: "assistant" }); } };

        const tryParseFrames = () => {
          while (true) {
            const frame = parseConnectRPCFrame(buffer, offset);
            if (frame.status === "done") break;
            const payload = decompressPayload(frame.payload!, frame.flags || 0);
            const chunk = extractTextFromResponse(payload);
            if (chunk.toolCall) {
              emitRole();
              emit({
                tool_calls: [{
                  index: toolIndex++,
                  id: chunk.toolCall.id,
                  type: "function",
                  function: { name: chunk.toolCall.name, arguments: chunk.toolCall.arguments },
                }],
              });
            } else if (chunk.text) {
              emitRole();
              emit({ content: chunk.text });
            } else if (chunk.thinking) {
              emitRole();
              emit({ reasoning_content: chunk.thinking });
            }
            offset = frame.newOffset!;
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              const merged = new Uint8Array(buffer.length + value.length);
              merged.set(buffer, 0);
              merged.set(value, buffer.length);
              buffer = merged;
              tryParseFrames();
            }
          }
          // Final flush of any trailing frames.
          tryParseFrames();
          emit({}, started ? (toolIndex > 0 ? "tool_calls" : "stop") : "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err: any) {
          controller.error(err);
        } finally {
          controller.close();
        }
      },
    });

    return { success: true, stream };
  }
}
