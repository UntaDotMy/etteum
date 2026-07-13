/**
 * Tests for the custom-models registry (F15: dashboard-driven model catalog).
 *
 * These cover the PURE resolution layer — the functions that turn loaded
 * custom/disabled entries into routing + listing decisions. The DB-loading
 * half (refresh() from the kv table) is exercised via the management API
 * integration path; here we inject the in-memory entries directly so the
 * routing/listing logic is tested in isolation, mirroring how
 * compatible-node's getProviderForModel reads its in-memory cache.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetCustomModelsRegistry,
  __setCustomModelsForTest,
  __setDisabledModelsForTest,
  getCustomModelProvider,
  getCustomModels,
  isModelDisabled,
  applyCustomModelsToList,
  getUpstreamNameOverride,
} from "./custom-models";
import type { ModelInfo } from "./base";

const baseModel = (id: string, owned_by: string): ModelInfo => ({
  id,
  object: "model",
  created: 0,
  owned_by,
  context_window: 200_000,
  max_output: 8_192,
});

describe("custom-models registry — routing", () => {
  beforeEach(() => {
    resetCustomModelsRegistry();
  });

  test("returns the assigned provider for a custom model id", () => {
    __setCustomModelsForTest({
      "my-custom-model": { provider: "qoder", displayName: "My Custom Model" },
    });
    expect(getCustomModelProvider("my-custom-model")).toBe("qoder");
  });

  test("returns null for a model id that is not custom-registered", () => {
    __setCustomModelsForTest({
      "my-custom-model": { provider: "qoder", displayName: "My Custom Model" },
    });
    expect(getCustomModelProvider("not-registered")).toBeNull();
  });

  test("returns null when the registry is empty", () => {
    expect(getCustomModelProvider("anything")).toBeNull();
  });

  test("honors a per-model spec override on the returned ModelInfo", () => {
    __setCustomModelsForTest({
      "glm-5.2-custom": {
        provider: "alibaba",
        displayName: "GLM 5.2 Custom",
        spec: { context_window: 1_000_000, max_output: 65_536, thinking: true, vision: true },
      },
    });
    const models = getCustomModels();
    const m = models.find((x) => x.id === "glm-5.2-custom");
    expect(m).toBeDefined();
    expect(m!.owned_by).toBe("alibaba");
    expect(m!.context_window).toBe(1_000_000);
    expect(m!.max_output).toBe(65_536);
    expect(m!.thinking).toBe(true);
    expect(m!.vision).toBe(true);
  });
});

describe("custom-models registry — listing", () => {
  beforeEach(() => {
    resetCustomModelsRegistry();
  });

  test("appends custom models to a provider model list", () => {
    __setCustomModelsForTest({
      "extra-qoder-model": { provider: "qoder", displayName: "Extra Qoder" },
    });
    const result = applyCustomModelsToList([baseModel("qd-existing", "qoder")]);
    const ids = result.map((m) => m.id);
    expect(ids).toContain("qd-existing");
    expect(ids).toContain("extra-qoder-model");
  });

  test("custom entry with same id replaces the base row (no duplicate)", () => {
    // Operator override is first-class catalog: one row, custom wins over hardcoded.
    __setCustomModelsForTest({
      "qd-existing": {
        provider: "qoder",
        displayName: "Overridden",
        spec: { context_window: 999_000 },
      },
    });
    const result = applyCustomModelsToList([baseModel("qd-existing", "qoder")]);
    const matches = result.filter((m) => m.id === "qd-existing");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.display_name).toBe("Overridden");
    expect(matches[0]!.context_window).toBe(999_000);
  });

  test("rename: a custom entry with renameFrom REPLACES the base model id", () => {
    // Operator renames cbc-hy3-preview → cbc-hy3 (upstream dropped "-preview").
    __setCustomModelsForTest({
      "cbc-hy3": {
        provider: "codebuddy-china",
        renameFrom: "cbc-hy3-preview",
        upstreamName: "hy3",
      },
    });
    const result = applyCustomModelsToList([baseModel("cbc-hy3-preview", "codebuddy-china")]);
    const ids = result.map((m) => m.id);
    // The old id is gone; the new id is present.
    expect(ids).not.toContain("cbc-hy3-preview");
    expect(ids).toContain("cbc-hy3");
  });
});

describe("custom-models registry — upstream-name override", () => {
  beforeEach(() => {
    resetCustomModelsRegistry();
  });

  test("returns the override when keyed directly by the new id", () => {
    __setCustomModelsForTest({
      "cbc-hy3": { provider: "codebuddy-china", renameFrom: "cbc-hy3-preview", upstreamName: "hy3" },
    });
    expect(getUpstreamNameOverride("cbc-hy3")).toBe("hy3");
  });

  test("returns the override when queried by the OLD id (renameFrom match)", () => {
    // A client still sending the old id cbc-hy3-preview must resolve to hy3.
    __setCustomModelsForTest({
      "cbc-hy3": { provider: "codebuddy-china", renameFrom: "cbc-hy3-preview", upstreamName: "hy3" },
    });
    expect(getUpstreamNameOverride("cbc-hy3-preview")).toBe("hy3");
  });

  test("returns null when no override is set", () => {
    __setCustomModelsForTest({
      "cbc-hy3": { provider: "codebuddy-china", renameFrom: "cbc-hy3-preview" },
    });
    expect(getUpstreamNameOverride("cbc-hy3")).toBeNull();
    expect(getUpstreamNameOverride("anything")).toBeNull();
  });
});

describe("custom-models registry — disabled filter", () => {
  beforeEach(() => {
    resetCustomModelsRegistry();
  });

  test("a disabled model is removed from the list", () => {
    __setDisabledModelsForTest({ "qoder:qd-existing": { provider: "qoder", model: "qd-existing" } });
    const result = applyCustomModelsToList([baseModel("qd-existing", "qoder")]);
    expect(result.find((m) => m.id === "qd-existing")).toBeUndefined();
  });

  test("a non-disabled model is kept", () => {
    __setDisabledModelsForTest({ "qoder:other": { provider: "qoder", model: "other" } });
    const result = applyCustomModelsToList([baseModel("qd-existing", "qoder")]);
    expect(result.find((m) => m.id === "qd-existing")).toBeDefined();
  });

  test("isModelDisabled reflects the disabled set", () => {
    __setDisabledModelsForTest({ "qoder:qd-existing": { provider: "qoder", model: "qd-existing" } });
    expect(isModelDisabled("qd-existing")).toBe(true);
    expect(isModelDisabled("qd-other")).toBe(false);
  });
});
