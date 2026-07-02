import { describe, expect, test } from "bun:test";
import { KiroProvider } from "../../src/proxy/providers/kiro";
import { mapTools, buildHistory, normalizeMessages } from "../../src/proxy/providers/kiro/messages";

/**
 * Characterization test for KiroProvider's request-builder helpers.
 *
 * Kiro is the most complex provider (AWS CodeWhisperer event-stream) and the
 * fallback for all bare-claude models, so its message→history conversion is the
 * riskiest place to edit. These tests pin the CURRENT behavior of the private
 * builder helpers (accessed via bracket notation) so any future change to kiro
 * — or to the shared anthropic transform feeding it — that alters the upstream
 * payload shape fails loudly here instead of silently breaking tool calls.
 *
 * If you intentionally change kiro's upstream format, update the expected values
 * on purpose. A surprise failure means kiro's request contract drifted.
 */
const kiro = new KiroProvider() as any;

describe("kiro nativeFormat + routing flags", () => {
  test("declares itself the Anthropic-native fallback provider", () => {
    expect(kiro.name).toBe("kiro");
    expect(kiro.isFallback).toBe(true);
    expect(kiro.nativeFormat).toBe("anthropic");
  });

  test("ownsModel matches standard-tier + bare claude, not other providers' prefixes", () => {
    for (const m of ["auto", "claude-sonnet-4.5", "claude-sonnet-4.5-thinking", "deepseek-3.2", "glm-5", "minimax-m2.1", "qwen3-coder-next", "claude-opus-4.1"]) {
      expect(kiro.ownsModel(m)).toBe(true);
    }
    for (const m of ["qd-Lite", "kp-opus-4.8", "cb-opus-4.6", "codex-auto", "canva-image"]) {
      expect(kiro.ownsModel(m)).toBe(false);
    }
  });
});

describe("kiro mapTools (OpenAI/Anthropic tool → CodeWhisperer toolSpecification)", () => {
  test("maps an OpenAI-shaped function tool", () => {
    const out = mapTools([
      { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
    ]);
    expect(out).toEqual([
      {
        toolSpecification: {
          name: "get_weather",
          description: "w",
          inputSchema: { json: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
        },
      },
    ]);
  });

  test("strips $schema/$defs and defaults a missing schema to an empty object schema", () => {
    const out = mapTools([
      { name: "f", description: "", input_schema: { $schema: "http://x", $defs: {}, type: "object", properties: { a: { type: "string" } } } },
    ]);
    expect(out[0].toolSpecification.inputSchema.json).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  test("drops tools without a name", () => {
    expect(mapTools([{ description: "no name" }])).toEqual([]);
    expect(mapTools(undefined)).toEqual([]);
  });
});

describe("kiro buildHistory (prior turns → CodeWhisperer history)", () => {
  test("maps a user/assistant exchange to userInputMessage/assistantResponseMessage", () => {
    const history = buildHistory(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      "claude-sonnet-4.5",
    );
    expect(history).toEqual([
      {
        userInputMessage: {
          content: "hello",
          modelId: "claude-sonnet-4.5",
          origin: "AI_EDITOR",
          userInputMessageContext: { tools: [] },
        },
      },
      {
        assistantResponseMessage: { content: "hi there" },
      },
    ]);
  });

  test("carries Anthropic tool_use blocks into assistant toolUses and tool_result into user toolResults", () => {
    const history = buildHistory(
      [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Tokyo" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny", is_error: false }],
        },
      ],
      "claude-sonnet-4.5",
    );
    expect(history[0].assistantResponseMessage.toolUses).toEqual([
      { toolUseId: "call_1", name: "get_weather", input: { city: "Tokyo" } },
    ]);
    expect(history[1].userInputMessage.userInputMessageContext).toEqual({
      toolResults: [{ toolUseId: "call_1", content: [{ text: "sunny" }], status: "success" }],
    });
  });

  test("maps OpenAI assistant tool_calls (string arguments) into toolUses with parsed input", () => {
    const history = buildHistory(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "fetch", arguments: '{"url":"x"}' } }] },
      ],
      "auto",
    );
    expect(history[1].assistantResponseMessage.toolUses).toEqual([
      { toolUseId: "c1", name: "fetch", input: { url: "x" } },
    ]);
  });
});

describe("kiro normalizeMessages (OpenAI role:tool + same-role merging)", () => {
  test("folds role:tool messages into a synthesized user turn with tool_result blocks", () => {
    const out = normalizeMessages([
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result-text" },
    ]);
    const last = out[out.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "result-text", is_error: false }]);
  });

  test("merges consecutive same-role messages so the conversation alternates", () => {
    const out = normalizeMessages([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toBe("a\n\nb");
  });
});
