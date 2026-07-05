import { describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import { CodexProvider } from "../../src/proxy/providers/codex";
import { openAIStreamToAnthropic } from "../../src/proxy/transforms/anthropic";

class TestCodexProvider extends CodexProvider {
  lastRequestBody: any;

  constructor(private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
    super();
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    this.lastRequestBody = JSON.parse(String(init.body || "{}"));
    return this.responder(url, init);
  }
}

const account = {
  id: 1,
  provider: "codex",
  email: "codex@test.local",
  tokens: { access_token: "access-token", account_id: "acct_1" },
} as Account;

function codexResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
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

async function collectAnthropicEvents(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    const data = dataLine.startsWith("data: ") ? dataLine.slice(6) : dataLine.slice(5);
    events.push({ event: eventLine.slice(7), data: JSON.parse(data) });
  }
  return events;
}

const functionCallEvents = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_project_structure", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path"' },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: ':"."}' },
  { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"."}' },
  {
    type: "response.completed",
    response: {
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "get_project_structure", arguments: '{"path":"."}' }],
      usage: { input_tokens: 12, output_tokens: 4 },
    },
  },
];

const reasoningEvents = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "reasoning", id: "rs_1", content: [], summary: [] },
  },
  { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
  { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "I should calculate. " },
  { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Then answer." },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "reasoning",
      id: "rs_1",
      content: [],
      summary: [{ type: "summary_text", text: "I should calculate. Then answer." }],
    },
  },
  { type: "response.output_text.delta", delta: "done" },
  { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 6 } } },
];

describe("CodexProvider streaming", () => {
  test("OpenAI-compatible stream emits text deltas", async () => {
    const provider = new TestCodexProvider(() => codexResponse([
      { type: "response.output_text.delta", delta: "stream" },
      { type: "response.output_text.delta", delta: "-ok" },
      { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 2 } } },
    ]));

    const result = await provider.chatCompletionStream(account, {
      model: "codex-gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "Say stream-ok" }],
    });

    expect(result.success).toBe(true);
    const chunks = await collectOpenAIStream(result.stream!);
    expect(chunks.map((chunk) => chunk.choices[0].delta.content || "").join("")).toBe("stream-ok");
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
  });

  test("OpenAI-compatible stream emits tool_calls and forwards tools", async () => {
    const provider = new TestCodexProvider(() => codexResponse(functionCallEvents));

    const result = await provider.chatCompletionStream(account, {
      model: "codex-gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "Use the tool" }],
      tools: [{ type: "function", function: { name: "get_project_structure", parameters: { type: "object", properties: {} } } }],
      tool_choice: { type: "function", function: { name: "get_project_structure" } },
    });

    expect(result.success).toBe(true);
    expect(provider.lastRequestBody.tools).toEqual([
      { type: "function", name: "get_project_structure", description: "", parameters: { type: "object", properties: {} } },
    ]);
    const chunks = await collectOpenAIStream(result.stream!);
    const toolName = chunks.find((chunk) => chunk.choices[0].delta.tool_calls?.[0]?.function?.name)
      ?.choices[0].delta.tool_calls[0].function.name;
    const args = chunks
      .map((chunk) => chunk.choices[0].delta.tool_calls?.[0]?.function?.arguments || "")
      .join("");
    expect(toolName).toBe("get_project_structure");
    expect(args).toBe('{"path":"."}');
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("tool_calls");
  });

  test("OpenAI-compatible stream maps Codex reasoning summaries to reasoning_content", async () => {
    const provider = new TestCodexProvider(() => codexResponse(reasoningEvents));

    const result = await provider.chatCompletionStream(account, {
      model: "codex-gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "Calculate this" }],
      reasoning_effort: "high",
    });

    expect(result.success).toBe(true);
    expect(provider.lastRequestBody.reasoning).toEqual({ effort: "high", summary: "auto" });

    const chunks = await collectOpenAIStream(result.stream!);
    const reasoning = chunks
      .map((chunk) => chunk.choices[0].delta.reasoning_content || "")
      .join("");
    const text = chunks.map((chunk) => chunk.choices[0].delta.content || "").join("");
    expect(reasoning).toBe("I should calculate. Then answer.");
    expect(text).toBe("done");
  });

  test("Anthropic stream emits reasoning as a thinking block when thinking is enabled", async () => {
    const provider = new TestCodexProvider(() => codexResponse(reasoningEvents));
    const result = await provider.chatCompletionStream(account, {
      model: "codex-gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "Calculate this" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    });

    expect(result.success).toBe(true);
    const anthropic = openAIStreamToAnthropic(result.stream!, {
      model: "claude-opus-4-8",
      stream: true,
      max_tokens: 128,
      thinking: { type: "enabled", budget_tokens: 4096 },
      messages: [{ role: "user", content: "Calculate this" }],
    });
    const events = await collectAnthropicEvents(anthropic);

    // With thinking enabled, reasoning becomes a `thinking` block (rendered
    // separately by Claude Code) — it must NOT leak into text deltas.
    const thinkingStart = events.find((item) => item.event === "content_block_start" && item.data.content_block?.type === "thinking");
    expect(thinkingStart).toBeDefined();
    const thinkingDelta = events.find((item) => item.event === "content_block_delta" && item.data.delta?.type === "thinking_delta");
    // Reasoning may stream across multiple thinking_delta chunks — aggregate.
    const thinkingText = events
      .filter((item) => item.event === "content_block_delta" && item.data.delta?.type === "thinking_delta")
      .map((item) => item.data.delta.thinking)
      .join("");
    expect(thinkingText).toContain("I should calculate. Then answer.");
    expect(thinkingDelta).toBeDefined();
    // A signature_delta is emitted before the block closes.
    const signature = events.find((item) => item.event === "content_block_delta" && item.data.delta?.type === "signature_delta");
    // The signature is now a deterministic SHA-256 hash of the thinking content
    // (not a static placeholder) so it round-trips correctly across turns.
    expect(signature?.data.delta.signature).toBeTruthy();
    expect(signature?.data.delta.signature).not.toBe("");

    // The reasoning text must NOT appear in the text deltas (no leak).
    const text = events
      .filter((item) => item.event === "content_block_delta" && item.data.delta?.type === "text_delta")
      .map((item) => item.data.delta.text)
      .join("");
    expect(text).not.toContain("I should calculate");
  });

  test("Anthropic stream converts Codex tool_calls into tool_use", async () => {
    const provider = new TestCodexProvider(() => codexResponse(functionCallEvents));
    const result = await provider.chatCompletionStream(account, {
      model: "codex-gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "Use the tool" }],
      tools: [{ type: "function", function: { name: "get_project_structure", parameters: { type: "object", properties: {} } } }],
    });

    expect(result.success).toBe(true);
    const anthropic = openAIStreamToAnthropic(result.stream!, {
      model: "claude-opus-4-8",
      stream: true,
      max_tokens: 128,
      messages: [{ role: "user", content: "Use the tool" }],
    });
    const events = await collectAnthropicEvents(anthropic);
    const start = events.find((item) => item.event === "content_block_start" && item.data.content_block?.type === "tool_use");
    const args = events
      .filter((item) => item.event === "content_block_delta" && item.data.delta?.type === "input_json_delta")
      .map((item) => item.data.delta.partial_json)
      .join("");
    const messageDelta = events.find((item) => item.event === "message_delta");

    expect(start?.data.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "get_project_structure" });
    expect(args).toBe('{"path":"."}');
    expect(messageDelta?.data.delta.stop_reason).toBe("tool_use");
  });
});
