import { describe, expect, test } from "bun:test";
import { normalizeQoderTokens } from "../../src/proxy/providers/qoder/helpers";

describe("normalizeQoderTokens", () => {
  test("accepts PAT import shape (personalToken)", () => {
    const t = normalizeQoderTokens({
      personalToken: "pt-abc",
      machineId: "m1",
      machineToken: "m1",
      machineType: "5",
    });
    expect(t?.personalToken).toBe("pt-abc");
    expect(t?.machineId).toBe("m1");
  });

  test("maps browser device-flow access_token → personalToken", () => {
    // This is the shape that caused "No personalToken available" after
    // camoufox_flow login + runner stripping fields.
    const t = normalizeQoderTokens({
      access_token: "dev-token",
      refresh_token: "ref",
      machine_id: "mid-1",
      user_id: "u1",
      email: "a@b.com",
    });
    expect(t).not.toBeNull();
    expect(t!.personalToken).toBe("dev-token");
    expect(t!.refreshToken).toBe("ref");
    expect(t!.machineId).toBe("mid-1");
    expect(t!.machineToken).toBe("mid-1");
    expect(t!.userId).toBe("u1");
    expect(t!.email).toBe("a@b.com");
  });

  test("returns null when no token field present", () => {
    expect(normalizeQoderTokens({ email: "x@y.com" })).toBeNull();
    expect(normalizeQoderTokens(null)).toBeNull();
  });
});
