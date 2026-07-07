import { describe, test, expect } from "bun:test";
import { kiroEventToOpenAIChunk, kiroResponseToOpenAI } from "./kiro";

describe("kiroEventToOpenAIChunk", () => {
  test("parses assistantResponseEvent text delta", () => {
    const state: any = { responseId: "r", created: 1, model: "kiro", content: "", reasoning: "", toolCalls: [], finishReason: null };
    const raw = `event:assistantResponseEvent\ndata:${JSON.stringify({ content: "Hello" })}`;
    const chunk: any = kiroEventToOpenAIChunk(raw, state);
    expect(chunk).not.toBeNull();
    expect(chunk.choices[0].delta.content).toBe("Hello");
    expect(state.content).toBe("Hello");
  });

  test("parses codeEvent as content", () => {
    const state: any = { responseId: "r", created: 1, model: "kiro", content: "", reasoning: "", toolCalls: [], finishReason: null };
    const chunk: any = kiroEventToOpenAIChunk(`event:codeEvent\ndata:${JSON.stringify({ code: "print('hi')" })}`, state);
    expect(chunk.choices[0].delta.content).toBe("print('hi')");
  });

  test("returns null for empty/garbage input", () => {
    const state: any = { responseId: "r", created: 1, model: "kiro", content: "", reasoning: "", toolCalls: [], finishReason: null };
    expect(kiroEventToOpenAIChunk("", state)).toBeNull();
    expect(kiroEventToOpenAIChunk(null as any, state)).toBeNull();
  });
});

describe("kiroResponseToOpenAI (non-stream)", () => {
  test("assembles events into a single completion", () => {
    const resp = [
      { _eventType: "assistantResponseEvent", content: "Hello " },
      { _eventType: "assistantResponseEvent", content: "world" },
      { _eventType: "messageMetadataEvent", usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
    ];
    const r: any = kiroResponseToOpenAI(resp, "kiro");
    expect(r.object).toBe("chat.completion");
    expect(r.choices[0].message.content).toBe("Hello world");
    expect(r.usage.total_tokens).toBe(5);
  });
});
