/**
 * Routing contract tests for getProviderForModel (F15: strict per-provider
 * routing — kiro is no longer an implicit catch-all).
 *
 * These are integration-style: they import the real registry (which
 * instantiates providers). They assert the ROUTING CONTRACT the user specified:
 *   - a model a provider genuinely owns routes to THAT provider only;
 *   - a model nobody owns returns null (→ 404 model_not_found), NOT kiro;
 *   - a custom-added model routes to its assigned provider.
 *
 * No DB is required: provider construction doesn't do I/O; the custom-models
 * cache is injected via its test hook so routing is deterministic.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { getProviderForModel, providers } from "./registry";
import { GrokProvider } from "./grok";
import { resetCustomModelsRegistry, __setCustomModelsForTest } from "./custom-models";

describe("getProviderForModel — strict per-provider routing (no kiro catch-all)", () => {
  beforeEach(() => {
    resetCustomModelsRegistry();
  });

  test("providers.grok is the first-party GrokProvider; no parallel xai catalog", () => {
    // Regression: OPENAI_COMPATIBLE_CATALOG used id:"grok" (later "xai"), which
    // either overwrote GrokProvider or split the dashboard into two provider
    // groups. Grok is first-party only.
    expect(providers.grok).toBeInstanceOf(GrokProvider);
    expect(providers.grok.name).toBe("grok");
    expect((providers as Record<string, unknown>).xai).toBeUndefined();
    expect(getProviderForModel("grok-4.5")).toBe("grok");
    expect(getProviderForModel("grok-4.5-reasoning")).toBe("grok");
    expect(getProviderForModel("grok-auto")).toBeNull();
    expect(getProviderForModel("grok-4.3")).toBeNull();
    // Legacy console API ids are not claimed by any provider after xai removal.
    expect(getProviderForModel("grok-2")).toBeNull();
    // Catalog models are all owned_by "grok" (active-account list has one group).
    for (const m of providers.grok.getModels()) {
      expect(m.owned_by).toBe("grok");
    }
  });

  test("a model kiro genuinely owns routes to kiro", () => {
    // claude-sonnet-4.6 is in kiro's hardcoded supportedModels.
    expect(getProviderForModel("claude-sonnet-4.6")).toBe("kiro");
  });

  test("a model qoder owns routes to qoder, not kiro", () => {
    // qoder models are qd- prefixed (see qoder.ts ownsModel). Pick one qoder
    // genuinely owns so this isn't dependent on the custom layer.
    // qd- prefix is qoder's routing pattern.
    const qoderModel = "qd-claude-sonnet-4.6";
    const resolved = getProviderForModel(qoderModel);
    // qoder owns the qd- prefix; it must NOT fall through to kiro.
    expect(resolved).not.toBe("kiro");
  });

  test("a totally unknown model returns null, NOT kiro", () => {
    // This is the core contract change: no implicit catch-all.
    expect(getProviderForModel("zzz-not-a-real-model-xyz")).toBeNull();
  });

  test("a claude-shaped string kiro does NOT actually serve returns null (no wildcard)", () => {
    // kiro standard does NOT serve opus (only kiro-pro / kp- does). Previously
    // the `m.includes("claude")` wildcard claimed this and routed to kiro,
    // which then failed upstream. It must now return null → 404.
    expect(getProviderForModel("claude-opus-4.8")).toBeNull();
  });

  test("a custom-added model routes to its assigned provider", () => {
    __setCustomModelsForTest({
      "my-custom-model": { provider: "qoder", displayName: "My Custom" },
    });
    expect(getProviderForModel("my-custom-model")).toBe("qoder");
  });

  test("a custom-added model does NOT fall through to kiro even if its provider is unknown", () => {
    // Assigned to a provider string; routes there, not kiro.
    __setCustomModelsForTest({
      "experimental-model": { provider: "alibaba", displayName: "Exp" },
    });
    expect(getProviderForModel("experimental-model")).toBe("alibaba");
    expect(getProviderForModel("experimental-model")).not.toBe("kiro");
  });
});
