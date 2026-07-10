import { describe, test, expect } from "bun:test";
import { calculateCost, MODEL_PRICING, toCanonicalModelName, getPricingForModel } from "./pricing";

describe("pricing calculateCost", () => {
  test("returns 0 for unknown model (never throws)", async () => {
    const cost = await calculateCost("totally-unknown-model-xyz", {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
    expect(cost).toBe(0);
  });

  test("returns 0 for empty/missing model", async () => {
    const cost = await calculateCost("", {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
    expect(cost).toBe(0);
  });

  test("computes input + output cost for a baseline-priced model", async () => {
    // claude-sonnet-4-5-20250929: input 3.00, output 15.00 per 1M
    const cost = await calculateCost("claude-sonnet-4-5-20250929", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
    // 1M input * 3.00/1M + 1M output * 15.00/1M = 3.00 + 15.00 = 18.00
    expect(cost).toBeCloseTo(18.0, 6);
  });

  test("applies cheaper cached rate to cached tokens, not full input rate", async () => {
    // claude-sonnet-4-5-20250929: input 3.00, cached 0.30 per 1M
    const cost = await calculateCost("claude-sonnet-4-5-20250929", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      cachedTokens: 800_000, // 800k cached, 200k fresh input
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
    // nonCachedInput = 200k * 3.00/1M = 0.60
    // cached = 800k * 0.30/1M = 0.24
    // total = 0.84
    expect(cost).toBeCloseTo(0.84, 6);
  });

  test("counts reasoning tokens at reasoning rate", async () => {
    // gpt-5: output 12.00, reasoning 18.00 per 1M
    const cost = await calculateCost("gpt-5", {
      promptTokens: 0,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 1_000_000,
    });
    // 1M output * 12.00/1M + 1M reasoning * 18.00/1M = 12 + 18 = 30
    expect(cost).toBeCloseTo(30.0, 6);
  });

  test("counts cache-creation tokens at cacheCreation rate", async () => {
    // claude-opus-4-6: input 5.00, cacheCreation 6.25 per 1M
    const cost = await calculateCost("claude-opus-4-6", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 2_000_000,
      cachedTokens: 0,
      cacheCreationTokens: 1_000_000,
      reasoningTokens: 0,
    });
    // nonCachedInput = 1M * 5.00/1M = 5.00 (no cached subtracted)
    // cacheCreation = 1M * 6.25/1M = 6.25
    // total = 11.25
    expect(cost).toBeCloseTo(11.25, 6);
  });

  test("all token types combined", async () => {
    // claude-opus-4-6: input 5.00, output 25.00, cached 0.50, reasoning 25.00, cacheCreation 6.25
    const cost = await calculateCost("claude-opus-4-6", {
      promptTokens: 2_000_000, // 1M fresh + 1M cached
      completionTokens: 500_000,
      totalTokens: 4_000_000,
      cachedTokens: 1_000_000,
      cacheCreationTokens: 200_000,
      reasoningTokens: 300_000,
    });
    // nonCachedInput = (2M - 1M) * 5.00/1M = 5.00
    // cached = 1M * 0.50/1M = 0.50
    // output = 500k * 25.00/1M = 12.50
    // reasoning = 300k * 25.00/1M = 7.50
    // cacheCreation = 200k * 6.25/1M = 1.25
    // total = 5.00 + 0.50 + 12.50 + 7.50 + 1.25 = 26.75
    expect(cost).toBeCloseTo(26.75, 6);
  });
});

describe("MODEL_PRICING baseline", () => {
  test("has entries for key models across providers", () => {
    expect(MODEL_PRICING["claude-sonnet-4-5-20250929"]).toBeDefined();
    expect(MODEL_PRICING["gpt-5"]).toBeDefined();
    expect(MODEL_PRICING["gemini-2.5-pro"]).toBeDefined();
  });

  test("every baseline entry has all 5 rate fields", () => {
    for (const [model, p] of Object.entries(MODEL_PRICING)) {
      expect(p.input, `${model}.input`).toBeGreaterThanOrEqual(0);
      expect(p.output, `${model}.output`).toBeGreaterThanOrEqual(0);
      expect(p.cached, `${model}.cached`).toBeGreaterThanOrEqual(0);
      expect(p.reasoning, `${model}.reasoning`).toBeGreaterThanOrEqual(0);
      expect(p.cacheCreation, `${model}.cacheCreation`).toBeGreaterThanOrEqual(0);
    }
  });

  test("cached rate is never more expensive than input rate", () => {
    for (const [model, p] of Object.entries(MODEL_PRICING)) {
      expect(p.cached, `${model}: cached should be <= input`).toBeLessThanOrEqual(p.input);
    }
  });
});

/**
 * Canonicalization: strip provider alias prefixes so pricing/spec lookups
 * resolve a model by its CANONICAL name, not the provider alias.
 *
 * The catalog (MODEL_PRICING / MODEL_SPECS) is keyed by canonical model name
 * (e.g. "glm-5.2", "claude-opus-4.8"). But a request's body.model can be a
 * provider-prefixed alias (e.g. "cbc-glm-5.2", "kp-opus-4.8"). Without
 * canonicalization, getPricingForModel("cbc-glm-5.2") returns null → cost = 0,
 * and the dashboard edit would store the override under the alias (wrong: it
 * wouldn't apply to glm-5.2 served by another provider).
 */
describe("toCanonicalModelName — strip provider aliases", () => {
  test("strips CodeBuddy (cb-) prefix", () => {
    expect(toCanonicalModelName("cb-claude-opus-4.6")).toBe("claude-opus-4.6");
  });
  test("strips CodeBuddy China (cbc-) prefix", () => {
    expect(toCanonicalModelName("cbc-glm-5.2")).toBe("glm-5.2");
  });
  test("strips Qoder (qd-) prefix", () => {
    expect(toCanonicalModelName("qd-claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
  });
  test("strips YouMind (ym-) prefix", () => {
    expect(toCanonicalModelName("ym-gpt-5")).toBe("gpt-5");
  });
  test("maps Kiro Pro (kp-) → claude- prefix", () => {
    expect(toCanonicalModelName("kp-opus-4.8")).toBe("claude-opus-4.8");
    expect(toCanonicalModelName("kp-sonnet-4.6")).toBe("claude-sonnet-4.6");
  });
  test("strips -thinking variant", () => {
    expect(toCanonicalModelName("claude-opus-4.8-thinking")).toBe("claude-opus-4.8");
    expect(toCanonicalModelName("kp-opus-4.8-thinking")).toBe("claude-opus-4.8");
  });
  test("keeps date suffix (date fallback is in getPricingForModel)", () => {
    expect(toCanonicalModelName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
    expect(toCanonicalModelName("qwen3.7-max-2026-06-08")).toBe("qwen3.7-max-2026-06-08");
  });
  test("returns the canonical name unchanged when no alias", () => {
    expect(toCanonicalModelName("glm-5.2")).toBe("glm-5.2");
    expect(toCanonicalModelName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
  test("handles empty/undefined", () => {
    expect(toCanonicalModelName("")).toBe("");
    expect(toCanonicalModelName(undefined as any)).toBe("");
  });
});

describe("getPricingForModel — resolves via canonical name", () => {
  test("resolves a prefixed alias to its canonical pricing", async () => {
    // cbc-glm-5.2 → glm-5.2 (which has a baseline entry).
    const pricing = await getPricingForModel("cbc-glm-5.2");
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBeGreaterThan(0);
  });
  test("resolves a kp- alias to claude- pricing", async () => {
    const pricing = await getPricingForModel("kp-opus-4.8");
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBe(5.0);
  });
  test("canonical name still resolves", async () => {
    const pricing = await getPricingForModel("glm-5.2");
    expect(pricing).not.toBeNull();
  });
});
