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
    const p = MODEL_PRICING["gpt-5"];
    if (!p) throw new Error("gpt-5 missing from MODEL_PRICING");
    const cost = await calculateCost("gpt-5", {
      promptTokens: 0,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 1_000_000,
    });
    // 1M output + 1M reasoning, each billed at its catalog rate. Expected is
    // derived from the table so rate updates don't stale this mechanism test.
    expect(cost).toBeCloseTo(p.output + p.reasoning, 6);
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

  test("GPT-5.6 family pins the post-July-30 official OpenAI rates", () => {
    // Verified against developers.openai.com/api/docs/pricing 2026-08-09.
    expect(MODEL_PRICING["gpt-5.6-sol"]).toEqual({ input: 5.00, output: 30.00, cached: 0.50, reasoning: 30.00, cacheCreation: 6.25 });
    expect(MODEL_PRICING["gpt-5.6-terra"]).toEqual({ input: 2.00, output: 12.00, cached: 0.20, reasoning: 12.00, cacheCreation: 2.50 });
    expect(MODEL_PRICING["gpt-5.6-luna"]).toEqual({ input: 0.20, output: 1.20, cached: 0.02, reasoning: 1.20, cacheCreation: 0.25 });
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
  test("strips Alibaba (ali-) prefix", () => {
    expect(toCanonicalModelName("ali-qwen-plus")).toBe("qwen-plus");
    expect(toCanonicalModelName("ali-qwen-plus-2025-07-14")).toBe("qwen-plus-2025-07-14");
  });
  test("strips vendor/ path (openai/, google/, …)", () => {
    expect(toCanonicalModelName("openai/gpt-4o")).toBe("gpt-4o");
    expect(toCanonicalModelName("google/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(toCanonicalModelName("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4.5");
  });
  test("maps Claude short names after cb-/cbc- strip", () => {
    expect(toCanonicalModelName("cb-opus-4.8")).toBe("claude-opus-4.8");
    expect(toCanonicalModelName("cbc-haiku-4.5")).toBe("claude-haiku-4.5");
    expect(toCanonicalModelName("cb-sonnet-4.6")).toBe("claude-sonnet-4.6");
  });
  test("maps kimi-k2.7 → kimi-k2.7-code SKU", () => {
    expect(toCanonicalModelName("cbc-kimi-k2.7")).toBe("kimi-k2.7-code");
    expect(toCanonicalModelName("kimi-k2.7")).toBe("kimi-k2.7-code");
  });
  test("maps cb-kimi-k3 / cbc-kimi-k3 → kimi-k3", () => {
    expect(toCanonicalModelName("cb-kimi-k3")).toBe("kimi-k3");
    expect(toCanonicalModelName("cbc-kimi-k3")).toBe("kimi-k3");
    expect(toCanonicalModelName("kimi-k3")).toBe("kimi-k3");
  });
  test("maps Kiro Pro (kp-) → claude- prefix for Anthropic short names only", () => {
    expect(toCanonicalModelName("kp-opus-4.8")).toBe("claude-opus-4.8");
    expect(toCanonicalModelName("kp-sonnet-4.6")).toBe("claude-sonnet-4.6");
    // kp-auto is a router, not claude-auto
    expect(toCanonicalModelName("kp-auto")).toBe("gpt-5.5");
  });
  test("lowercases and maps Qoder display names", () => {
    expect(toCanonicalModelName("qd-Qwen3.7-Max")).toBe("qwen3.7-max");
    expect(toCanonicalModelName("qd-DeepSeek-V4-Pro")).toBe("deepseek-v4-pro");
    expect(toCanonicalModelName("qd-Ultimate")).toBe("claude-opus-4.8");
  });
  test("strips -1m context variants and codex-/ag- prefixes", () => {
    expect(toCanonicalModelName("cb-opus-4.8-1m")).toBe("claude-opus-4.8");
    expect(toCanonicalModelName("codex-gpt-5.5")).toBe("gpt-5.5");
    expect(toCanonicalModelName("ag-gemini-3-flash")).toBe("gemini-3-flash");
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
  test("normalizes underscores to hyphens for catalog lookup only", () => {
    // Provider may probe as gpt_5.2; catalog key is gpt-5.2. Live model id stays as-is.
    expect(toCanonicalModelName("gpt_5.2")).toBe("gpt-5.2");
    expect(toCanonicalModelName("claude_opus_4.8")).toBe("claude-opus-4.8");
    expect(toCanonicalModelName("openrouter-gpt_5.2")).toBe("openrouter-gpt-5.2");
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
  test("underscore provider id still resolves hyphen catalog price", async () => {
    // Upstream may list the model as gpt_5.2; we keep that id, but price as gpt-5.2.
    const a = await getPricingForModel("gpt_5.2");
    const b = await getPricingForModel("gpt-5.2");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.input).toBe(b!.input);
    expect(a!.output).toBe(b!.output);
  });
  test("prefixed BYOK-style id resolves bare catalog price", async () => {
    const pricing = await getPricingForModel("myrouter-gpt_5.2");
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBeGreaterThan(0);
  });
  test("effort suffixes high/xhigh inherit base model price (gpt-5.5)", async () => {
    // Live id stays gpt-5.5-high / gpt-5.5-xhigh; catalog rates come from gpt-5.5.
    const base = await getPricingForModel("gpt-5.5");
    const high = await getPricingForModel("gpt-5.5-high");
    const xhigh = await getPricingForModel("gpt-5.5-xhigh");
    const underscored = await getPricingForModel("gpt_5.5_xhigh");
    expect(base).not.toBeNull();
    expect(high!.input).toBe(base!.input);
    expect(high!.output).toBe(base!.output);
    expect(xhigh!.input).toBe(base!.input);
    expect(underscored!.input).toBe(base!.input);
  });
  test("codex effort variants inherit same official gpt-5.3-codex rate", async () => {
    const base = await getPricingForModel("gpt-5.3-codex");
    const xhigh = await getPricingForModel("gpt-5.3-codex-xhigh");
    expect(base).not.toBeNull();
    expect(xhigh!.input).toBe(base!.input);
    expect(xhigh!.output).toBe(base!.output);
    expect(base!.input).toBe(1.75);
  });
  test("vendor/ path ids resolve bare catalog prices", async () => {
    const gpt = await getPricingForModel("openai/gpt-4o");
    const gem = await getPricingForModel("google/gemini-2.5-pro");
    expect(gpt).not.toBeNull();
    expect(gpt!.input).toBe(MODEL_PRICING["gpt-4o"]!.input);
    expect(gem).not.toBeNull();
    expect(gem!.input).toBe(MODEL_PRICING["gemini-2.5-pro"]!.input);
  });
  test("ali- dated qwen-plus resolves to qwen-plus rates", async () => {
    const pricing = await getPricingForModel("ali-qwen-plus-2025-07-14");
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBe(MODEL_PRICING["qwen-plus"]!.input);
    expect(pricing!.output).toBe(MODEL_PRICING["qwen-plus"]!.output);
  });
  test("cb-/cbc- Claude short names resolve catalog rates", async () => {
    const opus = await getPricingForModel("cb-opus-4.8");
    const haiku = await getPricingForModel("cbc-haiku-4.5");
    expect(opus).not.toBeNull();
    expect(opus!.input).toBe(MODEL_PRICING["claude-opus-4.8"]!.input);
    expect(haiku).not.toBeNull();
    expect(haiku!.input).toBe(MODEL_PRICING["claude-haiku-4.5"]!.input);
  });
  test("cbc kimi / glm-5v-turbo resolve catalog rates", async () => {
    const k25 = await getPricingForModel("cbc-kimi-k2.5");
    const k27 = await getPricingForModel("cbc-kimi-k2.7");
    const k3 = await getPricingForModel("cb-kimi-k3");
    const k3cn = await getPricingForModel("cbc-kimi-k3");
    const glm = await getPricingForModel("cbc-glm-5v-turbo");
    expect(k25).not.toBeNull();
    expect(k25!.input).toBe(MODEL_PRICING["kimi-k2.5"]!.input);
    expect(k27).not.toBeNull();
    expect(k27!.input).toBe(MODEL_PRICING["kimi-k2.7-code"]!.input);
    expect(k3).not.toBeNull();
    expect(k3!.input).toBe(MODEL_PRICING["kimi-k3"]!.input);
    expect(k3!.output).toBe(15.00);
    expect(k3cn).not.toBeNull();
    expect(k3cn!.input).toBe(MODEL_PRICING["kimi-k3"]!.input);
    expect(k3cn!.output).toBe(15.00);
    expect(glm).not.toBeNull();
    expect(glm!.input).toBe(1.20);
    expect(glm!.output).toBe(4.00);
  });
  test("previously unmapped provider ids all resolve non-null pricing", async () => {
    const ids = [
      "qd-Auto", "qd-Ultimate", "qd-Qwen3.7-Max", "qd-Qwen3.8-Max-Preview", "qd-Kimi-K2.6", "qd-Kimi-K3",
      "qd-DeepSeek-V4-Pro", "qd-DeepSeek-V4-Flash", "qd-GLM-5.1", "qd-MiniMax-M3", "qd-MiniMax-M2.7", "qd-Lite",
      "cb-opus-4.8-1m", "cb-gemini-3.0-flash", "cb-gemini-3.1-flash-lite", "cb-default",
      "cbc-deepseek-r1", "cbc-deepseek-v3", "cbc-deepseek-v3-2-volc", "cbc-hy3-preview",
      "codex-auto", "codex-gpt-5.5", "auto", "kp-auto",
      "ali-qwen-image-max", "canva-image", "cursor-fast", "claude-3.5-sonnet",
      "openrouter/auto", "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "ag-gemini-3-pro",
    ];
    for (const id of ids) {
      const p = await getPricingForModel(id);
      expect(p, `expected pricing for ${id}`).not.toBeNull();
      expect(p!.input + p!.output, `expected positive rate for ${id}`).toBeGreaterThan(0);
    }
  });
});
