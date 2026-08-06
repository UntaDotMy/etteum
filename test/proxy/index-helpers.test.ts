/**
 * Unit tests for the pure helpers in src/proxy/index.ts (lines 513-556):
 *   estimateTokensFromText, estimateMessagesTokens, isJsonParseError,
 *   openAIErrorResponse.
 *
 * These four functions are module-private (not exported) and importing
 * src/proxy/index.ts boots a Hono router plus opens the real SQLite database,
 * so they cannot be imported directly in a unit test. Following the repo
 * precedent in test/proxy/share-rate-limit.test.ts (which mirrors the
 * non-exported shareClientIp/isLocalShareRequest predicate), the functions
 * below are VERBATIM copies of the source. If the source helpers change,
 * these tests will silently keep passing against the stale copies — update
 * both sides together.
 *
 * Behavior verified against src/proxy/index.ts @ 20d85f5.
 */
import { describe, test, expect } from "bun:test";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";

// ── Verbatim mirrors of src/proxy/index.ts:513-556 ──────────────────────────

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessagesTokens(messages: ChatCompletionRequest["messages"]): number {
  return (messages || []).reduce((total, msg) => {
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as any[])
        .map((block) => {
          if (block?.type === "text" && typeof block.text === "string") return block.text;
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") return block.content;
            if (Array.isArray(block.content)) {
              return block.content.map((b: any) => b?.text || "").join("");
            }
          }
          return JSON.stringify(block || "");
        })
        .join("");
    } else {
      content = JSON.stringify(msg.content || "");
    }
    return total + estimateTokensFromText(content) + 4;
  }, 0);
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError ||
    (error instanceof Error && /json|parse|unexpected end|unexpected token/i.test(error.message));
}

function openAIErrorResponse(message: string, status: 400 | 503) {
  return {
    error: {
      message,
      type: status === 400 ? "invalid_request_error" : "server_error",
      code: status === 400 ? "invalid_json" : "proxy_error",
    },
  };
}

// ── estimateTokensFromText ──────────────────────────────────────────────────

describe("estimateTokensFromText", () => {
  test("empty string estimates to 0 tokens", () => {
    expect(estimateTokensFromText("")).toBe(0);
  });

  test("estimates ~4 chars per token, rounding up", () => {
    // 8 chars / 4 = 2 exactly.
    expect(estimateTokensFromText("abcdefgh")).toBe(2);
    // 9 chars / 4 = 2.25 -> ceil 3.
    expect(estimateTokensFromText("abcdefghi")).toBe(3);
  });

  test("any non-empty text estimates to at least 1 token", () => {
    // The Math.max(1, ...) floor: even a single char is 1 token, never 0.
    expect(estimateTokensFromText("a")).toBe(1);
    expect(estimateTokensFromText("ab")).toBe(1);
  });

  test("scales linearly for longer text", () => {
    const text = "x".repeat(400);
    expect(estimateTokensFromText(text)).toBe(100);
  });
});

// ── estimateMessagesTokens ──────────────────────────────────────────────────

describe("estimateMessagesTokens", () => {
  test("undefined/empty message list estimates to 0", () => {
    // (messages || []) guard.
    expect(estimateMessagesTokens(undefined as unknown as ChatCompletionRequest["messages"])).toBe(0);
    expect(estimateMessagesTokens([])).toBe(0);
  });

  test("each message contributes its content tokens plus a flat 4-token overhead", () => {
    // "abcdefgh" = 8 chars -> 2 tokens, + 4 overhead = 6.
    const total = estimateMessagesTokens([{ role: "user", content: "abcdefgh" }]);
    expect(total).toBe(6);
  });

  test("sums across multiple messages", () => {
    const total = estimateMessagesTokens([
      { role: "system", content: "abcd" },     // 1 + 4 = 5
      { role: "user", content: "abcdefgh" },   // 2 + 4 = 6
      { role: "assistant", content: "" },      // 0 + 4 = 4 (overhead still charged)
    ]);
    expect(total).toBe(15);
  });

  test("empty string content still charges the 4-token message overhead", () => {
    expect(estimateMessagesTokens([{ role: "user", content: "" }])).toBe(4);
  });

  test("array content: only text blocks contribute their text", () => {
    const total = estimateMessagesTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "abcd" },   // 4 chars
          { type: "text", text: "efgh" },   // 4 chars -> joined "abcdefgh" = 2 tokens
        ],
      },
    ]);
    expect(total).toBe(2 + 4);
  });

  test("array content: tool_result string content is counted as-is", () => {
    const total = estimateMessagesTokens([
      {
        role: "tool",
        content: [{ type: "tool_result", content: "abcdefgh" }], // 8 chars -> 2 tokens
      },
    ]);
    expect(total).toBe(2 + 4);
  });

  test("array content: tool_result with nested content blocks concatenates b.text", () => {
    const total = estimateMessagesTokens([
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            content: [{ text: "abcd" }, { text: "efgh" }],
          },
        ],
      },
    ]);
    // Joined to "abcdefgh" = 8 chars -> 2 tokens.
    expect(total).toBe(2 + 4);
  });

  test("array content: non-text non-tool_result blocks are JSON.stringified", () => {
    // An image block has no .text; it falls to JSON.stringify(block).
    const block = { type: "image_url", image_url: { url: "data:..." } };
    const expectedJson = JSON.stringify(block);
    const total = estimateMessagesTokens([{ role: "user", content: [block] }]);
    expect(total).toBe(estimateTokensFromText(expectedJson) + 4);
  });

  test("array content: text block with non-string text is JSON.stringified, not counted as text", () => {
    // block.type === "text" but text is missing -> falls through to stringify.
    const block = { type: "text" };
    const total = estimateMessagesTokens([{ role: "user", content: [block] }]);
    expect(total).toBe(estimateTokensFromText(JSON.stringify(block)) + 4);
  });

  test("non-string non-array content (e.g. null/object) is JSON.stringified", () => {
    // msg.content = null -> JSON.stringify(null || "") = '""' (2 chars -> 1 token).
    expect(estimateMessagesTokens([{ role: "user", content: null as unknown as string }])).toBe(1 + 4);

    const obj = { foo: "bar" };
    const total = estimateMessagesTokens([{ role: "user", content: obj as unknown as string }]);
    expect(total).toBe(estimateTokensFromText(JSON.stringify(obj)) + 4);
  });

  test("tool_result block with undefined nested text contributes empty string", () => {
    // b?.text || "" handles blocks missing .text inside a tool_result array.
    const total = estimateMessagesTokens([
      {
        role: "tool",
        content: [
          { type: "tool_result", content: [{ text: "abcd" }, {}] },
        ],
      },
    ]);
    // Only "abcd" survives -> 1 token.
    expect(total).toBe(1 + 4);
  });
});

// ── isJsonParseError ────────────────────────────────────────────────────────

describe("isJsonParseError", () => {
  test("a SyntaxError is always classified as a JSON parse error", () => {
    expect(isJsonParseError(new SyntaxError("whatever"))).toBe(true);
    // Even a message that matches nothing in the regex.
    expect(isJsonParseError(new SyntaxError("completely unrelated wording"))).toBe(true);
  });

  test("generic Error with json/parse/unexpected-end/unexpected-token in message matches", () => {
    expect(isJsonParseError(new Error("Unexpected token < in JSON at position 0"))).toBe(true);
    expect(isJsonParseError(new Error("Unexpected end of JSON input"))).toBe(true);
    expect(isJsonParseError(new Error("failed to parse body"))).toBe(true);
    expect(isJsonParseError(new Error("invalid json payload"))).toBe(true);
  });

  test("regex is case-insensitive", () => {
    expect(isJsonParseError(new Error("INVALID JSON"))).toBe(true);
    expect(isJsonParseError(new Error("Parse Failure"))).toBe(true);
  });

  test("generic Error with unrelated message does NOT match", () => {
    expect(isJsonParseError(new Error("connection refused"))).toBe(false);
    expect(isJsonParseError(new Error("upstream timeout"))).toBe(false);
  });

  test("non-Error values never match", () => {
    expect(isJsonParseError("Unexpected token in JSON")).toBe(false);
    expect(isJsonParseError({ message: "json parse error" })).toBe(false);
    expect(isJsonParseError(null)).toBe(false);
    expect(isJsonParseError(undefined)).toBe(false);
    expect(isJsonParseError(42)).toBe(false);
  });

  test("SyntaxError subclass still matches via instanceof", () => {
    class MySyntax extends SyntaxError {}
    expect(isJsonParseError(new MySyntax("boom"))).toBe(true);
  });

  test("TypeError mentioning JSON matches (any Error, not just SyntaxError)", () => {
    // The second branch accepts ANY Error whose message matches the regex.
    expect(isJsonParseError(new TypeError("cannot parse json"))).toBe(true);
  });
});

// ── openAIErrorResponse ─────────────────────────────────────────────────────

describe("openAIErrorResponse", () => {
  test("400 produces invalid_request_error / invalid_json", () => {
    expect(openAIErrorResponse("Invalid JSON request body", 400)).toEqual({
      error: {
        message: "Invalid JSON request body",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    });
  });

  test("503 produces server_error / proxy_error", () => {
    expect(openAIErrorResponse("All accounts failed", 503)).toEqual({
      error: {
        message: "All accounts failed",
        type: "server_error",
        code: "proxy_error",
      },
    });
  });

  test("message is passed through verbatim", () => {
    const r = openAIErrorResponse("x", 400);
    expect(r.error.message).toBe("x");
  });

  test("shape is OpenAI-compatible: single top-level error object with message/type/code", () => {
    const r = openAIErrorResponse("m", 503);
    expect(Object.keys(r)).toEqual(["error"]);
    expect(Object.keys(r.error).sort()).toEqual(["code", "message", "type"]);
  });
});
