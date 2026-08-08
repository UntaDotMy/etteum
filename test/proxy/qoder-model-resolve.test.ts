/**
 * Qoder model→upstream-key resolution (regression, 2026-08-08).
 *
 * The old exact-match lookup (MODEL_CONFIGS[request.model] || QODER_MODELS[0])
 * silently dispatched any case variant, legacy qd/ id, or live-catalog raw-key
 * id to qd-Auto — "ask for Kimi K3, get Auto". resolveQoderModelConfig must
 * resolve every shape to the right upstream key and only fall back to Auto
 * for genuinely unknown ids.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect } from "bun:test";
import {
  resolveQoderModelConfig,
  qoderUpstreamKey,
  friendlyIdForUpstream,
} from "../../src/proxy/providers/qoder/helpers";

describe("resolveQoderModelConfig", () => {
  test("exact curated id resolves to its upstream key", () => {
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-Kimi-K3"))).toBe("kmodel_latest");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-Qwen3.7-Max"))).toBe("qmodel_latest");
  });

  test("lowercase id resolves like the curated id (no Auto fallback)", () => {
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-kimi-k3"))).toBe("kmodel_latest");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-qwen3.7-max"))).toBe("qmodel_latest");
  });

  test("legacy qd/ ids resolve from the embedded key", () => {
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd/kmodel_latest"))).toBe("kmodel_latest");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd/auto"))).toBe("auto");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd/qmodel_38max"))).toBe("qmodel_38max");
  });

  test("live raw-key ids synthesize a config instead of falling back to Auto", () => {
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-qmodel_38max"))).toBe("qmodel_38max");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-brand_new"))).toBe("brand_new");
  });

  test("genuinely unknown id falls back to Auto", () => {
    expect(qoderUpstreamKey(resolveQoderModelConfig("not-a-model"))).toBe("auto");
  });
});

describe("live catalog key retargets (2026-08)", () => {
  test("friendly ids map to current upstream keys", () => {
    expect(friendlyIdForUpstream("qmodel_38max")).toBe("qd-Qwen3.8-Max");
    expect(friendlyIdForUpstream("qmodel")).toBe("qd-Qwen3.7-Plus");
    expect(friendlyIdForUpstream("kmodel")).toBe("qd-Kimi-K2.7-Code");
    expect(friendlyIdForUpstream("gm51model")).toBe("qd-GLM-5.2");
    expect(friendlyIdForUpstream("kmodel_latest")).toBe("qd-Kimi-K3");
  });

  test("curated SKUs point at the keys the live catalog serves", () => {
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-Qwen3.8-Max"))).toBe("qmodel_38max");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-Qwen3.7-Plus"))).toBe("qmodel");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-Kimi-K2.7-Code"))).toBe("kmodel");
    expect(qoderUpstreamKey(resolveQoderModelConfig("qd-GLM-5.2"))).toBe("gm51model");
  });
});
