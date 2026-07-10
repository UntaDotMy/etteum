/**
 * F15: streaming tool-call arguments with Windows paths must survive the
 * OpenAI→Anthropic stream transform intact.
 *
 * Claude Code (Anthropic CLI, stream:true) accumulates all input_json_delta
 * partial_json fragments per tool_use block, concatenates them, and JSON.parses
 * the result. If the upstream OpenAI provider emits tool arguments with
 * UNESCAPED Windows backslashes (C:\Users\test → \t becomes a tab, \b backspace,
 * \n newline), the assembled JSON is corrupt and the tool call fails.
 *
 * The non-streaming path already uses safeJsonParse (anthropic.ts:743). This
 * test pins the STREAMING path (openAIStreamToAnthropic → input_json_delta).
 *
 * Per Anthropic streaming spec: individual partial_json fragments are NOT valid
 * JSON on their own — only the concatenated result is parseable. So the fix
 * accumulates the full arguments per tool call and emits them as a single
 * escaped input_json_delta, which concatenates fine (one fragment = degenerate
 * case of the concatenation rule).
 */
import { describe, test, expect } from "bun:test";
import { openAIStreamToAnthropic } from "../../src/proxy/transforms/anthropic";
import type { AnthropicMessagesRequest } from "../../src/proxy/transforms/anthropic";

/** Build a mock OpenAI SSE stream from an array of delta chunks. */
function mockOpenAIStream(chunks: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

/** Drain an Anthropic SSE stream into a parsed list of events. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<any[]> {
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
      const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.startsWith("data: ") ? dataLine.slice(6) : dataLine.slice(5);
      if (!data || data === "[DONE]") continue;
      try { events.push(JSON.parse(data)); } catch {}
    }
  }
  return events;
}

const baseReq: AnthropicMessagesRequest = {
  model: "claude-sonnet-4.6",
  messages: [{ role: "user", content: "list files" }],
  max_tokens: 1024,
};

describe("openAIStreamToAnthropic — tool call args with Windows paths", () => {
  test("correctly-escaped backslashes pass through and parse to the right path", async () => {
    // Upstream emits VALID JSON: backslashes already doubled.
    const stream = mockOpenAIStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "{\"command\":\"ls C:\\\\Users\\\\HP\\\\test\"}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "" } }] }, finish_reason: "tool_calls" }] },
    ]);
    const events = await drainStream(openAIStreamToAnthropic(stream, baseReq));
    const partials = events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json);
    const assembled = partials.join("");
    const parsed = JSON.parse(assembled);
    expect(parsed.command).toBe("ls C:\\Users\\HP\\test");
  });

  test("UNESCAPED backslashes (Windows path) are repaired so Claude Code can parse them", async () => {
    // Upstream emits BROKEN JSON: C:\Users\HP\test — \t would corrupt to a tab.
    // The proxy must repair this so the assembled partial_json is valid JSON.
    const stream = mockOpenAIStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "{\"command\":\"ls C:\\Users\\HP\\test\"}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "" } }] }, finish_reason: "tool_calls" }] },
    ]);
    const events = await drainStream(openAIStreamToAnthropic(stream, baseReq));
    const partials = events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json);
    const assembled = partials.join("");
    // Must parse without throwing AND yield the literal Windows path.
    const parsed = JSON.parse(assembled);
    expect(parsed.command).toBe("ls C:\\Users\\HP\\test");
  });

  test("multi-fragment tool args across chunks assemble correctly with a Windows path", async () => {
    // Real upstreams stream args in fragments. The path is split across chunks.
    const stream = mockOpenAIStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{\"path\":\"C:" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\\Users\\HP\\" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "test.ts\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await drainStream(openAIStreamToAnthropic(stream, baseReq));
    const partials = events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json);
    const assembled = partials.join("");
    const parsed = JSON.parse(assembled);
    expect(parsed.path).toBe("C:\\Users\\HP\\test.ts");
  });
});
