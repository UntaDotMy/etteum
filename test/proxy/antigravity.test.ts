import { describe, expect, test } from "bun:test";
import {
  parseLoadCodeAssist,
  parseModelsResponse,
  openAIToGemini,
  extractGeminiParts,
} from "../../src/proxy/providers/antigravity";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";

// ── parseLoadCodeAssist ────────────────────────────────────────────────────

describe("parseLoadCodeAssist", () => {
  test("projectId as a string + planInfo credits", () => {
    const data = {
      cloudaicompanionProject: "proj-123",
      planInfo: { planType: "STANDARD", monthlyPromptCredits: 500 },
      availablePromptCredits: 320,
    };
    const u = parseLoadCodeAssist(data);
    expect(u.projectId).toBe("proj-123");
    expect(u.planType).toBe("STANDARD");
    expect(u.monthlyPromptCredits).toBe(500);
    expect(u.availablePromptCredits).toBe(320);
  });

  test("projectId as an object {id} (the other real shape)", () => {
    const data = {
      cloudaicompanionProject: { id: "proj-obj-456" },
      planInfo: { planType: "FREE", monthlyPromptCredits: 50 },
      availablePromptCredits: 50,
    };
    expect(parseLoadCodeAssist(data).projectId).toBe("proj-obj-456");
    expect(parseLoadCodeAssist(data).planType).toBe("FREE");
  });

  test("exhausted: available credits zero with a real limit", () => {
    const u = parseLoadCodeAssist({
      cloudaicompanionProject: "p",
      planInfo: { planType: "PRO", monthlyPromptCredits: 1000 },
      availablePromptCredits: 0,
    });
    expect(u.availablePromptCredits).toBe(0);
    expect(u.monthlyPromptCredits).toBe(1000);
  });

  test("degrades gracefully on empty/malformed", () => {
    const u = parseLoadCodeAssist({});
    expect(u.projectId).toBeNull();
    expect(u.planType).toBe("");
    expect(u.monthlyPromptCredits).toBe(0);
    expect(u.availablePromptCredits).toBe(0);
  });
});

// ── parseModelsResponse ────────────────────────────────────────────────────

describe("parseModelsResponse", () => {
  test("objects with name field", () => {
    const data = { models: [{ name: "gemini-3-pro" }, { name: "gemini-3-pro-high" }] };
    expect(parseModelsResponse(data)).toEqual(["gemini-3-pro", "gemini-3-pro-high"]);
  });

  test("plain string array", () => {
    expect(parseModelsResponse({ models: ["gemini-3-flash", "gemini-3-pro"] })).toEqual(["gemini-3-flash", "gemini-3-pro"]);
  });

  test("empty / malformed", () => {
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ models: "nope" })).toEqual([]);
    expect(parseModelsResponse({ models: [{ foo: "bar" }] })).toEqual([]);
  });
});

// ── openAIToGemini ─────────────────────────────────────────────────────────

describe("openAIToGemini", () => {
  function req(messages: any[]): ChatCompletionRequest {
    return { model: "ag-gemini-3-pro", messages };
  }

  test("system -> systemInstruction; user/assistant -> contents", () => {
    const body = openAIToGemini(req([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]), "gemini-3-pro");
    expect(body.model).toBe("gemini-3-pro");
    expect((body as any).systemInstruction.parts[0].text).toBe("Be helpful.");
    const contents = (body as any).contents;
    expect(contents.length).toBe(2);
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "Hello" }] });
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "Hi there" }] });
  });

  test("tool_calls -> functionCall parts", () => {
    const body = openAIToGemini(req([
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }] },
    ]), "gemini-3-pro");
    const assistantParts = (body as any).contents[1].parts;
    expect(assistantParts.some((p: any) => p.functionCall?.name === "get_weather")).toBe(true);
    expect(assistantParts.find((p: any) => p.functionCall)?.functionCall.args).toEqual({ city: "NYC" });
  });

  test("tool result message -> functionResponse", () => {
    const body = openAIToGemini(req([
      { role: "tool", tool_call_id: "c1", content: "72F sunny" },
    ]), "gemini-3-pro");
    const part = (body as any).contents[0].parts[0];
    expect(part.functionResponse).toBeDefined();
    expect(part.functionResponse.response.content).toBe("72F sunny");
  });

  test("tools -> functionDeclarations", () => {
    const body = openAIToGemini({
      ...req([{ role: "user", content: "hi" }]),
      tools: [{ function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
    }, "gemini-3-pro");
    expect((body as any).tools[0].functionDeclarations[0].name).toBe("read_file");
  });

  test("empty-content assistant turn is skipped (no empty parts)", () => {
    const body = openAIToGemini(req([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
    ]), "gemini-3-pro");
    expect((body as any).contents.length).toBe(1);
  });
});

// ── extractGeminiParts ─────────────────────────────────────────────────────

describe("extractGeminiParts", () => {
  test("concatenates text parts", () => {
    const r = extractGeminiParts([{ text: "Hello " }, { text: "world" }]);
    expect(r.text).toBe("Hello world");
    expect(r.toolCalls).toEqual([]);
  });

  test("extracts functionCall parts", () => {
    const r = extractGeminiParts([{ text: "Calling tool" }, { functionCall: { name: "get_weather", args: { city: "NYC" } } }]);
    expect(r.text).toBe("Calling tool");
    expect(r.toolCalls.length).toBe(1);
    expect(r.toolCalls[0]!.name).toBe("get_weather");
    expect(JSON.parse(r.toolCalls[0]!.arguments)).toEqual({ city: "NYC" });
  });

  test("empty / no parts", () => {
    expect(extractGeminiParts([])).toEqual({ text: "", toolCalls: [] });
    expect(extractGeminiParts(undefined as any)).toEqual({ text: "", toolCalls: [] });
  });
});
