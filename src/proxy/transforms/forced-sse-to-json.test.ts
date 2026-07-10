import { describe, test, expect } from "bun:test";
import { forcedSseToJson } from "./forced-sse-to-json";

/** Build an SSE ReadableStream from an array of data-payload strings. */
function sseStream(payloads: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of payloads) {
        controller.enqueue(encoder.encode(`data: ${p}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("forcedSseToJson", () => {
  test("assembles delta.content across chunks into a single message", async () => {
    const stream = sseStream([
      JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "Hello" } }] }),
      JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: ", " } }] }),
      JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "world!" }, finish_reason: "stop" }] }),
    ]);
    const result: any = await forcedSseToJson(stream, "test-model");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("test-model");
    expect(result.choices[0].message.content).toBe("Hello, world!");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  test("accumulates reasoning_content separately", async () => {
    const stream = sseStream([
      JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] }),
      JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }),
    ]);
    const result: any = await forcedSseToJson(stream, "m");
    expect(result.choices[0].message.content).toBe("answer");
    expect(result.choices[0].message.reasoning_content).toBe("thinking...");
  });

  test("assembles tool_calls across chunks by index", async () => {
    const stream = sseStream([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "{\"path\":" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: " \"x.ts\"}" } }] }, finish_reason: "tool_calls" }] }),
    ]);
    const result: any = await forcedSseToJson(stream, "m");
    const tc = result.choices[0].message.tool_calls[0];
    expect(tc.id).toBe("call_1");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("Read");
    expect(tc.function.arguments).toBe('{"path":"x.ts"}');
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  test("captures usage when present", async () => {
    const stream = sseStream([
      JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
    ]);
    const result: any = await forcedSseToJson(stream, "m");
    expect(result.usage.prompt_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(7);
  });
});
