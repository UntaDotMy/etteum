import { describe, expect, test } from "bun:test";
import {
  buildGrokImageResponsesBody,
  extractImageGenerationBase64,
  extractWebGeneratedImagePaths,
  getGrokWebSso,
  isGrokImageModel,
  isGrokImageEntitlementError,
  summarizeGrokImageResponseText,
  GROK_IMAGE_MODEL,
  GROK_IMAGE_UPSTREAM_MODEL,
  GROK_IMAGE_SUPERGROK_MSG,
} from "../../src/proxy/providers/grok/image";
import { buildChatPayload, resolveGrokAssetUrl } from "../../src/proxy/providers/grok/protocol";
import { GrokProvider, classifyGrokUpstreamError } from "../../src/proxy/providers/grok";
import { getProviderForModel, providers } from "../../src/proxy/providers/registry";
import { isNonAccountRequestError, isBadUpstreamRequest } from "../../src/proxy/errors";
import { normalizeGrokOAuthTokens } from "../../src/proxy/providers/grok/oauth";

describe("Grok image_generation tool path", () => {
  test("catalog model id is owned by grok provider", () => {
    expect(isGrokImageModel(GROK_IMAGE_MODEL)).toBe(true);
    expect(isGrokImageModel("grok-4.5-image")).toBe(true);
    expect(isGrokImageModel("grok-4.5")).toBe(false);
    expect(getProviderForModel(GROK_IMAGE_MODEL)).toBe("grok");
    expect(providers.grok.ownsModel(GROK_IMAGE_MODEL)).toBe(true);
  });

  test("build body matches cli-chat-proxy responses + forced image_generation tool", () => {
    const body = buildGrokImageResponsesBody("a red fox in snow");
    expect(body.model).toBe(GROK_IMAGE_UPSTREAM_MODEL);
    expect(body.stream).toBe(false);
    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
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

  test("extracts https asset URLs from image_generation_call", () => {
    const urls = extractImageGenerationBase64({
      output: [
        {
          type: "image_generation_call",
          result: "https://assets.grok.com/users/abc/generated/xyz.jpg",
        },
      ],
    });
    expect(urls).toEqual(["https://assets.grok.com/users/abc/generated/xyz.jpg"]);
  });

  test("ignores non-image strings", () => {
    expect(
      extractImageGenerationBase64({
        output: [{ type: "message", content: "hello" }],
      }),
    ).toEqual([]);
  });

  test("SuperGrok free-tier refusal is entitlement (non-account fail-fast)", () => {
    expect(isGrokImageEntitlementError(GROK_IMAGE_SUPERGROK_MSG)).toBe(true);
    expect(
      isGrokImageEntitlementError(
        "image_generation_not_entitled: Image generation is a SuperGrok feature",
      ),
    ).toBe(true);
    expect(isGrokImageEntitlementError("no image_generation_call result (base64)")).toBe(false);

    const classified = classifyGrokUpstreamError(
      new Error(
        "image_generation_not_entitled: Image generation is a SuperGrok feature and isn't available on the free or X Basic tier.",
      ),
    );
    expect(classified.success).toBe(false);
    expect(classified.error || "").toContain("image_generation_not_entitled");
    expect(isNonAccountRequestError(classified.error)).toBe(true);
    expect(isBadUpstreamRequest(classified.error)).toBe(true);
  });

  test("summarizeGrokImageResponseText surfaces SuperGrok copy from message output", () => {
    const text = summarizeGrokImageResponseText({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Image generation is a SuperGrok feature and isn't available on the free or X Basic tier.",
            },
          ],
        },
      ],
    });
    expect(text.toLowerCase()).toContain("supergrok");
  });

  test("credit unit is image for grok-image model", () => {
    const grok = new GrokProvider();
    expect(grok.getProviderCreditUnit(GROK_IMAGE_MODEL)).toBe("image");
    expect(grok.getProviderCreditRate(GROK_IMAGE_MODEL)).toBe(1);
  });

  test("free web payload enables image generation flags", () => {
    const body = buildChatPayload({
      message: "a cat",
      modeId: "AUTO",
      enableImageGeneration: true,
      imageGenerationCount: 2,
    });
    expect(body.enableImageGeneration).toBe(true);
    expect(body.enableImageStreaming).toBe(true);
    expect(body.imageGenerationCount).toBe(2);
    expect(body.temporary).toBe(true);
    // Normal chat stays off
    const chat = buildChatPayload({ message: "hi", modeId: "AUTO" });
    expect(chat.enableImageGeneration).toBe(false);
  });

  test("extractWebGeneratedImagePaths reads modelResponse.generatedImageUrls from SSE", () => {
    const path = "users/abc/generated/xyz.jpg";
    const sse = [
      `data: ${JSON.stringify({
        result: {
          response: {
            streamingImageGenerationResponse: { imageUrl: path, progress: 40 },
          },
        },
      })}`,
      "",
      `data: ${JSON.stringify({
        result: {
          response: {
            modelResponse: { generatedImageUrls: [path], message: "done" },
            isFinal: true,
          },
        },
      })}`,
      "",
    ].join("\n");
    const paths = extractWebGeneratedImagePaths(sse);
    expect(paths).toContain(path);
    expect(resolveGrokAssetUrl(path)).toBe(`https://assets.grok.com/${path}`);
  });

  test("getGrokWebSso reads sso from account tokens; normalize preserves sso on OAuth", () => {
    const account = {
      id: 1,
      tokens: JSON.stringify({
        auth_method: "oauth",
        access_token: "eyJhbGciOiJFUzI1NiJ9.e30.sig",
        refresh_token: "rt",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        sso: "sso-cookie-value",
        ssoRw: "sso-rw-value",
      }),
    } as any;
    expect(getGrokWebSso(account)).toEqual({
      sso: "sso-cookie-value",
      ssoRw: "sso-rw-value",
    });
    const norm = normalizeGrokOAuthTokens(JSON.parse(account.tokens));
    expect(norm?.sso).toBe("sso-cookie-value");
    expect(norm?.ssoRw).toBe("sso-rw-value");
    expect(getGrokWebSso({ id: 2, tokens: { access_token: "x" } } as any)).toBeNull();
  });
});
