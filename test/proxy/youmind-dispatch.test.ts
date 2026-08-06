import { describe, it, expect } from "bun:test";
process.env.ENCRYPTION_KEY = "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import type { Account } from "../../src/db/schema";
import { encrypt } from "../../src/utils/crypto";
import { YouMindProvider } from "../../src/proxy/providers/youmind";
import {
  ANTHROPIC_RELAY_URL,
  OPENAI_RELAY_URL,
} from "../../src/proxy/providers/youmind/helpers";

// ── Test provider: capture the request, return a canned response ──────────
class TestYouMindProvider extends YouMindProvider {
  lastUrl: string | null = null;
  lastRequestBody: any = null;
  lastHeaders: Headers | null = null;

  constructor(
    private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    super();
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    this.lastUrl = url;
    this.lastRequestBody = JSON.parse(String(init.body || "{}"));
    this.lastHeaders = new Headers(init.headers);
    return this.responder(url, init);
  }
}

const account = {
  id: 1,
  provider: "youmind",
  email: "ym@test.local",
  password: encrypt("sk-ym-test-key-123"),
} as unknown as Account;

// ── Helpers ────────────────────────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: Array<Record<string, unknown>>, status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) {
          const eventName = e.type ? `event: ${String(e.type)}\n` : "";
          controller.enqueue(encoder.encode(`${eventName}data: ${JSON.stringify(e)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

function openAISseResponse(chunks: Array<Record<string, unknown>>, status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

async function collectOpenAIStream(stream: ReadableStream<Uint8Array>) {
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
    const payload = block.split("\n").find((line) => line.startsWith("data:"));
    if (!payload) continue;
    const data = payload.startsWith("data: ") ? payload.slice(6).trim() : payload.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    chunks.push(JSON.parse(data));
  }
  return chunks;
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const anthropicTextResponse = {
  id: "msg_01abc",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "Hello from YouMind" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 4 },
};

const anthropicToolResponse = {
  id: "msg_02xyz",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content: [
    { type: "text", text: "Let me look that up." },
    { type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "Paris" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 30, output_tokens: 15 },
};

const anthropicStreamEvents = [
  {
    type: "message_start",
    message: {
      id: "msg_stream1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stream-" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: 10, output_tokens: 2 },
  },
  { type: "message_stop" },
];

describe("YouMind provider — anthropic<->openai dispatcher + transforms", () => {
  describe("ownsModel / supportedModels", () => {
    it("owns ym-* models case-insensitively", () => {
      const p = new YouMindProvider();
      expect(p.ownsModel("ym-claude-sonnet-4.6")).toBe(true);
      expect(p.ownsModel("YM-GPT-4O")).toBe(true);
      expect(p.ownsModel("gpt-4")).toBe(false);
      expect(p.ownsModel("claude-3")).toBe(false);
    });

    it("exposes catalog entries with ym- prefix and estimated credit source", () => {
      const p = new YouMindProvider();
      const ids = p.supportedModels.map((m) => m.id);
      expect(ids).toContain("ym-claude-sonnet-4.6");
      expect(ids).toContain("ym-gpt-5.5");
      for (const m of p.supportedModels) {
        expect(m.owned_by).toBe("youmind");
        expect(m.creditUnit).toBe("token");
        expect(m.creditSource).toBe("estimated");
      }
    });
  });

  describe("OpenAI route (ym-gpt-*)", () => {
    it("POSTs to the OpenAI relay and parses a chat.completion response", async () => {
      const provider = new TestYouMindProvider(() =>
        jsonResponse({
          id: "chatcmpl-ym1",
          object: "chat.completion",
          created: 1234567890,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "openai hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
      );

      const result = await provider.chatCompletion(account, {
        model: "ym-gpt-4o",
        messages: [{ role: "user", content: "Say openai hello" }],
      });

      expect(result.success).toBe(true);
      expect(provider.lastUrl).toBe(OPENAI_RELAY_URL);
      expect(provider.lastRequestBody.model).toBe("gpt-4o");
      expect(provider.lastRequestBody.stream).toBe(false);
      expect(provider.lastHeaders?.get("authorization")).toBe("Bearer sk-ym-test-key-123");

      const resp = result.response!;
      expect(resp.id).toBe("chatcmpl-ym1");
      expect(resp.model).toBe("ym-gpt-4o"); // rewritten to client-facing id
      expect(resp.choices[0]?.message.content).toBe("openai hello");
      expect(resp.choices[0]?.finish_reason).toBe("stop");
      expect(resp.usage.total_tokens).toBe(10);
    });

    it("rewrites max_tokens -> max_completion_tokens for GPT-5.x models", async () => {
      const provider = new TestYouMindProvider(() =>
        jsonResponse({
          id: "chatcmpl-ym2",
          object: "chat.completion",
          created: 1,
          model: "gpt-5.5",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );

      const result = await provider.chatCompletion(account, {
        model: "ym-gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1234,
      });

      expect(result.success).toBe(true);
      expect(provider.lastRequestBody.max_completion_tokens).toBe(1234);
      expect(provider.lastRequestBody.max_tokens).toBeUndefined();
    });

    it("streams OpenAI chunks and preserves the original model id", async () => {
      const provider = new TestYouMindProvider(() =>
        openAISseResponse([
          { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: "chunk-" }, finish_reason: null }] },
          { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] },
          { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]),
      );

      const result = await provider.chatCompletionStream(account, {
        model: "ym-gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "stream please" }],
      });

      expect(result.success).toBe(true);
      expect(provider.lastUrl).toBe(OPENAI_RELAY_URL);
      expect(provider.lastRequestBody.stream).toBe(true);

      const chunks = await collectOpenAIStream(result.stream!);
      expect(chunks.map((c) => c.choices[0]?.delta?.content || "").join("")).toBe("chunk-done");
      expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
      for (const c of chunks) {
        expect(c.model).toBe("ym-gpt-4o");
      }
    });
  });

  describe("Anthropic route (ym-claude-*)", () => {
    it("POSTs to the Anthropic relay with Anthropic-shaped body and parses response", async () => {
      const provider = new TestYouMindProvider(() => jsonResponse(anthropicTextResponse));

      const result = await provider.chatCompletion(account, {
        model: "ym-claude-sonnet-4.6",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
        max_tokens: 1024,
      });

      expect(result.success).toBe(true);
      expect(provider.lastUrl).toBe(ANTHROPIC_RELAY_URL);
      expect(provider.lastHeaders?.get("authorization")).toBe("Bearer sk-ym-test-key-123");
      expect(provider.lastHeaders?.get("anthropic-version")).toBe("2023-06-01");

      const body = provider.lastRequestBody;
      expect(body.model).toBe("claude-sonnet-4-6");
      expect(body.stream).toBe(false);
      expect(body.system).toBe("You are helpful.");
      expect(body.max_tokens).toBe(1024);
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);

      const resp = result.response!;
      expect(resp.object).toBe("chat.completion");
      expect(resp.model).toBe("ym-claude-sonnet-4.6");
      expect(resp.choices[0]?.message.content).toBe("Hello from YouMind");
      expect(resp.choices[0]?.finish_reason).toBe("stop");
      expect(resp.usage.prompt_tokens).toBe(12);
      expect(resp.usage.completion_tokens).toBe(4);
      expect(resp.usage.total_tokens).toBe(16);
    });

    it("caps max_tokens at the model's max_output", async () => {
      const provider = new TestYouMindProvider(() => jsonResponse(anthropicTextResponse));

      const result = await provider.chatCompletion(account, {
        model: "ym-claude-sonnet-4.6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 999_999,
      });

      expect(result.success).toBe(true);
      // claude-sonnet-4.6 max_output is 64000
      expect(provider.lastRequestBody.max_tokens).toBe(64000);
    });

    it("converts tool_calls to Anthropic tool_use blocks and back", async () => {
      const provider = new TestYouMindProvider(() => jsonResponse(anthropicToolResponse));

      const result = await provider.chatCompletion(account, {
        model: "ym-claude-sonnet-4.6",
        messages: [
          { role: "user", content: "What is the weather in Paris?" },
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          } as any,
          { role: "tool", content: "sunny", tool_call_id: "call_1" } as any,
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      });

      expect(result.success).toBe(true);
      const body = provider.lastRequestBody;
      expect(body.tools).toEqual([
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ]);
      // assistant turn with tool_use block
      const assistantMsg = body.messages.find((m: any) => m.role === "assistant");
      expect(assistantMsg?.content?.[1]).toEqual({
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "Paris" },
      });
      // tool role converted to user-side tool_result
      const toolMsg = body.messages.find(
        (m: any) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
      );
      expect(toolMsg?.content?.[0]).toEqual({
        type: "tool_result",
        tool_use_id: "call_1",
        content: "sunny",
      });

      const resp = result.response!;
      expect(resp.choices[0]?.finish_reason).toBe("tool_calls");
      expect(resp.choices[0]?.message.tool_calls?.[0]).toEqual({
        id: "toolu_01",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      });
    });

    it("forwards thinking config to the Anthropic relay when request.thinking is set", async () => {
      const provider = new TestYouMindProvider(() => jsonResponse(anthropicTextResponse));

      const result = await provider.chatCompletion(account, {
        model: "ym-claude-sonnet-4.6",
        messages: [{ role: "user", content: "think" }],
        thinking: { type: "enabled", budget_tokens: 5000 },
      });

      expect(result.success).toBe(true);
      expect(provider.lastRequestBody.model).toBe("claude-sonnet-4-6");
      expect(provider.lastRequestBody.thinking).toEqual({
        type: "enabled",
        budget_tokens: 5000,
      });
    });

    it("translates Anthropic SSE into OpenAI chunks (text, finish_reason, [DONE])", async () => {
      const provider = new TestYouMindProvider(() => sseResponse(anthropicStreamEvents));

      const result = await provider.chatCompletionStream(account, {
        model: "ym-claude-sonnet-4.6",
        stream: true,
        messages: [{ role: "user", content: "stream" }],
      });

      expect(result.success).toBe(true);
      expect(provider.lastUrl).toBe(ANTHROPIC_RELAY_URL);
      expect(provider.lastRequestBody.stream).toBe(true);

      const chunks = await collectOpenAIStream(result.stream!);
      expect(chunks.map((c) => c.choices[0]?.delta?.content || "").join("")).toBe("stream-ok");
      expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
      for (const c of chunks) {
        expect(c.model).toBe("ym-claude-sonnet-4.6");
        expect(c.object).toBe("chat.completion.chunk");
      }
    });

    it("emits reasoning_content deltas when thinking is enabled", async () => {
      const provider = new TestYouMindProvider(() =>
        sseResponse([
          {
            type: "message_start",
            message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 1 } },
          },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason." } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 3 } },
          { type: "message_stop" },
        ]),
      );

      const result = await provider.chatCompletionStream(account, {
        model: "ym-claude-sonnet-4.6",
        stream: true,
        messages: [{ role: "user", content: "think" }],
      });

      expect(result.success).toBe(true);
      const chunks = await collectOpenAIStream(result.stream!);
      const reasoning = chunks.map((c) => c.choices[0]?.delta?.reasoning_content || "").join("");
      expect(reasoning).toBe("Let me reason.");
      const text = chunks.map((c) => c.choices[0]?.delta?.content || "").join("");
      expect(text).toBe("answer");
      expect(text).not.toContain("Let me reason.");
    });

    it("ignores upstream error events and still terminates with [DONE]", async () => {
      const provider = new TestYouMindProvider(() =>
        sseResponse([
          { type: "error", error: { type: "api_error", message: "upstream exploded" } },
        ]),
      );

      const result = await provider.chatCompletionStream(account, {
        model: "ym-claude-sonnet-4.6",
        stream: true,
        messages: [{ role: "user", content: "fail" }],
      });

      expect(result.success).toBe(true); // stream opened; error is inside
      const chunks = await collectOpenAIStream(result.stream!);
      // error events are ignored; stream should still emit a final stop chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    });
  });

  describe("error mapping", () => {
    it("maps upstream non-OK JSON error to ProviderResult.error", async () => {
      const provider = new TestYouMindProvider(() =>
        jsonResponse({ error: { type: "rate_limit_error", message: "slow down" } }, 429),
      );

      const result = await provider.chatCompletion(account, {
        model: "ym-claude-sonnet-4.6",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.success).toBe(false);
      // handleErrorResponse returns the raw body text for 429
      expect(result.error).toContain("rate_limit_error");
      expect(result.rateLimited).toBe(true);
    });

    it("returns error for unknown ym-* model id", async () => {
      const provider = new TestYouMindProvider(() => jsonResponse({}));
      const result = await provider.chatCompletion(account, {
        model: "ym-nonexistent-model",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown YouMind model");
    });
  });
});
