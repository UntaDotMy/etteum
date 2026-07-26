/**
 * §4.2; openAIStreamToAnthropic clobbered stop_reason.
 *
 * The non-stream path (mapFinishReasonToStopReason) documents that hasToolCalls
 * must win because upstreams routinely send finish_reason:"stop" alongside
 * tool_calls. The streaming path passed hasToolCalls=false unconditionally, so
 * a tool_use block arrived with stop_reason:"end_turn" and Claude Code ended
 * the turn instead of running the tool.
 *
 * §6.4; an `error` event is terminal; no deltas may trail it.
 */
import { describe, test, expect } from "bun:test";
import { openAIStreamToAnthropic } from "../../src/proxy/transforms/anthropic";
import type { AnthropicMessagesRequest } from "../../src/proxy/transforms/anthropic";

function mockOpenAIStream(chunks: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<any[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      if (!data || data === "[DONE]") continue;
      try { events.push(JSON.parse(data)); } catch { /* ignore */ }
    }
  }
  return events;
}

const req: AnthropicMessagesRequest = {
  model: "claude-sonnet-4.6",
  messages: [{ role: "user", content: "list files" }],
  max_tokens: 1024,
};

const toolCallChunk = {
  choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: '{"cmd":"ls"}' } }] } }],
};

describe("openAIStreamToAnthropic — stop_reason vs tool_calls", () => {
  test('finish_reason "stop" after tool_calls still yields stop_reason tool_use', async () => {
    const events = await drain(openAIStreamToAnthropic(mockOpenAIStream([
      toolCallChunk,
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]), req));
    const started = events.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(started.length).toBe(1);
    const delta = events.find((e) => e.type === "message_delta");
    expect(delta?.delta?.stop_reason).toBe("tool_use");
  });

  test('finish_reason "tool_calls" still yields tool_use', async () => {
    const events = await drain(openAIStreamToAnthropic(mockOpenAIStream([
      toolCallChunk,
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]), req));
    expect(events.find((e) => e.type === "message_delta")?.delta?.stop_reason).toBe("tool_use");
  });

  test('finish_reason "length" after tool_calls still yields tool_use', async () => {
    const events = await drain(openAIStreamToAnthropic(mockOpenAIStream([
      toolCallChunk,
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]), req));
    expect(events.find((e) => e.type === "message_delta")?.delta?.stop_reason).toBe("tool_use");
  });

  test("text-only stream is unaffected: stop → end_turn", async () => {
    const events = await drain(openAIStreamToAnthropic(mockOpenAIStream([
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]), req));
    expect(events.find((e) => e.type === "message_delta")?.delta?.stop_reason).toBe("end_turn");
  });

  test("text-only stream: length → max_tokens", async () => {
    const events = await drain(openAIStreamToAnthropic(mockOpenAIStream([
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]), req));
    expect(events.find((e) => e.type === "message_delta")?.delta?.stop_reason).toBe("max_tokens");
  });
});

describe("openAIStreamToAnthropic — terminal error (§6.4)", () => {
  test("no content deltas or message_stop follow a terminal error event", async () => {
    const events = await drain(openAIStreamToAnthropic(mockOpenAIStream([
      { choices: [{ delta: { content: "partial" } }] },
      { error: { message: "upstream exploded" } },
      { choices: [{ delta: { content: "should never be forwarded" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]), req));

    const errIdx = events.findIndex((e) => e.type === "error");
    expect(errIdx).toBeGreaterThanOrEqual(0);
    const after = events.slice(errIdx + 1);
    expect(after.some((e) => e.type === "content_block_delta")).toBe(false);
    expect(after.some((e) => e.type === "message_delta")).toBe(false);
    expect(after.some((e) => e.type === "message_stop")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("should never be forwarded");
  });
});
