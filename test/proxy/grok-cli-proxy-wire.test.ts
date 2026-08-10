import { describe, expect, test } from "bun:test";
import {
  buildCliProxyHeaders,
  chatToCliResponsesBody,
  responsesSseToChatCompletionStream,
} from "../../src/proxy/providers/grok/cli-proxy-wire";
import { getGrokCliVersion } from "../../src/proxy/providers/grok/oauth";

describe("cli-proxy wire (CLI 0.2.106 parity)", () => {
  test("headers include required X-XAI-Token-Auth and model override", async () => {
    const h = await buildCliProxyHeaders("test-token", {
      modelOverride: "grok-4.5",
      accept: "text/event-stream",
    });
    expect(h.Authorization).toBe("Bearer test-token");
    expect(h["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(h["x-grok-model-override"]).toBe("grok-4.5");
    expect(h["x-grok-client-surface"]).toBe("grok-shell");
    expect(h["x-grok-client-identifier"]).toBe("grok-build");
    expect(h["x-grok-client-version"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(h.Accept).toBe("text/event-stream");
  });

  test("getGrokCliVersion is automatic (disk/remote) and never throws", async () => {
    const v = await getGrokCliVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    // On this machine the CLI is installed → should resolve real install, not 0.0.0.
    // Soft check: just ensure we got something.
    expect(v.length).toBeGreaterThan(0);
  });

  test("chatToCliResponsesBody maps messages + tools to Responses shape", () => {
    const body = chatToCliResponsesBody(
      {
        model: "grok-4.5",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "d",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        max_tokens: 64,
        stream: true,
      },
      "grok-4.5",
      { stream: true, reasoningEffort: "low" },
    );
    expect(body.model).toBe("grok-4.5");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("Be brief.");
    expect(body.reasoning_effort).toBe("low");
    // Responses endpoints hide reasoning unless a summary is requested.
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(body.max_output_tokens).toBe(64);
    expect(Array.isArray(body.input)).toBe(true);
    const input = body.input as any[];
    expect(input[0].role).toBe("user");
    expect(input[0].content[0].type).toBe("input_text");
    expect(input[0].content[0].text).toBe("Hello");
    const tools = body.tools as any[];
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("lookup");
    expect(tools[0].function).toBeUndefined();
  });

  test("responsesSseToChatCompletionStream maps text + usage", async () => {
    const sse = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"!"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n\n',
    ].join("");
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
    const out = responsesSseToChatCompletionStream(upstream, {
      id: "chatcmpl-test",
      created: 1,
      model: "grok-4.5",
      onUsage: (u) => {
        usage = u;
      },
    });
    const reader = out.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain('"content":"!"');
    expect(text).toContain("[DONE]");
    expect(usage as unknown).toEqual({ prompt_tokens: 10, completion_tokens: 2 });
  });

  test("reasoning deltas become reasoning_content", async () => {
    const sse =
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    const out = responsesSseToChatCompletionStream(upstream, {
      id: "x",
      created: 1,
      model: "grok-4.5",
    });
    const reader = out.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("reasoning_content");
    expect(text).toContain("think");
  });

  test("xAI response.reasoning_text.delta events also become reasoning_content", async () => {
    const sse =
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"17*23"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    const out = responsesSseToChatCompletionStream(upstream, {
      id: "x",
      created: 1,
      model: "grok-4.5",
    });
    const reader = out.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("reasoning_content");
    expect(text).toContain("17*23");
  });

  test("reasoning summary in completed output item is surfaced when no delta streamed", async () => {
    const completed = {
      type: "response.completed",
      response: {
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "computed 17*23=391" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "391" }] },
        ],
      },
    };
    const sse =
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"391"}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    const out = responsesSseToChatCompletionStream(upstream, {
      id: "x",
      created: 1,
      model: "grok-4.5",
    });
    const reader = out.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("computed 17*23=391");
  });

  test("output_item.done reasoning summary is surfaced mid-stream (Codex-style path)", async () => {
    const sse =
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "I should calculate then answer." }],
        },
      })}\n\n` +
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"391"}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    const out = responsesSseToChatCompletionStream(upstream, {
      id: "x",
      created: 1,
      model: "grok-4.5",
    });
    const reader = out.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("reasoning_content");
    expect(text).toContain("I should calculate then answer.");
    expect(text).toContain('"content":"391"');
  });

  test("reasoning_summary_text.done fills in when deltas never arrived", async () => {
    const sse =
      `event: response.reasoning_summary_text.done\ndata: ${JSON.stringify({
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        text: "full summary without deltas",
      })}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    const out = responsesSseToChatCompletionStream(upstream, {
      id: "x",
      created: 1,
      model: "grok-4.5",
    });
    const reader = out.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("full summary without deltas");
  });

  test("chatToCliResponsesBody always requests summary:auto for default high effort", () => {
    const body = chatToCliResponsesBody(
      {
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      "grok-4.5",
      { stream: true },
    );
    // No client effort → still force high + summary so the stream is visible.
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });
});
