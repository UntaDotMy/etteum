/**
 * Unit tests for flattenToolHistory (src/proxy/fusion.ts).
 *
 * flattenToolHistory rewrites a chat history that contains tool turns into
 * plain prose so fusion panel/judge models that can't handle tool calls still
 * see the conversation context. It is a pure transform — no network, no pool.
 *
 * fusion.ts imports pool/router/ws which read config at import time, so set
 * the env vars before the static imports below are resolved.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, expect, test } from "bun:test";
import { flattenToolHistory } from "../../src/proxy/fusion";

describe("flattenToolHistory", () => {
  test("empty history returns an empty array", () => {
    expect(flattenToolHistory([])).toEqual([]);
  });

  test("passes plain user/system messages through by reference", () => {
    const sys = { role: "system", content: "You are helpful." };
    const user = { role: "user", content: "hello" };
    const out = flattenToolHistory([sys, user]);
    expect(out.length).toBe(2);
    // "keep as-is" branch — same object identity, not a copy.
    expect(out[0]).toBe(sys);
    expect(out[1]).toBe(user);
  });

  test("keeps a plain assistant message with string content unchanged in value", () => {
    const out = flattenToolHistory([{ role: "assistant", content: "sure thing" }]);
    expect(out).toEqual([{ role: "assistant", content: "sure thing" }]);
  });

  test("coerces non-string assistant content to JSON text", () => {
    const out = flattenToolHistory([
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.role).toBe("assistant");
    expect(out[0]?.content).toBe(JSON.stringify([{ type: "text", text: "hi" }]));
  });

  test("assistant with null content becomes empty-ish JSON string", () => {
    // content ?? "" → "" → JSON.stringify("") → '""'
    const out = flattenToolHistory([{ role: "assistant", content: null }]);
    expect(out[0]?.content).toBe('""');
  });

  test("assistant with tool_calls becomes a [called tools: ...] prose line", () => {
    const out = flattenToolHistory([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
          { id: "2", function: { name: "get_time", arguments: '{"tz":"UTC"}' } },
        ],
      },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.role).toBe("assistant");
    expect(out[0]?.content).toBe(
      '[called tools: get_weather({"city":"Paris"}); get_time({"tz":"UTC"})]'
    );
  });

  test("tool_call without a function name falls back to 'tool'", () => {
    const out = flattenToolHistory([
      { role: "assistant", tool_calls: [{ id: "x", function: {} }] },
    ]);
    expect(out[0]?.content).toBe("[called tools: tool()]");
  });

  test("tool_call arguments are truncated to 200 chars", () => {
    const longArgs = "x".repeat(500);
    const out = flattenToolHistory([
      { role: "assistant", tool_calls: [{ function: { name: "f", arguments: longArgs } }] },
    ]);
    const content = out[0]?.content as string;
    // "[called tools: f(" + 200 chars + ")]"
    expect(content).toBe(`[called tools: f(${"x".repeat(200)})]`);
    expect(content.length).toBe("[called tools: f()]".length + 200);
  });

  test("assistant with an EMPTY tool_calls array is treated as a plain message", () => {
    // tool_calls.length > 0 is required for the flatten branch; an empty array
    // falls into the "tool_calls == null"? No — [] is not null, so it hits the
    // final else and is kept as-is. Lock the current behavior.
    const msg = { role: "assistant", content: "hi", tool_calls: [] };
    const out = flattenToolHistory([msg]);
    expect(out[0]).toBe(msg);
  });

  test("tool result message becomes a user [tool result: ...] line", () => {
    const out = flattenToolHistory([
      { role: "tool", tool_call_id: "1", content: "sunny, 22C" },
    ]);
    expect(out).toEqual([{ role: "user", content: "[tool result: sunny, 22C]" }]);
  });

  test("non-string tool result content is JSON-stringified", () => {
    const out = flattenToolHistory([
      { role: "tool", tool_call_id: "1", content: { temp: 22 } },
    ]);
    expect(out[0]?.content).toBe('[tool result: {"temp":22}]');
  });

  test("tool result content is truncated to 500 chars", () => {
    const longResult = "r".repeat(1000);
    const out = flattenToolHistory([{ role: "tool", content: longResult }]);
    expect(out[0]?.content).toBe(`[tool result: ${"r".repeat(500)}]`);
  });

  test("interleaved tool conversation flattens into an alternating prose transcript", () => {
    const out = flattenToolHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "what is the weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
      { role: "tool", tool_call_id: "1", content: "sunny" },
      { role: "assistant", content: "It is sunny in Paris." },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "what is the weather in Paris?" },
      { role: "assistant", content: '[called tools: get_weather({"city":"Paris"})]' },
      { role: "user", content: "[tool result: sunny]" },
      { role: "assistant", content: "It is sunny in Paris." },
    ]);
  });

  test("null/undefined entries in the message array are skipped", () => {
    const out = flattenToolHistory([null, { role: "user", content: "hi" }, undefined]);
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  test("does not mutate the input messages", () => {
    const toolCallMsg = {
      role: "assistant",
      content: null,
      tool_calls: [{ function: { name: "f", arguments: "{}" } }],
    };
    const toolResultMsg = { role: "tool", content: "ok" };
    flattenToolHistory([toolCallMsg, toolResultMsg]);
    expect(toolCallMsg.tool_calls.length).toBe(1);
    expect(toolResultMsg.role).toBe("tool");
  });
});
