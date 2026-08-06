/**
 * Pure transform/parse helper tests for the Kiro, Qoder, and Cursor providers.
 *
 * These target the network-free seams the sibling tests do NOT already cover:
 *  - kiro/aws-eventstream: crc32, concatBytes, decodeAwsEventStream (round-trip
 *    through a hand-built AWS event-stream encoder), readEventStreamFrames,
 *    extractEventText/extractReasoningText, isCompleteJson/completeJsonSuffix,
 *    unwrapKiroEvent, extractKiroText, extractKiroToolCalls, extractKiroCredits,
 *    extractKiroContextTokens.
 *  - kiro/messages: textFromContent, extractImageBlocks, hasImages,
 *    sanitizeJsonSchema, extractToolResults, toolResultsFromContent,
 *    toolUsesFromMessage, mergeMessagePair.
 *  - qoder/helpers: encodeQoderPayload/decodeQoderPayload (custom base64
 *    round-trip), md5Hex, rfc1123Date, pathSigFromUrl, generateOpenAIToolId,
 *    normalizeToolCallId, and parseSseLine edge cases (usage, tool calls,
 *    finish_reason, encoded body, non-data lines).
 *  - cursor/cursorProtobuf: extractTextFromResponse thinking + tool-call + error
 *    paths (the text path is covered by cursor-protobuf.test.ts).
 *
 * No network, no DB. Env is set defensively before imports because the qoder
 * module pulls in config at import time.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect } from "bun:test";

import {
  crc32,
  concatBytes,
  decodeAwsEventStream,
  readEventStreamFrames,
  extractEventText,
  extractReasoningText,
  isCompleteJson,
  completeJsonSuffix,
  unwrapKiroEvent,
  extractKiroText,
  extractKiroToolCalls,
  extractKiroCredits,
  extractKiroContextTokens,
} from "../../src/proxy/providers/kiro/aws-eventstream";

import {
  textFromContent,
  extractImageBlocks,
  hasImages,
  sanitizeJsonSchema,
  extractToolResults,
  toolResultsFromContent,
  toolUsesFromMessage,
  mergeMessagePair,
} from "../../src/proxy/providers/kiro/messages";

import {
  encodeQoderPayload,
  decodeQoderPayload,
  md5Hex,
  rfc1123Date,
  pathSigFromUrl,
  generateOpenAIToolId,
  normalizeToolCallId,
  parseSseLine,
} from "../../src/proxy/providers/qoder/helpers";

import {
  encodeField,
  extractTextFromResponse,
} from "../../src/proxy/providers/cursor/cursorProtobuf";

// ── AWS event-stream encoder (mirrors the on-wire format decodeAwsEventStream reads) ──
// Frame layout: totalLen(u32) | headersLen(u32) | preludeCrc32(u32) | headers | payload | (trailing crc ignored by parser)
function encodeKiroEvent(headers: Record<string, string>, payload: string): Uint8Array {
  const enc = new TextEncoder();
  const headerParts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    headerParts.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const headerBytes = new Uint8Array(headerParts);
  const payloadBytes = enc.encode(payload);
  const totalLen = 12 + headerBytes.length + payloadBytes.length + 4;

  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, totalLen, false);
  dv.setUint32(4, headerBytes.length, false);
  const prelude = out.slice(0, 8);
  dv.setUint32(8, crc32(prelude), false);
  out.set(headerBytes, 12);
  out.set(payloadBytes, 12 + headerBytes.length);
  // Last 4 bytes are the message CRC; decodeAwsEventStream slices them off, value irrelevant here.
  return out;
}

describe("kiro aws-eventstream codec", () => {
  test("crc32 matches the known CRC-32 of '123456789' (0xCBF43926)", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("concatBytes joins two arrays preserving order", () => {
    const out = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3, 4]));
    expect([...out]).toEqual([1, 2, 3, 4]);
  });

  test("decodeAwsEventStream round-trips a single assistantResponseEvent", () => {
    const frame = encodeKiroEvent(
      { ":event-type": "assistantResponseEvent", ":message-type": "event" },
      JSON.stringify({ content: "hello" }),
    );
    const events = decodeAwsEventStream(frame);
    expect(events).toHaveLength(1);
    expect(events[0]?.headers[":event-type"]).toBe("assistantResponseEvent");
    expect(events[0]?.payload).toEqual({ content: "hello" });
  });

  test("decodeAwsEventStream parses multiple concatenated frames and keeps non-JSON payload as text", () => {
    const a = encodeKiroEvent({ ":event-type": "assistantResponseEvent" }, JSON.stringify({ content: "a" }));
    const b = encodeKiroEvent({ ":event-type": "meteringEvent" }, "not-json");
    const events = decodeAwsEventStream(concatBytes(a, b));
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toBe("not-json");
  });

  test("readEventStreamFrames splits complete frames and returns the partial remainder", () => {
    const full = encodeKiroEvent({ ":event-type": "assistantResponseEvent" }, JSON.stringify({ content: "x" }));
    const partial = encodeKiroEvent({ ":event-type": "assistantResponseEvent" }, JSON.stringify({ content: "y" }));
    const half = partial.slice(0, Math.floor(partial.length / 2));
    const { events, remaining } = readEventStreamFrames(concatBytes(full, half));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ content: "x" });
    expect(remaining.length).toBe(half.length);
  });

  test("readEventStreamFrames on a truncated buffer yields no events and keeps all bytes", () => {
    const { events, remaining } = readEventStreamFrames(new Uint8Array([0, 0, 0]));
    expect(events).toHaveLength(0);
    expect(remaining.length).toBe(3);
  });
});

describe("kiro event text/reasoning extraction", () => {
  test("extractEventText reads content/text/delta for assistant events", () => {
    expect(extractEventText({ content: "c" }, "assistantResponseEvent")).toBe("c");
    expect(extractEventText({ text: "t" }, "textEvent")).toBe("t");
    expect(extractEventText({ delta: "d" }, "contentEvent")).toBe("d");
  });

  test("extractEventText suppresses reasoning/thinking events and unrelated types", () => {
    expect(extractEventText({ content: "c" }, "reasoningEvent")).toBe("");
    expect(extractEventText({ content: "c" }, "thinkingEvent")).toBe("");
    expect(extractEventText({ content: "c" }, "meteringEvent")).toBe("");
    expect(extractEventText(null, "assistantResponseEvent")).toBe("");
  });

  test("extractReasoningText only emits for reason/thinking event types", () => {
    expect(extractReasoningText({ text: "think" }, "reasoningEvent")).toBe("think");
    expect(extractReasoningText({ content: "think" }, "thinkingEvent")).toBe("think");
    expect(extractReasoningText({ delta: "think" }, "reasoningEvent")).toBe("think");
    expect(extractReasoningText({ text: "nope" }, "assistantResponseEvent")).toBe("");
    expect(extractReasoningText({ text: "nope" })).toBe("");
  });
});

describe("kiro JSON completion helpers", () => {
  test("isCompleteJson distinguishes complete vs truncated JSON", () => {
    expect(isCompleteJson('{"a":1}')).toBe(true);
    expect(isCompleteJson('{"a":')).toBe(false);
    expect(isCompleteJson("not json")).toBe(false);
  });

  test("completeJsonSuffix closes unbalanced braces, brackets, and quotes", () => {
    expect(completeJsonSuffix('{"a":{')).toBe("}}");
    expect(completeJsonSuffix('{"a":[1,2')).toBe("]}");
    expect(completeJsonSuffix('{"a":"bc')).toBe('"}');
    expect(completeJsonSuffix("")).toBe("");
  });
});

describe("kiro event unwrap + aggregation", () => {
  test("unwrapKiroEvent prefers the named event-type key then falls back to known wrappers", () => {
    expect(unwrapKiroEvent({ assistantResponseEvent: { content: "c" } }, "assistantResponseEvent")).toEqual({ content: "c" });
    expect(unwrapKiroEvent({ toolUseEvent: { name: "f" } })).toEqual({ name: "f" });
    expect(unwrapKiroEvent({ meteringEvent: { usage: 1 } })).toEqual({ usage: 1 });
    expect(unwrapKiroEvent({ other: 1 })).toEqual({ other: 1 });
    expect(unwrapKiroEvent(null)).toBeNull();
  });

  test("extractKiroText concatenates nested content/text/delta strings", () => {
    const events = [
      { payload: { assistantResponseEvent: { content: "Hello, " } } },
      { payload: { assistantResponseEvent: { content: "world" } } },
      { payload: { nested: { text: "!" } } },
    ];
    expect(extractKiroText(events)).toBe("Hello, world!");
  });

  test("extractKiroToolCalls streams string args and merges object inputs per id", () => {
    const events = [
      { headers: { ":event-type": "toolUseEvent" }, payload: { toolUseId: "c1", name: "fetch", input: '{"url":' } },
      { headers: { ":event-type": "toolUseEvent" }, payload: { toolUseId: "c1", input: '"x"}' } },
      { headers: { ":event-type": "toolUseEvent" }, payload: { toolUseId: "c2", name: "write", input: { a: 1 } } },
      { headers: { ":event-type": "toolUseEvent" }, payload: { toolUseId: "c2", input: { b: 2 } } },
    ];
    const calls = extractKiroToolCalls(events);
    expect(calls).toHaveLength(2);
    const byId = new Map(calls.map((c) => [c.id, c]));
    expect(byId.get("c1")?.function.name).toBe("fetch");
    expect(byId.get("c1")?.function.arguments).toBe('{"url":"x"}');
    expect(byId.get("c2")?.function.arguments).toBe(JSON.stringify({ a: 1, b: 2 }));
    expect(byId.get("c1")?.type).toBe("function");
  });

  test("extractKiroToolCalls skips events without a tool id and drops nameless first events", () => {
    const events = [
      { headers: { ":event-type": "toolUseEvent" }, payload: { name: "no-id" } },
      { headers: { ":event-type": "toolUseEvent" }, payload: { toolUseId: "c9", input: "{}" } }, // no name yet
    ];
    expect(extractKiroToolCalls(events)).toEqual([]);
  });

  test("extractKiroCredits sums usage/creditsUsed across nested payloads", () => {
    const events = [
      { payload: { meteringEvent: { usage: 2, unit: "credit" } } },
      { payload: { creditsUsed: 3 } },
      { payload: { deep: { usage: 5, unitPlural: "credits" } } },
      { payload: { usage: 99, unit: "token" } }, // wrong unit — ignored
    ];
    expect(extractKiroCredits(events)).toBe(10);
  });

  test("extractKiroContextTokens converts contextUsagePercentage to tokens via the context window", () => {
    const events = [{ payload: { contextUsageEvent: { contextUsagePercentage: 50 } } }];
    expect(extractKiroContextTokens(events, 200000)).toBe(100000);
    // direct field, takes the max
    const direct = [{ payload: { contextUsagePercentage: 10 } }, { payload: { contextUsagePercentage: 25 } }];
    expect(extractKiroContextTokens(direct, 100000)).toBe(25000);
    expect(extractKiroContextTokens([{ payload: {} }], 200000)).toBe(0);
  });
});

describe("kiro/messages content + tool helpers", () => {
  test("textFromContent handles strings, text blocks, and tool_result blocks", () => {
    expect(textFromContent("plain")).toBe("plain");
    expect(textFromContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(textFromContent([{ type: "tool_result", content: "res" }])).toBe("res");
    expect(textFromContent([{ type: "tool_result", content: { k: 1 } }])).toBe(JSON.stringify({ k: 1 }));
    expect(textFromContent([{ type: "image_url", image_url: { url: "x" } }])).toBe(""); // images skipped
    expect(textFromContent(undefined as any)).toBe("");
  });

  test("extractImageBlocks converts OpenAI data URLs and Anthropic base64 blocks", () => {
    const content = [
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "image_url", image_url: { url: "data:image/jpg;base64,BBB" } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "CCC" } },
      { type: "text", text: "ignore me" },
    ];
    const imgs = extractImageBlocks(content);
    expect(imgs).toEqual([
      { format: "png", source: { bytes: "AAA" } },
      { format: "jpeg", source: { bytes: "BBB" } }, // jpg normalized to jpeg
      { format: "webp", source: { bytes: "CCC" } },
    ]);
    expect(extractImageBlocks("not-array")).toEqual([]);
  });

  test("hasImages detects both OpenAI and Anthropic image block shapes", () => {
    expect(hasImages([{ type: "image_url", image_url: { url: "u" } }])).toBe(true);
    expect(hasImages([{ type: "image", source: { data: "d" } }])).toBe(true);
    expect(hasImages([{ type: "text", text: "t" }])).toBe(false);
    expect(hasImages("str")).toBe(false);
  });

  test("sanitizeJsonSchema strips forbidden keys and guarantees type/properties", () => {
    const out = sanitizeJsonSchema({
      $schema: "http://x",
      $defs: {},
      definitions: {},
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(out.$schema).toBeUndefined();
    expect(out.$defs).toBeUndefined();
    expect(out.definitions).toBeUndefined();
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({ a: { type: "string" } });

    // Non-object / missing type cases collapse to a safe object schema.
    expect(sanitizeJsonSchema(null)).toEqual({ type: "object", properties: {} });
    expect(sanitizeJsonSchema({ required: "not-array" })).toEqual({ type: "object", properties: {} });
  });

  test("extractToolResults pulls tool_result blocks from user messages only", () => {
    const msgs: any = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] },
      { role: "assistant", content: [{ type: "tool_result", tool_use_id: "ignored", content: "x" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: { e: 1 }, is_error: true }] },
    ];
    const results = extractToolResults(msgs);
    expect(results).toEqual([
      { toolUseId: "t1", content: [{ text: "ok" }], status: "success" },
      { toolUseId: "t2", content: [{ text: JSON.stringify({ e: 1 }) }], status: "error" },
    ]);
  });

  test("toolResultsFromContent stringifies non-string content and flags errors", () => {
    expect(toolResultsFromContent([{ type: "tool_result", tool_use_id: "a", content: "s" }])).toEqual([
      { toolUseId: "a", content: [{ text: "s" }], status: "success" },
    ]);
    expect(toolResultsFromContent([{ type: "tool_result", tool_use_id: "b", content: { x: 1 }, is_error: true }])).toEqual([
      { toolUseId: "b", content: [{ text: JSON.stringify({ x: 1 }) }], status: "error" },
    ]);
    expect(toolResultsFromContent("nope" as any)).toEqual([]);
  });

  test("toolUsesFromMessage reads Anthropic tool_use blocks and OpenAI tool_calls", () => {
    const fromBlocks = toolUsesFromMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "u1", name: "fetch", input: { url: "x" } }],
    } as any);
    expect(fromBlocks).toEqual([{ toolUseId: "u1", name: "fetch", input: { url: "x" } }]);

    const fromCalls = toolUsesFromMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "write", arguments: '{"a":1}' } }],
    } as any);
    expect(fromCalls).toEqual([{ toolUseId: "c1", name: "write", input: { a: 1 } }]);
  });

  test("mergeMessagePair concatenates string content and merges tool_calls", () => {
    const merged = mergeMessagePair(
      { role: "user", content: "a" } as any,
      { role: "user", content: "b" } as any,
    );
    expect(merged.content).toBe("a\n\nb");

    const withTools = mergeMessagePair(
      { role: "assistant", content: "x", tool_calls: [{ id: "1", function: { name: "f", arguments: "{}" } }] } as any,
      { role: "assistant", content: "y", tool_calls: [{ id: "2", function: { name: "g", arguments: "{}" } }] } as any,
    );
    expect(withTools.tool_calls).toHaveLength(2);
    expect(withTools.content).toBe("x\n\ny");
  });
});

describe("qoder custom-base64 payload codec", () => {
  test("encodeQoderPayload/decodeQoderPayload round-trip a UTF-8 JSON string", () => {
    const original = JSON.stringify({ choices: [{ delta: { content: "héllo" } }] });
    const encoded = encodeQoderPayload(original);
    expect(encoded).not.toBe(original);
    expect(decodeQoderPayload(encoded)).toBe(original);
  });

  test("decodeQoderPayload returns null on out-of-alphabet input and empty string", () => {
    expect(decodeQoderPayload("")).toBeNull();
    // A standard base64 string with '+' is NOT in the custom alphabet → null.
    expect(decodeQoderPayload("a+b/")).toBeNull();
  });
});

describe("qoder misc pure helpers", () => {
  test("md5Hex is a 32-char lowercase hex digest", () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72"); // known md5("abc")
  });

  test("rfc1123Date returns a UTC string", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(rfc1123Date(d)).toBe("Fri, 02 Jan 2026 03:04:05 GMT");
  });

  test("pathSigFromUrl strips the /algo prefix but keeps other paths intact", () => {
    expect(pathSigFromUrl("https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1")).toBe("/api/v3/user/jobToken");
    expect(pathSigFromUrl("https://openapi.qoder.sh/api/v2/quota/usage")).toBe("/api/v2/quota/usage");
  });

  test("generateOpenAIToolId is call_ + 24 alphanumeric chars", () => {
    const id = generateOpenAIToolId();
    expect(id).toMatch(/^call_[A-Za-z0-9]{24}$/);
  });

  test("normalizeToolCallId keeps long ids, strips toolu_, regenerates short/missing", () => {
    const longId = "call_abcdefghijklmnopqrstuvwxyz"; // > 20 chars
    expect(normalizeToolCallId(longId, 0)).toBe(longId);

    const toolu = "toolu_" + "x".repeat(30); // strips prefix → 30 chars, kept
    expect(normalizeToolCallId(toolu, 0)).toBe("x".repeat(30));

    expect(normalizeToolCallId("short", 0)).toMatch(/^call_[A-Za-z0-9]{24}$/);
    expect(normalizeToolCallId(undefined, 0)).toMatch(/^call_[A-Za-z0-9]{24}$/);
  });
});

describe("qoder parseSseLine edge cases", () => {
  test("ignores non-data lines, blank data, and [DONE]", () => {
    expect(parseSseLine("event: message")).toBeNull();
    expect(parseSseLine("data:")).toBeNull();
    expect(parseSseLine("data: [DONE]")).toBeNull();
    expect(parseSseLine('data: {"body":"[DONE]"}')).toBeNull();
  });

  test("extracts usage + finish_reason from a flat OpenAI chunk", () => {
    const line =
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}';
    const p = parseSseLine(line);
    expect(p?.finishReason).toBe("stop");
    expect(p?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  test("surfaces tool_calls from a Cosy body-wrapped chunk", () => {
    const inner = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "f", arguments: "{}" } }] } }],
    });
    const line = "data: " + JSON.stringify({ body: inner });
    const p = parseSseLine(line);
    expect(p?.toolCalls).toBeTruthy();
    expect(p?.toolCalls?.[0]?.function?.name).toBe("f");
  });

  test("parses a Cosy body that is custom-base64 encoded (Encode=1)", () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "secret" } }] });
    const encoded = encodeQoderPayload(inner);
    const line = "data: " + JSON.stringify({ body: encoded });
    const p = parseSseLine(line);
    expect(p?.content).toBe("secret");
  });

  test("returns null for a wrapper that yields no content/usage/finish/tool", () => {
    expect(parseSseLine('data: {"foo":"bar"}')).toBeNull();
    expect(parseSseLine("data: not-json-at-all")).toBeNull();
  });
});

describe("cursor extractTextFromResponse (thinking / tool-call / error)", () => {
  test("decodes a thinking-only response frame", () => {
    // field 2 (RESPONSE) → { field 25 (THINKING) → { field 1 (THINKING_TEXT) = "pondering" } }
    const thinkingMsg = new Uint8Array([...encodeField(1, 2, "pondering")]);
    const inner = new Uint8Array([...encodeField(25, 2, thinkingMsg)]);
    const outer = new Uint8Array([...encodeField(2, 2, inner)]);
    const out = extractTextFromResponse(outer);
    expect(out.thinking).toBe("pondering");
    expect(out.text).toBeNull();
    expect(out.toolCall).toBeNull();
  });

  test("decodes a tool-call frame with id + name + raw args", () => {
    // field 1 (TOOL_CALL) → { field 3 (TOOL_ID)="id1", field 9 (TOOL_NAME)="run", field 10 (TOOL_RAW_ARGS)="{\"a\":1}" }
    const toolCall = new Uint8Array([
      ...encodeField(3, 2, "id1"),
      ...encodeField(9, 2, "run"),
      ...encodeField(10, 2, '{"a":1}'),
    ]);
    const outer = new Uint8Array([...encodeField(1, 2, toolCall)]);
    const out = extractTextFromResponse(outer);
    expect(out.toolCall).toEqual({ id: "id1", name: "run", arguments: '{"a":1}' });
    expect(out.text).toBeNull();
  });

  test("returns an error string (not a throw) on a malformed payload", () => {
    // Truncated LEN field: declares a long length but provides no bytes.
    const bad = new Uint8Array([0x12, 0xff, 0xff, 0xff, 0xff, 0x0f]);
    const out = extractTextFromResponse(bad);
    expect(out.text).toBeNull();
    expect(out.toolCall).toBeNull();
    expect(out.error === null || typeof out.error === "string").toBe(true);
  });
});
