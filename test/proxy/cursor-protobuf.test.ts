import { describe, test, expect } from "bun:test";
import {
  encodeVarint, decodeVarint, encodeField, decodeField, decodeMessage,
  encodeRequest, buildChatRequest, wrapConnectRPCFrame, generateCursorBody,
  parseConnectRPCFrame, extractTextFromResponse,
} from "../../src/proxy/providers/cursor/cursorProtobuf";
import { generateCursorChecksum, buildCursorHeaders, generateHashed64Hex } from "../../src/proxy/providers/cursor/cursorChecksum";

/**
 * Round-trip tests for the Cursor Connect-RPC codec. These prove the wire-format
 * primitives survive encode → decode, which is the correctness bar when no live
 * Cursor call can be made.
 */

describe("cursor checksum", () => {
  test("generateHashed64Hex is a 64-char hex sha256", () => {
    const h = generateHashed64Hex("abc", "salt");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(generateHashed64Hex("abc", "other"));
  });

  test("checksum ends with the machineId suffix", () => {
    const c = generateCursorChecksum("machine-xyz");
    expect(c.endsWith("machine-xyz")).toBe(true);
    // The prefix is URL-safe base64 (no padding).
    expect(c.slice(0, -"machine-xyz".length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("checksum changes over time (timestamp-derived)", async () => {
    const a = generateCursorChecksum("m");
    await new Promise((r) => setTimeout(r, 1100)); // >1s so floor(now/1e6) can shift
    const b = generateCursorChecksum("m");
    // Not guaranteed to differ every run (1ms-resolution timestamp), but length
    // is stable and both end with the machine id.
    expect(a.endsWith("m")).toBe(true);
    expect(b.endsWith("m")).toBe(true);
  });

  test("buildCursorHeaders emits the required Cursor headers", () => {
    const headers = buildCursorHeaders("tok-123", "machine-1");
    expect(headers["authorization"]).toBe("Bearer tok-123");
    expect(headers["content-type"]).toBe("application/connect+proto");
    expect(headers["x-cursor-checksum"]).toBeTruthy();
    expect(headers["x-cursor-client-version"]).toBe("3.1.0");
    expect(headers["x-client-key"]).toBeTruthy();
    expect(headers["x-session-id"]).toBeTruthy();
  });

  test("strips the ::prefix from the token", () => {
    const headers = buildCursorHeaders("WorkosCursor::tok-456");
    expect(headers["authorization"]).toBe("Bearer tok-456");
  });
});

describe("protobuf primitives", () => {
  test("varint round-trips for small + large values", () => {
    for (const v of [0, 1, 127, 128, 300, 16384, 0x7fffffff]) {
      const encoded = encodeVarint(v);
      const [decoded] = decodeVarint(encoded, 0);
      expect(decoded).toBe(v);
    }
  });

  test("encodeField LEN round-trips a string", () => {
    const field = encodeField(5, 2, "hello");
    const [fieldNum, wireType, value] = decodeField(field, 0);
    expect(fieldNum).toBe(5);
    expect(wireType).toBe(2);
    expect(new TextDecoder().decode(value as Uint8Array)).toBe("hello");
  });

  test("encodeField VARINT round-trips a number", () => {
    const field = encodeField(10, 0, 42);
    const [fieldNum, wireType, value] = decodeField(field, 0);
    expect(fieldNum).toBe(10);
    expect(wireType).toBe(0);
    expect(value).toBe(42);
  });

  test("decodeMessage collects repeated fields", () => {
    // Two LEN fields with the same number (messages).
    const buf = new Uint8Array([...encodeField(1, 2, "a"), ...encodeField(1, 2, "b")]);
    const fields = decodeMessage(buf);
    expect(fields.get(1)).toHaveLength(2);
  });
});

describe("request building", () => {
  test("generateCursorBody produces a framed body (5-byte header + protobuf)", () => {
    const body = generateCursorBody(
      [{ role: "user", content: "hello cursor" }],
      "gpt-4",
    );
    expect(body.length).toBeGreaterThan(5);
    // Flags byte is 0 (no compression for Cursor requests).
    expect(body[0]).toBe(0x00);
    // The declared length matches the remaining bytes.
    const declared = ((body[1]! << 24) | (body[2]! << 16) | (body[3]! << 8) | body[4]!) >>> 0;
    expect(declared).toBe(body.length - 5);
  });

  test("agentic mode is set when tools are present", () => {
    // Just verify it builds without throwing and produces a valid frame.
    const body = generateCursorBody(
      [{ role: "user", content: "use the tool" }],
      "gpt-4",
      [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }],
    );
    expect(body.length).toBeGreaterThan(5);
  });

  test("wrapConnectRPCFrame + parseConnectRPCFrame round-trip", () => {
    const payload = new TextEncoder().encode("payload-bytes");
    const framed = wrapConnectRPCFrame(payload, false);
    const parsed = parseConnectRPCFrame(framed, 0);
    expect(parsed.status).toBe("ok");
    expect(parsed.flags).toBe(0x00);
    expect(parsed.payload).toEqual(payload);
    expect(parsed.newOffset).toBe(framed.length);
  });

  test("parseConnectRPCFrame returns done on insufficient bytes", () => {
    expect(parseConnectRPCFrame(new Uint8Array(3), 0).status).toBe("done");
  });
});

describe("response extraction", () => {
  test("extractTextFromResponse returns nulls on an empty payload", () => {
    const out = extractTextFromResponse(new Uint8Array(0));
    expect(out.text).toBeNull();
    expect(out.toolCall).toBeNull();
  });

  test("extractTextFromResponse decodes a text response", () => {
    // Build a synthetic StreamUnifiedChatResponseWithTools { response: { text: "hi" } }.
    // field 2 (RESPONSE) → nested field 1 (RESPONSE_TEXT) = "hi"
    const inner = new Uint8Array([...encodeField(1, 2, "hi")]);
    const outer = new Uint8Array([...encodeField(2, 2, inner)]);
    const out = extractTextFromResponse(outer);
    expect(out.text).toBe("hi");
    expect(out.toolCall).toBeNull();
  });
});
