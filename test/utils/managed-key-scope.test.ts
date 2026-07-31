import { describe, expect, test } from "bun:test";
import { isManagedKeyHttpRouteAllowed } from "../../src/utils/security";

describe("managed-key client scope", () => {
  test("allows only the completion-compatible HTTP surface", () => {
    expect(isManagedKeyHttpRouteAllowed("GET", "/v1/models")).toBe(true);
    expect(isManagedKeyHttpRouteAllowed("POST", "/v1/chat/completions")).toBe(true);
    expect(isManagedKeyHttpRouteAllowed("POST", "/v1/messages")).toBe(true);
    expect(isManagedKeyHttpRouteAllowed("POST", "/v1/messages/count_tokens")).toBe(true);
    expect(isManagedKeyHttpRouteAllowed("POST", "/v1/responses/")).toBe(true);
    expect(isManagedKeyHttpRouteAllowed("POST", "/backend-api/codex/responses")).toBe(true);
  });

  test("denies MCP, search, media, embeddings, and future auxiliary routes", () => {
    for (const route of [
      "/v1/mcp/plugins",
      "/v1/mcp/filesystem/sse",
      "/v1/search",
      "/v1/search/providers",
      "/v1/audio/speech",
      "/v1/images/generations",
      "/v1/embeddings",
      "/v1/future-capability",
    ]) {
      expect(isManagedKeyHttpRouteAllowed("POST", route)).toBe(false);
      expect(isManagedKeyHttpRouteAllowed("GET", route)).toBe(false);
    }
  });

  test("does not allow a different method on an allowed path", () => {
    expect(isManagedKeyHttpRouteAllowed("GET", "/v1/chat/completions")).toBe(false);
    expect(isManagedKeyHttpRouteAllowed("POST", "/v1/models")).toBe(false);
  });
});
