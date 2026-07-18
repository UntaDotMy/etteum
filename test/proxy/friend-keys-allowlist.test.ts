import { describe, expect, test } from "bun:test";
import { modelAllowed, parseAllowedModels } from "../../src/proxy/friend-keys";

describe("managed key model allowlist", () => {
  test("null/empty allowlist permits every model", () => {
    expect(modelAllowed(null, "grok-4.5")).toBe(true);
    expect(modelAllowed(parseAllowedModels(null), "any")).toBe(true);
    expect(modelAllowed(parseAllowedModels("[]"), "any")).toBe(true);
  });

  test("non-empty allowlist only permits listed model ids", () => {
    const allowlist = parseAllowedModels(JSON.stringify(["grok-4.5"]));
    expect(allowlist).toEqual(["grok-4.5"]);
    expect(modelAllowed(allowlist, "grok-4.5")).toBe(true);
    expect(modelAllowed(allowlist, "composer-2.5")).toBe(false);
    expect(modelAllowed(allowlist, "gpt-4")).toBe(false);
  });

  test("catalog filter matches GET /v1/models behavior for a restricted key", () => {
    const allowlist = parseAllowedModels(JSON.stringify(["grok-4.5"]));
    const catalog = [
      { id: "grok-4.5" },
      { id: "composer-2.5" },
      { id: "cbc-haiku-4.5" },
    ];
    const visible = catalog.filter((m) => modelAllowed(allowlist, m.id));
    expect(visible.map((m) => m.id)).toEqual(["grok-4.5"]);
  });
});
