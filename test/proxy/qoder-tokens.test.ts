import { describe, expect, test } from "bun:test";
import {
  hasQoderCredentials,
  isDeviceSessionToken,
  normalizeQoderTokens,
} from "../../src/proxy/providers/qoder/helpers";

describe("normalizeQoderTokens", () => {
  test("accepts console PAT import shape (personalToken)", () => {
    const t = normalizeQoderTokens({
      personalToken: "pt-abc",
      machineId: "m1",
      machineToken: "m1",
      machineType: "5",
    });
    expect(t?.personalToken).toBe("pt-abc");
    expect(t?.authMode).toBe("pat");
    expect(t?.machineId).toBe("m1");
    // No session yet — jobToken will mint securityOauthToken.
    expect(t?.securityOauthToken).toBeFalsy();
  });

  test("maps browser device-flow access_token → securityOauthToken (NOT personalToken)", () => {
    // Device poll body.token is a session credential (often dt-…), not a PAT.
    // Putting it in personalToken caused jobToken 401 "personal token is invalid".
    const t = normalizeQoderTokens({
      access_token: "dt-device-session",
      refresh_token: "ref",
      machine_id: "mid-1",
      user_id: "u1",
      email: "a@b.com",
    });
    expect(t).not.toBeNull();
    expect(t!.personalToken).toBeFalsy();
    expect(t!.securityOauthToken).toBe("dt-device-session");
    expect(t!.authMode).toBe("device");
    expect(t!.refreshToken).toBe("ref");
    expect(t!.machineId).toBe("mid-1");
    expect(t!.userId).toBe("u1");
  });

  test("heals historical wrong mapping personalToken=access_token=dt-…", () => {
    const t = normalizeQoderTokens({
      personalToken: "dt-bad-mapped",
      access_token: "dt-bad-mapped",
      machineId: "m2",
      machineToken: "m2",
      machineType: "5",
    });
    expect(t).not.toBeNull();
    expect(t!.personalToken).toBeFalsy();
    expect(t!.securityOauthToken).toBe("dt-bad-mapped");
    expect(t!.authMode).toBe("device");
  });

  test("heals personalToken-only field that is actually a device session", () => {
    const t = normalizeQoderTokens({
      personalToken: "dt-only-field",
      machineId: "m3",
      machineToken: "m3",
      machineType: "5",
    });
    expect(t!.personalToken).toBeFalsy();
    expect(t!.securityOauthToken).toBe("dt-only-field");
    expect(t!.authMode).toBe("device");
  });

  test("isDeviceSessionToken detects dt- prefix", () => {
    expect(isDeviceSessionToken("dt-abc")).toBe(true);
    expect(isDeviceSessionToken("DT_xyz")).toBe(true);
    expect(isDeviceSessionToken("pat-or-random-long-token")).toBe(false);
  });

  test("hasQoderCredentials true for PAT-only or session-only", () => {
    expect(hasQoderCredentials(normalizeQoderTokens({ personalToken: "p", machineId: "m", machineToken: "m", machineType: "5" }))).toBe(true);
    expect(hasQoderCredentials(normalizeQoderTokens({ access_token: "dt-x", machineId: "m", machineToken: "m", machineType: "5" }))).toBe(true);
    expect(hasQoderCredentials(normalizeQoderTokens({ email: "x@y.com" }))).toBe(false);
    expect(hasQoderCredentials(null)).toBe(false);
  });

  test("returns null when no token field present", () => {
    expect(normalizeQoderTokens({ email: "x@y.com" })).toBeNull();
    expect(normalizeQoderTokens(null)).toBeNull();
  });
});
