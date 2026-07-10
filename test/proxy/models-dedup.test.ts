/**
 * F15: getAllModels must not emit duplicate model ids across providers.
 *
 * Root cause: the openai F13 catalog and cursor both declare bare generic ids
 * (gpt-4, gpt-4o, gpt-4-turbo, gpt-3.5-turbo, claude-3.5-sonnet). Since
 * getAllModels does PROVIDER_ORDER.flatMap(p => p.getModels()), the same id
 * appears multiple times with different owned_by values — leaking into
 * /v1/models and the dashboard Models page as duplicate rows ("gpt-4 leaking
 * to all providers").
 *
 * Contract: getAllModels dedups by model id, keeping the FIRST occurrence
 * (which is the routing winner per PROVIDER_ORDER priority). The list shown to
 * clients must match the routing decision.
 */
import { describe, test, expect } from "bun:test";
import { getAllModels, getProviderForModel } from "../../src/proxy/providers/registry";

describe("getAllModels — dedup across providers", () => {
  test("does not emit duplicate model ids", () => {
    const models = getAllModels();
    const ids = models.map((m) => m.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `duplicate ids: ${dupes.join(", ")}`).toEqual([]);
  });

  test("for a model owned by two providers, the listed owner matches the routing winner", () => {
    // gpt-4 is declared by both cursor and the openai catalog. cursor comes
    // first in PROVIDER_ORDER, so it wins routing — and must be the owner
    // shown in the list.
    const models = getAllModels();
    const gpt4 = models.filter((m) => m.id === "gpt-4");
    expect(gpt4).toHaveLength(1);
    expect(gpt4[0].owned_by).toBe(getProviderForModel("gpt-4"));
  });

  test("gpt-4o appears exactly once", () => {
    const models = getAllModels();
    expect(models.filter((m) => m.id === "gpt-4o")).toHaveLength(1);
  });
});
