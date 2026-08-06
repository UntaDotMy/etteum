import { describe, expect, test } from "bun:test";

process.env.ENCRYPTION_KEY = "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { commandCodeEventToOpenAIChunk } from "../../src/proxy/providers/commandcode/provider";
import type { StreamChunk } from "../../src/proxy/providers/base";

const MODEL = "gpt-5.3-codex";

interface TestState {
  responseId: string;
  created: number;
  model: string;
  chunkIndex: number;
  toolIndex: number;
  toolIndexById: Map<string, number>;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  openText: boolean;
}

function freshState(): TestState {
  return {
    responseId: "",
    created: 0,
    model: MODEL,
    chunkIndex: 0,
    toolIndex: 0,
    toolIndexById: new Map(),
    finishReason: null,
    usage: null,
    openText: false,
  };
}

/** Feed a sequence of NDJSON events through the translator, collecting all chunks. */
function feed(events: unknown[], state = freshState()): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (const e of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = commandCodeEventToOpenAIChunk(e as any, state as any);
    if (chunks) out.push(...chunks);
  }
  return out;
}

/** reasoning_content is an extension the translator adds beyond the base ChatMessage shape. */
function reasoningOf(chunk: StreamChunk | undefined): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (chunk?.choices[0]?.delta as any)?.reasoning_content || "";
}

describe("commandCodeEventToOpenAIChunk (NDJSON -> OpenAI translator)", () => {
  test("streams text deltas as OpenAI content chunks with role on first chunk", () => {
    const chunks = feed([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", text: "Hello, " },
      { type: "text-delta", text: "world!" },
      { type: "finish-step", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } },
      { type: "finish", totalUsage: { inputTokens: 10, outputTokens: 2 } },
    ]);

    const content = chunks.map((c) => c.choices[0]?.delta?.content || "").join("");
    expect(content).toBe("Hello, world!");
    // First emitted chunk carries the role.
    expect(chunks[0]?.choices[0]?.delta?.role).toBe("assistant");
    // Role appears exactly once.
    expect(chunks.filter((c) => c.choices[0]?.delta?.role).length).toBe(1);
    // State-derived chunk fields.
    expect(chunks[0]?.object).toBe("chat.completion.chunk");
    expect(chunks[0]?.model).toBe(MODEL);
    expect(chunks[0]?.id).toMatch(/^chatcmpl-\d+$/);
    // Final chunk carries finish_reason + usage.
    const last = chunks.at(-1);
    expect(last?.choices[0]?.finish_reason).toBe("stop");
    expect(last?.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });
  });

  test("streams reasoning deltas as reasoning_content", () => {
    const chunks = feed([
      { type: "start" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", text: "Thinking... " },
      { type: "reasoning-delta", text: "done." },
      { type: "text-start", id: "t1" },
      { type: "text-delta", text: "answer" },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish" },
    ]);

    const reasoning = chunks.map((c) => reasoningOf(c)).join("");
    const content = chunks.map((c) => c.choices[0]?.delta?.content || "").join("");
    expect(reasoning).toBe("Thinking... done.");
    expect(content).toBe("answer");
    // Reasoning comes first, so the first chunk carries the role.
    expect(chunks[0]?.choices[0]?.delta?.role).toBe("assistant");
    expect(reasoningOf(chunks[0])).toBe("Thinking... ");
  });

  test("tool-input-start/delta assembles a tool_call; tool-call event with same id is deduped", () => {
    const chunks = feed([
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start", id: "tc_1", toolName: "run_command" },
      { type: "tool-input-delta", id: "tc_1", delta: '{"cmd":"ls ' },
      { type: "tool-input-delta", id: "tc_1", delta: '-la"}' },
      { type: "tool-input-end", id: "tc_1" },
      // The final consolidated tool-call repeats the same id — translator
      // must NOT re-emit it (deltas already streamed).
      { type: "tool-call", toolCallId: "tc_1", toolName: "run_command", input: { cmd: "ls -la" } },
      { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 3 } },
      { type: "finish", totalUsage: { inputTokens: 5, outputTokens: 3 } },
    ]);

    // Name emitted once (on tool-input-start).
    const nameChunks = chunks.filter((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.name);
    expect(nameChunks.length).toBe(1);
    expect(nameChunks[0]?.choices[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("run_command");
    expect(nameChunks[0]?.choices[0]?.delta?.tool_calls?.[0]?.id).toBe("tc_1");
    expect(nameChunks[0]?.choices[0]?.delta?.tool_calls?.[0]?.type).toBe("function");
    expect(nameChunks[0]?.choices[0]?.delta?.tool_calls?.[0]?.index).toBe(0);
    // Arguments streamed via deltas only.
    const args = chunks
      .map((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments || "")
      .join("");
    expect(args).toBe('{"cmd":"ls -la"}');
    // finish_reason maps tool-calls -> tool_calls.
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("standalone tool-call (no prior tool-input-start) emits full call in one chunk", () => {
    const chunks = feed([
      { type: "start" },
      { type: "tool-call", toolCallId: "call_abc", toolName: "read_file", input: { path: "a.ts" } },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "finish" },
    ]);

    const withCall = chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.name);
    expect(withCall?.choices[0]?.delta?.tool_calls?.[0]?.id).toBe("call_abc");
    expect(withCall?.choices[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("read_file");
    expect(withCall?.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe('{"path":"a.ts"}');
    // First chunk of the stream carries the role.
    expect(withCall?.choices[0]?.delta?.role).toBe("assistant");
  });

  test("multiple sequential tool calls get distinct incremental indexes", () => {
    const chunks = feed([
      { type: "start" },
      { type: "tool-input-start", id: "tc_1", toolName: "read_file" },
      { type: "tool-input-delta", id: "tc_1", delta: '{"path":"a.ts"}' },
      { type: "tool-input-start", id: "tc_2", toolName: "write_file" },
      { type: "tool-input-delta", id: "tc_2", delta: '{"path":"b.ts"}' },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "finish" },
    ]);

    const starts = chunks
      .flatMap((c) => c.choices[0]?.delta?.tool_calls || [])
      .filter((t: { function?: { name?: string } }) => t.function?.name);
    expect(starts.map((t: { function?: { name?: string } }) => t.function?.name)).toEqual(["read_file", "write_file"]);
    expect(starts.map((t: { index?: number }) => t.index)).toEqual([0, 1]);
    expect(starts.map((t: { id?: string }) => t.id)).toEqual(["tc_1", "tc_2"]);
    // Each delta targets the right index.
    const deltas = chunks
      .flatMap((c) => c.choices[0]?.delta?.tool_calls || [])
      .filter((t: { function?: { arguments?: string } }) => t.function?.arguments);
    expect(deltas.map((t: { index?: number }) => t.index)).toEqual([0, 1]);
  });

  test("maps finish reasons: tool-calls->tool_calls, length->length, unknown->stop", () => {
    const cases: Array<[string, string]> = [
      ["tool-calls", "tool_calls"],
      ["tool_use", "tool_calls"],
      ["length", "length"],
      ["max-tokens", "length"],
      ["stop", "stop"],
      ["something-unexpected", "stop"],
      ["error", "stop"],
    ];
    for (const [upstream, expected] of cases) {
      const chunks = feed([
        { type: "text-delta", text: "x" },
        { type: "finish-step", finishReason: upstream },
        { type: "finish" },
      ]);
      expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe(expected);
    }
  });

  test("finish without finish-step defaults to stop; null finishReason yields null", () => {
    const stopChunks = feed([{ type: "text-delta", text: "x" }, { type: "finish" }]);
    expect(stopChunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");

    // finish-step with no finishReason sets null; finish event then defaults to "stop"
    const chunks = feed([
      { type: "text-delta", text: "x" },
      { type: "finish-step" },
      { type: "finish" },
    ]);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  test("error event emits content notice chunk followed by stop chunk", () => {
    const chunks = feed([
      { type: "start" },
      { type: "text-delta", text: "partial" },
      { type: "error", error: "credit limit reached" },
    ]);

    expect(chunks.length).toBe(3);
    expect(chunks[1]?.choices[0]?.delta?.content).toBe("\n\n[CommandCode error: credit limit reached]");
    expect(chunks[2]?.choices[0]?.finish_reason).toBe("stop");
  });

  test("error event with object payload is JSON-stringified", () => {
    const chunks = feed([{ type: "error", error: { code: 429, msg: "slow down" } }]);
    expect(chunks[0]?.choices[0]?.delta?.content).toBe(
      '\n\n[CommandCode error: {"code":429,"msg":"slow down"}]',
    );
  });

  test("finish-step usage beats finish totalUsage; totalTokens respected when present", () => {
    const chunks = feed([
      { type: "text-delta", text: "ok" },
      { type: "finish-step", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 42 } },
      { type: "finish", totalUsage: { inputTokens: 99, outputTokens: 99 } },
    ]);
    const last = chunks.at(-1);
    // totalUsage on finish wins (event.totalUsage || state.usage), but here
    // finish has totalUsage so it takes precedence.
    expect(last?.usage?.prompt_tokens).toBe(99);
    expect(last?.usage?.completion_tokens).toBe(99);
    expect(last?.usage?.total_tokens).toBe(198);
  });

  test("finish falls back to finish-step usage when finish has no totalUsage", () => {
    const chunks = feed([
      { type: "text-delta", text: "ok" },
      { type: "finish-step", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 42 } },
      { type: "finish" },
    ]);
    const last = chunks.at(-1);
    expect(last?.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 5,
      total_tokens: 42,
    });
  });

  test("zero usage yields no usage field on final chunk", () => {
    const chunks = feed([
      { type: "text-delta", text: "ok" },
      { type: "finish-step", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "finish", totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(chunks.at(-1)?.usage).toBeUndefined();
  });

  test("unknown event types are silently ignored", () => {
    const chunks = feed([
      { type: "start" },
      { type: "source", sourceType: "url", url: "https://example.com" },
      { type: "file", mediaType: "image/png", data: "..." },
      { type: "provider-metadata", foo: 1 },
      { type: "text-delta", text: "fine" },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish" },
    ]);
    const content = chunks.map((c) => c.choices[0]?.delta?.content || "").join("");
    expect(content).toBe("fine");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  test("empty text deltas are dropped", () => {
    const chunks = feed([
      { type: "text-delta", text: "" },
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "" },
      { type: "finish" },
    ]);
    const content = chunks.map((c) => c.choices[0]?.delta?.content || "").join("");
    expect(content).toBe("a");
    // Only one content chunk + final chunk.
    expect(chunks.length).toBe(2);
  });

  test("parses raw string lines, data:-prefixed lines, and skips blanks/[DONE]", () => {
    const state = freshState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = state as any;
    expect(commandCodeEventToOpenAIChunk("", s)).toBeNull();
    expect(commandCodeEventToOpenAIChunk("   ", s)).toBeNull();
    expect(commandCodeEventToOpenAIChunk("data: [DONE]", s)).toBeNull();
    expect(commandCodeEventToOpenAIChunk("{not json", s)).toBeNull();

    const fromPlain = commandCodeEventToOpenAIChunk('{"type":"text-delta","text":"hi"}', s);
    expect(fromPlain?.[0]?.choices[0]?.delta?.content).toBe("hi");
    // data:-prefixed line also parses.
    const fromPrefixed = commandCodeEventToOpenAIChunk('data: {"type":"text-delta","text":"yo"}', s);
    expect(fromPrefixed?.[0]?.choices[0]?.delta?.content).toBe("yo");
  });

  test("already-OpenAI chunks pass through untouched", () => {
    const openaiChunk: StreamChunk = {
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { content: "z" }, finish_reason: null }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = commandCodeEventToOpenAIChunk(openaiChunk as any, freshState() as any);
    expect(out?.[0]).toEqual(openaiChunk);
  });

  test("tool-input-delta without matching tool-input-start is dropped", () => {
    const chunks = feed([
      { type: "tool-input-delta", id: "ghost", delta: "{}" },
      { type: "text-delta", text: "x" },
      { type: "finish" },
    ]);
    const args = chunks
      .map((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments || "")
      .join("");
    expect(args).toBe("");
  });
});
