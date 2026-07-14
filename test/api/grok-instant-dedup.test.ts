/**
 * Grok bulk refresh-token identity / dedup helpers (no network).
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect } from "bun:test";
import {
  grokOAuthEmailFromIdentity,
  uniqueTokenLines,
} from "../../src/api/accounts/actionroutes";

describe("uniqueTokenLines", () => {
  test("dedupes exact tokens and drops blanks", () => {
    expect(
      uniqueTokenLines(["  aaa  ", "bbb", "aaa", "", "  ", "ccc", "bbb"]),
    ).toEqual(["aaa", "bbb", "ccc"]);
  });

  test("preserves first-seen order", () => {
    expect(uniqueTokenLines(["z", "a", "z", "a", "m"])).toEqual(["z", "a", "m"]);
  });
});

describe("grokOAuthEmailFromIdentity", () => {
  test("prefers real email when present", () => {
    expect(
      grokOAuthEmailFromIdentity({
        email: "user@x.ai",
        sub: "oidc-sub-12345678",
      }),
    ).toBe("user@x.ai");
  });

  test("uses full sub (not truncated) for oauth label", () => {
    const sub = "abcdefghijklmnopqrstuvwxyz012345";
    expect(grokOAuthEmailFromIdentity({ sub })).toBe(`grok-${sub}@oauth`);
    // Old short form would collide more easily — ensure we do not truncate.
    expect(grokOAuthEmailFromIdentity({ sub })).not.toBe(
      `grok-${sub.slice(0, 8)}@oauth`,
    );
  });

  test("falls back to token suffix when no sub", () => {
    const tok = "refresh-token-value-XYZEND";
    const email = grokOAuthEmailFromIdentity({ tokenFallback: tok });
    expect(email.endsWith("@token.local")).toBe(true);
    expect(email.includes("XYZEND") || email.includes(tok.slice(-12))).toBe(true);
  });
});
