import { describe, expect, test } from "bun:test";
import {
  buildGrokImageResponsesBody,
  extractImageGenerationBase64,
  isGrokImageModel,
  GROK_IMAGE_MODEL,
  GROK_IMAGE_UPSTREAM_MODEL,
} from "../../src/proxy/providers/grok/image";
import { GrokProvider } from "../../src/proxy/providers/grok";
import { getProviderForModel, providers } from "../../src/proxy/providers/registry";

describe("Grok image_generation tool path", () => {
  test("catalog model id is owned by grok provider", () => {
    expect(isGrokImageModel(GROK_IMAGE_MODEL)).toBe(true);
    expect(isGrokImageModel("grok-4.5-image")).toBe(true);
    expect(isGrokImageModel("grok-4.5")).toBe(false);
    expect(getProviderForModel(GROK_IMAGE_MODEL)).toBe("grok");
    expect(providers.grok.ownsModel(GROK_IMAGE_MODEL)).toBe(true);
  });

  test("build body matches cli-chat-proxy responses + image_generation tool", () => {
    const body = buildGrokImageResponsesBody("a red fox in snow");
    expect(body.model).toBe(GROK_IMAGE_UPSTREAM_MODEL);
    expect(body.stream).toBe(false);
    expect(body.tools).toEqual([{ type: "image_generation" }]);
    const input = body.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(input[0]!.role).toBe("user");
    expect(input[0]!.content[0]!.type).toBe("input_text");
    expect(input[0]!.content[0]!.text).toContain("a red fox in snow");
    expect(input[0]!.content[0]!.text).toContain("image_generation");
  });

  test("extracts base64 from image_generation_call result", () => {
    // Minimal valid JPEG base64 prefix (FF D8 FF) + padding so length checks pass.
    const jpegB64 =
      "/9j/" + "A".repeat(80) +
      "abcdefghijklmnopqrstuvwxyz0123456789+/==";
    const payload = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
        { type: "image_generation_call", result: jpegB64 },
      ],
    };
    const urls = extractImageGenerationBase64(payload);
    expect(urls.length).toBe(1);
    expect(urls[0]!.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(urls[0]!.includes(jpegB64)).toBe(true);
  });

  test("extracts nested items array shape", () => {
    const pngB64 = "iVBOR" + "B".repeat(80);
    const urls = extractImageGenerationBase64({
      items: [{ type: "image_generation_call", result: pngB64 }],
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("ignores non-image strings", () => {
    expect(
      extractImageGenerationBase64({
        output: [{ type: "message", content: "hello" }],
      }),
    ).toEqual([]);
  });

  test("credit unit is image for grok-image model", () => {
    const grok = new GrokProvider();
    expect(grok.getProviderCreditUnit(GROK_IMAGE_MODEL)).toBe("image");
    expect(grok.getProviderCreditRate(GROK_IMAGE_MODEL)).toBe(1);
  });
});
