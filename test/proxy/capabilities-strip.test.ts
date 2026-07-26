/**
 * §4.1; stripUnsupportedCapabilities used to report `visionStripped: true`
 * while leaving the image in place: every branch pushes exactly one block, so
 * the old `newBlocks.length !== msg.content.length` write-back never fired.
 *
 * These tests pin both halves of the fix:
 *   1. a declared vision-less model really loses the image, and
 *   2. nothing is stripped when capabilities are unknown or say vision:true; 
 *      otherwise turning the path on would break every working image flow.
 */
import { describe, test, expect } from "bun:test";
import {
  detectRequiredCapabilities,
  getCapabilities,
  isProviderCapabilityKnown,
  stripUnsupportedCapabilities,
} from "../../src/proxy/capabilities";

const imageMessages = () => [
  {
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ] as any[],
  },
];

const hasImage = (msgs: any[]) => JSON.stringify(msgs).includes("base64,AAAA");
const placeholderCount = (msgs: any[]) =>
  JSON.stringify(msgs).split("[Image removed").length - 1;

describe("stripUnsupportedCapabilities — write-back actually happens", () => {
  test("declared vision-less model: image is replaced with a placeholder", () => {
    const msgs = imageMessages();
    const res = stripUnsupportedCapabilities(msgs, "codex", "gpt-5-codex", { vision: false });
    expect(res.visionStripped).toBe(true);
    expect(hasImage(msgs)).toBe(false);
    expect(placeholderCount(msgs)).toBe(1);
  });

  test("block count is preserved (placeholder substitutes 1:1)", () => {
    const msgs = imageMessages();
    stripUnsupportedCapabilities(msgs, "codex", "gpt-5-codex", { vision: false });
    expect((msgs[0]!.content as any[]).length).toBe(2);
    expect((msgs[0]!.content as any[])[0]).toEqual({ type: "text", text: "what is this" });
  });

  test("provider table alone is enough when the model declares nothing", () => {
    const msgs = imageMessages();
    const res = stripUnsupportedCapabilities(msgs, "kiro", "some-kiro-model");
    expect(res.visionStripped).toBe(true);
    expect(hasImage(msgs)).toBe(false);
  });
});

describe("stripUnsupportedCapabilities — must NOT strip when unsupported is unproven", () => {
  test("per-model vision:true overrides a vision-less provider table", () => {
    const msgs = imageMessages();
    const res = stripUnsupportedCapabilities(msgs, "kiro", "kiro-vision-model", { vision: true });
    expect(res.visionStripped).toBe(false);
    expect(hasImage(msgs)).toBe(true);
  });

  test("undeclared provider with no per-model info is left untouched", () => {
    expect(isProviderCapabilityKnown("byok")).toBe(false);
    const msgs = imageMessages();
    const res = stripUnsupportedCapabilities(msgs, "byok", "openai/gpt-4o");
    expect(res.visionStripped).toBe(false);
    expect(hasImage(msgs)).toBe(true);
  });

  test("a vision-capable declared provider keeps the image", () => {
    const msgs = imageMessages();
    const res = stripUnsupportedCapabilities(msgs, "alibaba", "qwen3-vl-plus");
    expect(res.visionStripped).toBe(false);
    expect(hasImage(msgs)).toBe(true);
  });

  test("string content is never touched", () => {
    const msgs = [{ role: "user", content: "plain text" }];
    const res = stripUnsupportedCapabilities(msgs, "codex", "gpt-5-codex", { vision: false });
    expect(res.visionStripped).toBe(false);
    expect(msgs[0]!.content).toBe("plain text");
  });
});

describe("capability lookup surface", () => {
  test("isProviderCapabilityKnown distinguishes declared from absent", () => {
    expect(isProviderCapabilityKnown("kiro")).toBe(true);
    expect(isProviderCapabilityKnown("cursor")).toBe(false);
    expect(isProviderCapabilityKnown("openai")).toBe(false);
  });

  test("detectRequiredCapabilities still flags vision for image blocks", () => {
    expect([...detectRequiredCapabilities(imageMessages())]).toContain("vision");
  });

  test("getCapabilities is unchanged for declared providers", () => {
    expect(getCapabilities("canva", "anything").vision).toBe(true);
  });
});
