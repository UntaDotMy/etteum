/**
 * Tests for OAuth codex session persistence (audit fix H6).
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
process.env.POOLPROX_OAUTH_SESSION_FILE =
  require("node:os").tmpdir() + "/etteum-oauth-test-" + Date.now() + ".json";

import { describe, test, expect } from "bun:test";
import {
  createCodexOAuthSession,
  getCodexOAuthSession,
  updateCodexOAuthSession,
  deleteCodexOAuthSession,
  consumeCodexOAuthSession,
} from "../../src/api/oauth-codex-session";

describe("OAuth codex session persistence (H6)", () => {
  test("create + get round-trips", () => {
    const s = createCodexOAuthSession({
      state: "state-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://localhost/cb",
    });
    expect(s.status).toBe("pending");
    const got = getCodexOAuthSession("state-1");
    expect(got).not.toBeNull();
    expect(got!.codeVerifier).toBe("verifier-1");
  });

  test("update mutates and persists", () => {
    createCodexOAuthSession({
      state: "state-2",
      codeVerifier: "v2",
      redirectUri: "http://localhost/cb",
    });
    const updated = updateCodexOAuthSession("state-2", { status: "done" });
    expect(updated!.status).toBe("done");
    expect(getCodexOAuthSession("state-2")!.status).toBe("done");
  });

  test("get returns null for unknown state", () => {
    expect(getCodexOAuthSession("nonexistent")).toBeNull();
  });

  test("update returns null for unknown state", () => {
    expect(updateCodexOAuthSession("nope", { status: "done" })).toBeNull();
  });

  test("delete removes the session", () => {
    createCodexOAuthSession({
      state: "state-3",
      codeVerifier: "v3",
      redirectUri: "http://localhost/cb",
    });
    expect(deleteCodexOAuthSession("state-3")).toBe(true);
    expect(getCodexOAuthSession("state-3")).toBeNull();
  });

  test("delete returns false for unknown", () => {
    expect(deleteCodexOAuthSession("never-existed")).toBe(false);
  });

  test("consume returns session with consumedAt", () => {
    createCodexOAuthSession({
      state: "state-4",
      codeVerifier: "v4",
      redirectUri: "http://localhost/cb",
    });
    const consumed = consumeCodexOAuthSession("state-4");
    expect(consumed).not.toBeNull();
    expect(consumed!.consumedAt).toBeDefined();
  });

  test("survives a reload (data is on disk)", () => {
    createCodexOAuthSession({
      state: "state-5",
      codeVerifier: "v5",
      redirectUri: "http://localhost/cb",
    });
    const { readFileSync } = require("node:fs");
    const raw = readFileSync(process.env.POOLPROX_OAUTH_SESSION_FILE, "utf8");
    const arr = JSON.parse(raw);
    expect(arr.some((s: any) => s.state === "state-5")).toBe(true);
  });
});