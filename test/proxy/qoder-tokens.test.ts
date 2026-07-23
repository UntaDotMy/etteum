import { describe, expect, test } from "bun:test";
import {
  COSY_CLIENT_TYPE,
  COSY_VERSION,
  ensureCosyMachineFingerprint,
  hasQoderCredentials,
  isDeviceSessionToken,
  isSpoofedMachineFingerprint,
  MODEL_CONFIGS,
  normalizeQoderTokens,
} from "../../src/proxy/providers/qoder/helpers";

describe("normalizeQoderTokens", () => {
  test("accepts console PAT import shape (personalToken)", () => {
    const t = normalizeQoderTokens({
      personalToken: "pt-abc",
      machineId: "m1",
      machineToken: "opaque-token-not-m1",
      machineType: "a1b2",
      machineCode: "c3d4",
      machineOs: "x86_64_windows",
    });
    expect(t?.personalToken).toBe("pt-abc");
    expect(t?.authMode).toBe("pat");
    expect(t?.machineId).toBe("m1");
    expect(t?.securityOauthToken).toBeFalsy();
  });

  test("maps browser device-flow access_token → securityOauthToken (NOT personalToken)", () => {
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
    // Spoofed machine* from bare machine_id is healed for Cosy path.
    expect(t!.machineToken).not.toBe(t!.machineId);
    expect(t!.machineType).not.toBe("5");
    expect(t!.machineCode).toBeTruthy();
    expect(t!.machineOs).toBeTruthy();
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

  test("isDeviceSessionToken detects dt- prefix", () => {
    expect(isDeviceSessionToken("dt-abc")).toBe(true);
    expect(isDeviceSessionToken("DT_xyz")).toBe(true);
    expect(isDeviceSessionToken("pat-or-random-long-token")).toBe(false);
  });

  test("hasQoderCredentials true for PAT-only or session-only", () => {
    expect(
      hasQoderCredentials(
        normalizeQoderTokens({
          personalToken: "p",
          machineId: "m",
          machineToken: "opaque",
          machineType: "abcd",
          machineCode: "ef01",
          machineOs: "x86_64_windows",
        }),
      ),
    ).toBe(true);
    expect(
      hasQoderCredentials(
        normalizeQoderTokens({ access_token: "dt-x", machineId: "m" }),
      ),
    ).toBe(true);
    expect(hasQoderCredentials(normalizeQoderTokens({ email: "x@y.com" }))).toBe(false);
  });
});

describe("Cosy machine fingerprint + model map", () => {
  test("COSY chat wire matches Hermes Free0 path (1.15.1 / clienttype 0)", () => {
    expect(COSY_VERSION).toBe("1.15.1");
    expect(COSY_CLIENT_TYPE).toBe("0");
  });

  test("detects and heals old CLI spoof (machineToken==id, type 5)", () => {
    expect(
      isSpoofedMachineFingerprint({
        machineId: "uuid-1",
        machineToken: "uuid-1",
        machineType: "5",
      }),
    ).toBe(true);

    const healed = ensureCosyMachineFingerprint({
      machineId: "uuid-1",
      machineToken: "uuid-1",
      machineType: "5",
    } as any);
    expect(healed.machineId).toBe("uuid-1"); // locked, not rotated
    expect(healed.machineToken).not.toBe("uuid-1");
    expect(healed.machineType).not.toBe("5");
    expect(healed.machineCode).toBeTruthy();
    expect(healed.machineOs).toBe("x86_64_windows");
    // Stable across calls
    const again = ensureCosyMachineFingerprint({
      machineId: "uuid-1",
      machineToken: "uuid-1",
      machineType: "5",
    } as any);
    expect(again.machineToken).toBe(healed.machineToken);
    expect(again.machineType).toBe(healed.machineType);
  });

  test("preserves good stored machine* (does not rewrite to spoof)", () => {
    const good = {
      machineId: "uuid-good",
      machineToken: "opaque-token-not-id",
      machineType: "a1b2",
      machineCode: "c3d4",
      machineOs: "x86_64_windows",
    };
    expect(isSpoofedMachineFingerprint(good)).toBe(false);
    const kept = ensureCosyMachineFingerprint(good as any);
    expect(kept.machineToken).toBe("opaque-token-not-id");
    expect(kept.machineType).toBe("a1b2");
    expect(kept.machineCode).toBe("c3d4");
  });

  test("Kimi K3 is 1M context + reasoning; Qwen3.8 maps to qmodel_preview", () => {
    expect(MODEL_CONFIGS["qd-Kimi-K3"]?.upstream).toBe("kmodel_latest");
    expect(MODEL_CONFIGS["qd-Kimi-K3"]?.max_input_tokens).toBe(1_000_000);
    expect(MODEL_CONFIGS["qd-Kimi-K3"]?.is_reasoning).toBe(true);
    expect(MODEL_CONFIGS["qd-Qwen3.8-Max-Preview"]?.upstream).toBe("qmodel_preview");
    expect(MODEL_CONFIGS["qd-Qwen3.7-Max"]?.upstream).toBe("qmodel_latest");
    expect(MODEL_CONFIGS["qd-Kimi-K2.6"]?.upstream).toBe("kmodel");
  });
});

describe("parseSseLine Cosy deltas", () => {
  test("reads reasoning_content when content is empty (Kimi K3 thinking stream)", async () => {
    const { parseSseLine } = await import("../../src/proxy/providers/qoder/helpers");
    const line =
      'data: {"body":' +
      JSON.stringify(
        JSON.stringify({
          choices: [
            {
              delta: { role: "assistant", reasoning_content: "thinking…", content: "" },
            },
          ],
        }),
      ) +
      "}";
    const p = parseSseLine(line);
    expect(p).not.toBeNull();
    expect(p!.reasoningContent).toContain("thinking");
    // content empty string should not block reasoning
    expect(p!.content || p!.reasoningContent).toBeTruthy();
  });

  test("accepts flat OpenAI-shaped chunks without Cosy body wrapper", async () => {
    const { parseSseLine } = await import("../../src/proxy/providers/qoder/helpers");
    const line =
      'data: {"choices":[{"delta":{"content":"hello"}}]}';
    const p = parseSseLine(line);
    expect(p?.content).toBe("hello");
  });
});