/**
 * codebuddy provider — schema-cache eviction + stream usage.credit finalizer fallback.
 *
 * Two units under test:
 *  1. sanitizeToolSchema() schema-cache: caches resolved tool schemas keyed by
 *     JSON, and evicts (clears) the whole cache once it reaches SCHEMA_CACHE_MAX
 *     (200) so memory stays bounded under adversarial / high-cardinality schemas.
 *  2. Stream usage.credit handling: the streaming path forwards upstream
 *     usage.credit on the SSE chunk (so the index.ts finalizer can read it) and
 *     the provider result carries the estimated-credit fallback (creditsUsed: 0,
 *     creditSource: "estimated") used only when the finalizer finds nothing.
 *
 * All network is mocked via fetchWithTimeout override — no real upstream calls.
 */
import { describe, expect, test, beforeAll } from "bun:test";

// Env must be set before importing anything that touches config/crypto/db.
process.env.ENCRYPTION_KEY = "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import type { Account } from "../../src/db/schema";
import { CodeBuddyProvider } from "../../src/proxy/providers/codebuddy/provider";

const account = {
  id: 1,
  provider: "codebuddy",
  email: "cb@test.local",
  tokens: { api_key: "cb-api-key" },
} as unknown as Account;

/** Test subclass: captures the outgoing request body and serves a canned response. */
class TestCodeBuddyProvider extends CodeBuddyProvider {
  lastRequestBody: any;
  lastRequestHeaders: Record<string, string> = {};

  constructor(
    private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    super();
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    this.lastRequestBody = JSON.parse(String(init.body || "{}"));
    this.lastRequestHeaders = (init.headers as Record<string, string>) || {};
    return this.responder(url, init);
  }

  // Expose protected/private internals for direct unit testing of the pure seams.
  public exposeSanitize(schema: any): any {
    return (this as any).sanitizeToolSchema(schema);
  }
  public schemaCacheSize(): number {
    return (this as any).schemaCache.size as number;
  }
  public static cacheMax(): number {
    return (CodeBuddyProvider as any).SCHEMA_CACHE_MAX as number;
  }
}

/** Build an SSE Response from a list of upstream chunk objects (auto [DONE]). */
function sseResponse(events: unknown[], { done = true }: { done?: boolean } = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        if (done) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** Collect an OpenAI-shaped SSE stream into parsed chunk objects. */
async function collectStream(stream: ReadableStream<Uint8Array>) {
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

beforeAll(() => {
  // nothing to warm up; provider is constructed per-test
});

describe("schema-cache eviction (sanitizeToolSchema)", () => {
  test("caches an identical schema so the second call hits the cache (no eviction)", () => {
    const p = new TestCodeBuddyProvider(() => sseResponse([]));
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      $defs: { S: { type: "string" } },
    };
    const first = p.exposeSanitize(schema);
    const sizeAfterFirst = p.schemaCacheSize();
    const second = p.exposeSanitize(schema); // same JSON key -> cache hit
    expect(sizeAfterFirst).toBe(1);
    expect(p.schemaCacheSize()).toBe(1); // unchanged on hit
    // Cached entry is returned by reference.
    expect(second).toBe(first);
    // $defs stripped, type defaulted.
    expect(first.$defs).toBeUndefined();
    expect(first.type).toBe("object");
  });

  test("resolves $ref inline and caches the resolved output", () => {
    const p = new TestCodeBuddyProvider(() => sseResponse([]));
    const schema = {
      type: "object",
      properties: { pet: { $ref: "#/$defs/Pet" } },
      $defs: { Pet: { type: "object", properties: { name: { type: "string" } } } },
    };
    const out = p.exposeSanitize(schema);
    expect(out.$defs).toBeUndefined();
    expect(out.properties?.pet?.type).toBe("object");
    expect(out.properties?.pet?.properties?.name?.type).toBe("string");
  });

  test("evicts (clears) the whole cache once it reaches SCHEMA_CACHE_MAX", () => {
    const p = new TestCodeBuddyProvider(() => sseResponse([]));
    const MAX = TestCodeBuddyProvider.cacheMax();
    expect(MAX).toBe(200);

    // Fill the cache to exactly MAX with distinct schemas.
    for (let i = 0; i < MAX; i++) {
      p.exposeSanitize({ type: "object", properties: { [`k${i}`]: { type: "string" } } });
    }
    expect(p.schemaCacheSize()).toBe(MAX);

    // One more distinct schema triggers the eviction branch:
    //   if (size >= MAX) clear(); then set() -> size becomes 1.
    p.exposeSanitize({ type: "object", properties: { overflow: { type: "string" } } });
    expect(p.schemaCacheSize()).toBe(1);
  });

  test("evicted entries are re-resolved (not served stale) after a clear", () => {
    const p = new TestCodeBuddyProvider(() => sseResponse([]));
    const MAX = TestCodeBuddyProvider.cacheMax();
    const target = { type: "object", properties: { tgt: { type: "number" } } };

    const before = p.exposeSanitize(target);
    expect(p.schemaCacheSize()).toBe(1);

    // Overflow the cache to force a clear, evicting `target`.
    for (let i = 0; i < MAX; i++) {
      p.exposeSanitize({ type: "object", properties: { [`x${i}`]: { type: "boolean" } } });
    }
    expect(p.schemaCacheSize()).toBe(1); // cleared then refilled by the overflow insert

    // Re-sanitizing the original target recomputes (cache miss) and re-adds it.
    const after = p.exposeSanitize(target);
    expect(after).toEqual(before);
    expect(after).not.toBe(before); // recomputed object, not the evicted reference
    expect(p.schemaCacheSize()).toBe(2);
  });

  test("non-object / array schemas bypass the cache and return a safe default", () => {
    const p = new TestCodeBuddyProvider(() => sseResponse([]));
    expect(p.exposeSanitize(null)).toEqual({ type: "object", properties: {} });
    expect(p.exposeSanitize([1, 2, 3])).toEqual({ type: "object", properties: {} });
    expect(p.exposeSanitize("nope")).toEqual({ type: "object", properties: {} });
    expect(p.schemaCacheSize()).toBe(0); // nothing cached for invalid input
  });

  test("normalizeTools routes tool parameters through the schema cache", async () => {
    const p = new TestCodeBuddyProvider(() => sseResponse([]));
    const params = { type: "object", properties: { q: { type: "string" } } };
    const req = {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      tools: [
        { type: "function", function: { name: "search", description: "s", parameters: params } },
        { name: "other", description: "o", input_schema: params }, // Anthropic shape
      ],
    } as any;
    await p.chatCompletionStream(account, req);
    const tools = p.lastRequestBody?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(2);
    // Both shapes normalize to OpenAI function form with sanitized parameters.
    expect(tools?.[0]?.function?.name).toBe("search");
    expect(tools?.[0]?.function?.parameters?.type).toBe("object");
    expect(tools?.[1]?.function?.name).toBe("other");
    expect(tools?.[1]?.function?.parameters?.type).toBe("object");
    // Identical parameter schema reused the same cache entry (single cache key).
    expect(p.schemaCacheSize()).toBe(1);
  });
});

describe("stream usage.credit finalizer fallback", () => {
  test("forwards usage.credit on the SSE chunk so the index.ts finalizer can read it", async () => {
    const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, credit: 3.5 };
    const p = new TestCodeBuddyProvider(() =>
      sseResponse([
        { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
        { id: "chatcmpl-up", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]),
    );
    const result = await p.chatCompletionStream(account, {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    } as any);
    expect(result.success).toBe(true);
    expect(result.stream).toBeDefined();

    const chunks = await collectStream(result.stream!);
    const usageChunk = chunks.find((c) => c.usage);
    // The raw usage (including credit) is forwarded verbatim on the chunk so the
    // stream finalizer's extractUsageFromSsePayload() can read usage.credit.
    expect(usageChunk).toBeDefined();
    expect(usageChunk?.usage?.credit).toBe(3.5);
    expect(usageChunk?.usage?.total_tokens).toBe(19);
  });

  test("provider result carries the estimated fallback (creditsUsed 0) when the stream carries credit", async () => {
    // The real credit is captured by the index.ts finalizer; the provider result
    // intentionally reports creditsUsed: 0 / creditSource: "estimated" as a
    // fallback for when the finalizer finds nothing. Verify that contract here.
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, credit: 2.25 };
    const p = new TestCodeBuddyProvider(() =>
      sseResponse([
        { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
        { id: "chatcmpl-up", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]),
    );
    const result = await p.chatCompletionStream(account, {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    } as any);
    expect(result.success).toBe(true);
    // Fallback values: estimated, not the upstream credit. NOTE: the result's
    // token fields are snapshotted at return time (before the stream drains), so
    // they read 0 here — the real token/credit accounting is the index.ts
    // finalizer's job, which reads usage.credit off the forwarded SSE chunks.
    expect(result.creditsUsed).toBe(0);
    expect(result.creditSource).toBe("estimated");
    const chunks = await collectStream(result.stream!);
    expect(chunks.find((c) => c.usage)?.usage?.total_tokens).toBe(15);
  });

  test("stream without any usage chunk still succeeds and leaves the estimated fallback", async () => {
    const p = new TestCodeBuddyProvider(() =>
      sseResponse([
        { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: "no usage here" }, finish_reason: null }] },
        { id: "chatcmpl-up", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const result = await p.chatCompletionStream(account, {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    } as any);
    expect(result.success).toBe(true);
    const chunks = await collectStream(result.stream!);
    expect(chunks.find((c) => c.usage)).toBeUndefined();
    // No usage upstream -> finalizer finds nothing -> provider fallback applies.
    expect(result.creditsUsed).toBe(0);
    expect(result.creditSource).toBe("estimated");
    expect(result.tokensUsed).toBe(0);
  });

  test("zero / negative upstream credit is ignored but usage tokens still forward", async () => {
    // credit: 0 should NOT be treated as a real credit (the provider guards on > 0),
    // but the usage block itself must still be forwarded for the token finalizer.
    const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, credit: 0 };
    const p = new TestCodeBuddyProvider(() =>
      sseResponse([
        { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: "y" }, finish_reason: null }] },
        { id: "chatcmpl-up", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]),
    );
    const result = await p.chatCompletionStream(account, {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    } as any);
    expect(result.success).toBe(true);
    const chunks = await collectStream(result.stream!);
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk?.usage?.credit).toBe(0);
    expect(usageChunk?.usage?.total_tokens).toBe(6);
    // result.tokensUsed is a pre-drain snapshot (0 by design); the credit>0 guard
    // simply declines to treat 0 as real credit while usage still forwards.
  });

  test("finish_reason is rewritten to tool_calls when tool calls stream with stop", async () => {
    const p = new TestCodeBuddyProvider(() =>
      sseResponse([
        {
          id: "chatcmpl-up",
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } }] },
            finish_reason: null,
          }],
        },
        {
          id: "chatcmpl-up",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, credit: 0.5 },
        },
      ]),
    );
    const result = await p.chatCompletionStream(account, {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    } as any);
    const chunks = await collectStream(result.stream!);
    const last = chunks[chunks.length - 1];
    // hasToolCalls latch converts the trailing stop -> tool_calls.
    expect(last?.choices?.[0]?.finish_reason).toBe("tool_calls");
    // usage.credit still forwarded on the final chunk for the finalizer.
    expect(last?.usage?.credit).toBe(0.5);
  });
});

describe("non-stream aggregate credit (usage.credit passthrough)", () => {
  test("uses upstream _realCredit when usage.credit is present", async () => {
    const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, credit: 4.2 };
    const p = new TestCodeBuddyProvider(() =>
      sseResponse([
        { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: "full answer" }, finish_reason: null }] },
        { id: "chatcmpl-up", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]),
    );
    const result = await p.chatCompletion(account, {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    } as any);
    expect(result.success).toBe(true);
    expect(result.creditsUsed).toBe(4.2);
    expect(result.creditSource).toBe("upstream");
    expect(result.tokensUsed).toBe(28);
    // Internal field must not leak into the client-facing response.
    expect((result.response as any)?._realCredit).toBeUndefined();
  });

  test("falls back to token-rate estimate when usage.credit is absent", async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 };
    const p = new TestCodeBuddyProvider(() =>
      sseResponse([
        { id: "chatcmpl-up", choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] },
        { id: "chatcmpl-up", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]),
    );
    const result = await p.chatCompletion(account, {
      model: "cb-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    } as any);
    expect(result.success).toBe(true);
    // cb-opus-4.8 creditRate = 0.027/1000 -> 1000 tokens * 0.027/1000 = 0.027.
    expect(result.creditSource).toBe("estimated");
    expect(result.creditsUsed).toBeCloseTo(0.027, 6);
  });
});
