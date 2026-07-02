import { describe, expect, test, mock, beforeEach } from "bun:test";
import type {} from "bun:test";

// Override config BEFORE importing logging. Bun's mock.module replaces the
// module in the registry, so when logging.ts does `import { config }`, it gets
// our override instead of the real config that reads env vars at load time.
mock.module("../../src/config", () => ({
  config: {
    logBodyEnabled: true,
    logBodyFull: false,
    logBodyRedact: true,
    logBodyMaxBytes: 65536,
  },
}));

// Now import — logging.ts will pick up our mocked config.
const { prepareLogBody } = await import("../../src/proxy/logging");

describe("prepareLogBody", () => {
  test("redacts prompt-bearing keys without mutating the original", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const logged = prepareLogBody(body);

    // Original must not be mutated.
    expect(body.messages[0]?.content).toBe("hello");
    // Logged copy must be a different reference (redacted).
    expect(logged).not.toBe(body);
    expect(logged).toEqual({
      messages: [{ role: "user", content: "[redacted 5 chars]" }],
    });
  });

  test("leaves non-prompt keys intact", () => {
    const body = { model: "kp-opus", stream: true, n: 1 };
    const logged = prepareLogBody(body);
    expect(logged).toEqual({ model: "kp-opus", stream: true, n: 1 });
  });

  test("truncates very large values without mutating the original", () => {
    // `note` is not a redacted key, so it survives redaction and still
    // exercises the byte-size truncation path.
    const body = { note: "x".repeat(70_000) };
    const logged = prepareLogBody(body);

    // Original must not be mutated.
    expect(body.note).toHaveLength(70_000);
    // Logged copy must be a different reference (truncated).
    expect(logged).not.toBe(body);
    expect(logged).toMatchObject({ truncated: true, maxBytes: 65_536 });
    expect((logged as { preview: string }).preview.length).toBeGreaterThan(0);
  });
});
