import { describe, test, expect } from "bun:test";
import { geminiToOpenAI, geminiStreamToOpenAIStream } from "./gemini";

describe("geminiToOpenAI (response)", () => {
  test("converts a text response", () => {
    const gemini = {
      candidates: [{ content: { parts: [{ text: "Hello" }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    };
    const r: any = geminiToOpenAI(gemini, "gemini-2.5-pro");
    expect(r.object).toBe("chat.completion");
    expect(r.model).toBe("gemini-2.5-pro");
    expect(r.choices[0].message.content).toBe("Hello");
    expect(r.choices[0].finish_reason).toBe("stop");
    expect(r.usage.total_tokens).toBe(7);
  });

  test("converts functionCall to tool_calls", () => {
    const gemini = {
      candidates: [{
        content: { parts: [{ functionCall: { name: "Read", args: { path: "x.ts" } } }], role: "model" },
        finishReason: "STOP",
      }],
    };
    const r: any = geminiToOpenAI(gemini, "m");
    expect(r.choices[0].message.tool_calls[0].function.name).toBe("Read");
    expect(r.choices[0].message.tool_calls[0].function.arguments).toBe(JSON.stringify({ path: "x.ts" }));
  });

  test("maps finishReason: MAX_TOKENS → length, SAFETY → content_filter", () => {
    expect((geminiToOpenAI({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] }, "m") as any).choices[0].finish_reason).toBe("length");
    expect((geminiToOpenAI({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "SAFETY" }] }, "m") as any).choices[0].finish_reason).toBe("content_filter");
  });
});

describe("geminiStreamToOpenAIStream", () => {
  test("converts Gemini stream chunks to OpenAI SSE chunks", async () => {
    const encoder = new TextEncoder();
    const geminiStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }], role: "model" } }] })));
        controller.enqueue(encoder.encode(JSON.stringify({ candidates: [{ content: { parts: [{ text: " there" }] }, finishReason: "STOP" }] })));
        controller.close();
      },
    });
    const openaiStream = geminiStreamToOpenAIStream(geminiStream, "gemini-2.5-pro");
    const reader = openaiStream.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    let done = false;
    while (!done) {
      const { done: d, value } = await reader.read();
      done = d;
      if (value) collected += decoder.decode(value, { stream: true });
    }
    const lines = collected.split("\n\n").map((l) => l.trim()).filter((l) => l.startsWith("data:") && !l.includes("[DONE]"));
    const chunks = lines.map((l) => JSON.parse(l.replace(/^data:\s*/, "")));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const text = chunks.map((c: any) => c.choices[0]?.delta?.content || "").join("");
    expect(text).toBe("Hi there");
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
  });
});
