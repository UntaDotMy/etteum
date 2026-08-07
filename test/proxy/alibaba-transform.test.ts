/**
 * Alibaba DashScope provider — enable_thinking transform tests.
 *
 * Covers appendOptionalParams (via chatCompletion / chatCompletionStream):
 * the DashScope `enable_thinking` / `thinking_budget` body fields derived
 * from the client request (-thinking suffix, reasoning_effort, thinking
 * block) gated on the model's catalog thinking support.
 *
 * Network is fully mocked by overriding fetchWithTimeout (codex-provider
 * idiom). Accounts are plain objects — no DB rows required.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeEach } from "bun:test";
import { AlibabaProvider } from "../../src/proxy/providers/alibaba/provider";
import { encrypt } from "../../src/utils/crypto";
import type { Account } from "../../src/db/schema";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";

// ── Test harness ─────────────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit; body: any };

class TestAlibabaProvider extends AlibabaProvider {
  calls: FetchCall[] = [];

  constructor(
    private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    super();
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    let parsed: any = null;
    try {
      parsed = init.body ? JSON.parse(String(init.body)) : null;
    } catch {
      parsed = null;
    }
    this.calls.push({ url, init, body: parsed });
    return this.responder(url, init);
  }

  lastChatBody(): any {
    const chat = this.calls.filter((c) => c.url.includes("/chat/completions"));
    return chat[chat.length - 1]?.body ?? null;
  }
}

function makeAccount(): Account {
  return {
    id: 424242,
    provider: "alibaba",
    email: "ali-test",
    password: encrypt("sk-test-key"),
    tokens: null,
  } as unknown as Account;
}

function baseRequest(model: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

function okCompletion(model: string, content = "hello") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1700000000,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function sseResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<any[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const chunks: any[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.startsWith("data: ") ? line.slice(6).trim() : line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    chunks.push(JSON.parse(data));
  }
  return chunks;
}

// deepseek-v4-flash is thinking-capable per MODEL_SPECS; qwen-plus is not.
const THINKING_MODEL = "ali-deepseek-v4-flash";
const PLAIN_MODEL = "ali-qwen-plus";

// ── enable_thinking transform ────────────────────────────────────────
//
// FIXED (was a silent defect): appendOptionalParams resolves the thinking spec
// via resolveModelSpec(this.resolveModel(request.model)) — i.e. the CANONICAL
// upstream name, not the client-facing ali-* id. Previously it passed the
// prefixed id, MODEL_SPECS (keyed by upstream name) always missed, and
// enable_thinking was force-disabled even when the client asked for thinking
// on a thinking-capable model. The tests below assert the corrected behavior:
// the documented signals (-thinking suffix, reasoning_effort, thinking block)
// now enable it on thinking-capable models.

describe("alibaba enable_thinking transform (non-stream)", () => {
  test("thinking-capable model without client signals sets enable_thinking=false", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash"));
    const result = await provider.chatCompletion(makeAccount(), baseRequest(THINKING_MODEL));

    expect(result.success).toBe(true);
    const body = provider.lastChatBody();
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking_budget).toBeUndefined();
  });

  test("-thinking suffix on a capable model enables thinking (suffix kept upstream)", async () => {
    // resolveModel strips only the ali- prefix (suffix kept upstream), and the
    // spec gate now opens because resolveModelSpec gets the canonical name.
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash-thinking"));
    const result = await provider.chatCompletion(
      makeAccount(),
      baseRequest(`${THINKING_MODEL}-thinking`),
    );

    expect(result.success).toBe(true);
    const body = provider.lastChatBody();
    expect(body.model).toBe("deepseek-v4-flash-thinking");
    expect(body.enable_thinking).toBe(true);
  });

  test("reasoning_effort 'high' enables thinking on a capable model", async () => {
    // deepseek-v4-flash has thinking:true; 'high' is an enable signal.
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(THINKING_MODEL, { reasoning_effort: "high" }),
    );
    expect(provider.lastChatBody().enable_thinking).toBe(true);
  });

  test("reasoning_effort 'none' disables thinking", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(THINKING_MODEL, { reasoning_effort: "none" }),
    );
    expect(provider.lastChatBody().enable_thinking).toBe(false);
  });

  test("empty reasoning_effort string does not enable thinking", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(THINKING_MODEL, { reasoning_effort: "" }),
    );
    expect(provider.lastChatBody().enable_thinking).toBe(false);
  });

  test("thinking block with budget enables thinking and forwards budget", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(THINKING_MODEL, { thinking: { type: "enabled", budget_tokens: 4096 } }),
    );

    const body = provider.lastChatBody();
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(4096);
  });

  test("thinking type 'adaptive' (Claude Code default) enables thinking on a capable model", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(THINKING_MODEL, { thinking: { type: "adaptive" } }),
    );
    expect(provider.lastChatBody().enable_thinking).toBe(true);
  });

  test("thinking type 'disabled' disables thinking even on capable model", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(THINKING_MODEL, { thinking: { type: "disabled", budget_tokens: 4096 } }),
    );

    const body = provider.lastChatBody();
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking_budget).toBeUndefined();
  });

  test("non-thinking model with -thinking suffix: suffix forwarded upstream, thinking off", async () => {
    // "qwen-plus-thinking" resolves to thinking-capable via variant promotion
    // in resolveModelSpec, but the prefixed lookup still fails — same bug.
    const provider = new TestAlibabaProvider(() => okCompletion("qwen-plus-thinking"));
    await provider.chatCompletion(makeAccount(), baseRequest(`${PLAIN_MODEL}-thinking`));

    const body = provider.lastChatBody();
    expect(body.model).toBe("qwen-plus-thinking");
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking_budget).toBeUndefined();
  });

  test("non-thinking model with reasoning_effort still gets enable_thinking=false", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("qwen-plus"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(PLAIN_MODEL, { reasoning_effort: "high" }),
    );
    expect(provider.lastChatBody().enable_thinking).toBe(false);
  });

  test("optional params pass through alongside enable_thinking", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash-thinking"));
    await provider.chatCompletion(
      makeAccount(),
      baseRequest(`${THINKING_MODEL}-thinking`, {
        temperature: 0.5,
        max_tokens: 128,
        top_p: 0.9,
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        tool_choice: "auto",
      }),
    );

    const body = provider.lastChatBody();
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(128);
    expect(body.top_p).toBe(0.9);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    expect(body.stream).toBe(false);
  });
});

// ── response / stream handling ───────────────────────────────────────

describe("alibaba response handling", () => {
  test("non-stream response model id rewritten back to prefixed proxy id", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("deepseek-v4-flash", "world"));
    const result = await provider.chatCompletion(makeAccount(), baseRequest(THINKING_MODEL));

    expect(result.success).toBe(true);
    expect(result.response?.model).toBe(THINKING_MODEL);
    expect(result.response?.choices[0]?.message.content).toBe("world");
    expect(result.response?.usage.total_tokens).toBe(5);
    expect(result.promptTokens).toBe(3);
    expect(result.completionTokens).toBe(2);
    expect(result.tokensUsed).toBe(5);
  });

  test("Authorization header carries the decrypted API key", async () => {
    const provider = new TestAlibabaProvider(() => okCompletion("qwen-plus"));
    await provider.chatCompletion(makeAccount(), baseRequest(PLAIN_MODEL));

    const call = provider.calls[0];
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-key");
  });

  test("401 maps to invalid-key error", async () => {
    const provider = new TestAlibabaProvider(
      () => new Response("unauthorized", { status: 401 }),
    );
    const result = await provider.chatCompletion(makeAccount(), baseRequest(PLAIN_MODEL));
    expect(result.success).toBe(false);
    expect(result.error).toContain("401");
  });

  test("429 maps to rateLimited", async () => {
    const provider = new TestAlibabaProvider(
      () => new Response("slow down", { status: 429 }),
    );
    const result = await provider.chatCompletion(makeAccount(), baseRequest(PLAIN_MODEL));
    expect(result.success).toBe(false);
    expect(result.rateLimited).toBe(true);
  });

  test("403 AccessDenied.Unpurchased maps to not-activated error", async () => {
    const provider = new TestAlibabaProvider(
      () => new Response('{"code":"AccessDenied.Unpurchased"}', { status: 403 }),
    );
    const result = await provider.chatCompletion(makeAccount(), baseRequest(PLAIN_MODEL));
    expect(result.success).toBe(false);
    expect(result.error).toContain("not activated/purchased");
  });

  test("200 with error body maps to failure with upstream message", async () => {
    const provider = new TestAlibabaProvider(
      () =>
        new Response(
          JSON.stringify({ error: { code: "InvalidParameter", message: "bad param" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const result = await provider.chatCompletion(makeAccount(), baseRequest(PLAIN_MODEL));
    expect(result.success).toBe(false);
    expect(result.error).toBe("bad param");
  });

  test("stream request rewrites chunk model ids back to the client-facing id", async () => {
    const provider = new TestAlibabaProvider(() =>
      sseResponse([
        {
          id: "chunk-1",
          object: "chat.completion.chunk",
          model: "deepseek-v4-flash-thinking",
          choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking…" }, finish_reason: null }],
        },
        {
          id: "chunk-1",
          object: "chat.completion.chunk",
          model: "deepseek-v4-flash-thinking",
          choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
        },
        {
          id: "chunk-1",
          object: "chat.completion.chunk",
          model: "deepseek-v4-flash-thinking",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      ]),
    );

    const result = await provider.chatCompletionStream(
      makeAccount(),
      baseRequest(`${THINKING_MODEL}-thinking`, { stream: true }),
    );

    expect(result.success).toBe(true);
    const body = provider.lastChatBody();
    expect(body.stream).toBe(true);
    // Stream path forwards the -thinking suffix upstream (same resolveModel
    // fallback) and — with the spec-gate fix — enables thinking.
    expect(body.model).toBe("deepseek-v4-flash-thinking");
    expect(body.enable_thinking).toBe(true);

    const chunks = await collectSSE(result.stream!);
    expect(chunks.length).toBe(3);
    // Model id rewritten to the client-facing prefixed id on every chunk.
    expect(chunks[0]?.model).toBe(`${THINKING_MODEL}-thinking`);
    expect(chunks[1]?.model).toBe(`${THINKING_MODEL}-thinking`);
    // Reasoning delta passes through untouched.
    expect(chunks[0]?.choices?.[0]?.delta?.reasoning_content).toBe("thinking…");
    expect(chunks[1]?.choices?.[0]?.delta?.content).toBe("answer");
    expect(chunks[2]?.choices?.[0]?.finish_reason).toBe("stop");
    expect(chunks[2]?.usage?.total_tokens).toBe(14);
  });

  test("stream chunk carrying an error is forwarded as an error event", async () => {
    const provider = new TestAlibabaProvider(() =>
      sseResponse([
        { error: { message: "upstream blew up", code: "InternalError" } },
      ]),
    );

    const result = await provider.chatCompletionStream(
      makeAccount(),
      baseRequest(PLAIN_MODEL, { stream: true }),
    );
    expect(result.success).toBe(true);

    const chunks = await collectSSE(result.stream!);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.error?.message).toBe("upstream blew up");
  });

  test("stream without client thinking signals sends enable_thinking=false", async () => {
    const provider = new TestAlibabaProvider(() =>
      sseResponse([
        {
          id: "c1",
          object: "chat.completion.chunk",
          model: "deepseek-v4-flash",
          choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
        },
      ]),
    );
    await provider.chatCompletionStream(
      makeAccount(),
      baseRequest(THINKING_MODEL, { stream: true }),
    );
    expect(provider.lastChatBody().enable_thinking).toBe(false);
  });
});

// ── quota cache / fetchQuota ─────────────────────────────────────────

function quotaPage(quotas: unknown[], total?: number) {
  return new Response(
    JSON.stringify({
      success: true,
      output: { quotas, ...(total !== undefined ? { total } : {}) },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function quotaEntry(model: string, usageLimit: number, periodDays = 60) {
  return {
    model,
    model_limit: {
      usage_limit: usageLimit,
      usage_limit_field: "token",
      usage_limit_period: periodDays,
      request_limit: null,
      request_limit_period: null,
    },
  };
}

