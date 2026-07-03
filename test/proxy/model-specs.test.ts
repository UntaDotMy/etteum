import { describe, expect, test } from "bun:test";
import { resolveModelSpec, applyModelSpecs, MODEL_SPECS } from "../../src/proxy/model-specs";
import type { ModelInfo } from "../../src/proxy/providers/base";

describe("model-specs registry", () => {
  test("resolves verified specs for key models", () => {
    expect(resolveModelSpec("glm-5.2")).toEqual({ contextWindow: 1_000_000, maxOutput: 131_072, thinking: true, vision: true });
    expect(resolveModelSpec("kimi-k2.7-code")).toEqual({ contextWindow: 262_144, maxOutput: 98_304, thinking: false, vision: false });
    expect(resolveModelSpec("deepseek-v4-pro")?.maxOutput).toBe(384_000);
    expect(resolveModelSpec("qwen3.7-max")?.maxOutput).toBe(65_536);
    expect(resolveModelSpec("qwen-max")?.contextWindow).toBe(32_000); // was wrongly 1M
    expect(resolveModelSpec("qwq-plus")?.contextWindow).toBe(128_000); // was wrongly 1M
    expect(resolveModelSpec("claude-opus-4.8")?.maxOutput).toBe(131_072); // was wrongly 64k
    expect(resolveModelSpec("gpt-5.5")?.maxOutput).toBe(131_072);
    expect(resolveModelSpec("gemini-2.5-pro")?.contextWindow).toBe(1_048_576);
  });

  test("forces thinking=true on -thinking variants", () => {
    const base = resolveModelSpec("claude-opus-4.8");
    const thinking = resolveModelSpec("claude-opus-4.8-thinking");
    expect(thinking?.thinking).toBe(true);
    expect(thinking?.contextWindow).toBe(base?.contextWindow);
    expect(thinking?.maxOutput).toBe(base?.maxOutput);
  });

  test("returns undefined for unknown models", () => {
    expect(resolveModelSpec("not-a-real-model")).toBeUndefined();
    expect(resolveModelSpec(undefined)).toBeUndefined();
  });

  test("dated snapshots inherit their base model's spec", () => {
    // qwen3.7-max-2026-06-08 should resolve like qwen3.7-max.
    const dated = resolveModelSpec("qwen3.7-max-2026-06-08");
    const base = resolveModelSpec("qwen3.7-max");
    expect(dated).toBeDefined();
    expect(dated?.contextWindow).toBe(base?.contextWindow);
    expect(dated?.maxOutput).toBe(base?.maxOutput);
    // A dated + thinking variant also works.
    const datedThinking = resolveModelSpec("claude-opus-4.8-2026-01-01-thinking");
    expect(datedThinking?.thinking).toBe(true);
    expect(datedThinking?.maxOutput).toBe(131_072);
  });

  test("applyModelSpecs patches a provider list by canonical name", () => {
    // cb-gpt-5.2 has NO ctx/maxOut in codebuddy.ts — the registry must fill them.
    const models: ModelInfo[] = [
      { id: "cb-gpt-5.2", object: "model", created: 0, owned_by: "codebuddy" } as ModelInfo,
      { id: "cb-enowx", object: "model", created: 0, owned_by: "codebuddy" } as ModelInfo, // not in registry
    ];
    const out = applyModelSpecs(models, (m) => m.id.replace(/^cb-/, ""));
    const [known, unknown] = out;
    expect(known?.context_window).toBe(400_000);
    expect(known?.max_output).toBe(131_072);
    // Unknown model is passed through unchanged.
    expect(unknown?.context_window).toBeUndefined();
  });

  test("the registry is non-empty and covers all major families", () => {
    const keys = Object.keys(MODEL_SPECS);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain("glm-5.2");
    expect(keys).toContain("claude-opus-4.8");
    expect(keys).toContain("gpt-5.5");
    expect(keys).toContain("gemini-2.5-pro");
    expect(keys).toContain("deepseek-v4-pro");
    expect(keys).toContain("kimi-k2.7-code");
  });
});
