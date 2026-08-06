/**
 * Unit tests for the extracted BYOK panel logic (dashboard/src/lib/byok-logic.ts).
 *
 * Regression focus: the bulk-add label collision that caused a whole paste to be
 * rejected with a 409 when a bare key auto-labeled to an already-used `key-1`.
 */
import { describe, test, expect } from "bun:test";
import {
  parseBulkLines,
  freshUpstreamModels,
  mergeModels,
  paginateKeys,
  DEFAULT_KEY_LABEL,
} from "../../dashboard/src/lib/byok-logic";

describe("parseBulkLines", () => {
  test("bare key auto-labels to key-1 when nothing exists", () => {
    expect(parseBulkLines("sk-aaa")).toEqual([{ label: "key-1", key: "sk-aaa" }]);
  });

  test("bare keys label sequentially within one paste", () => {
    expect(parseBulkLines("sk-a\nsk-b\nsk-c")).toEqual([
      { label: "key-1", key: "sk-a" },
      { label: "key-2", key: "sk-b" },
      { label: "key-3", key: "sk-c" },
    ]);
  });

  test("regression: bare key skips labels already on the provider (no 409)", () => {
    // Provider already has key-1 and key-2; a fresh bare paste must start at key-3.
    const out = parseBulkLines("sk-new", ["key-1", "key-2"]);
    expect(out).toEqual([{ label: "key-3", key: "sk-new" }]);
  });

  test("regression: repeat paste keeps incrementing across batches", () => {
    const first = parseBulkLines("sk-a\nsk-b", ["key-1"]); // key-2, key-3
    const used = ["key-1", ...first.map((k) => k.label)];
    const second = parseBulkLines("sk-c", used);
    expect(first.map((k) => k.label)).toEqual(["key-2", "key-3"]);
    expect(second).toEqual([{ label: "key-4", key: "sk-c" }]);
  });

  test("default label is treated as taken", () => {
    const out = parseBulkLines("sk-x", []);
    expect(out[0].label).not.toBe(DEFAULT_KEY_LABEL);
  });

  test("label:key format is honored and lowercased", () => {
    expect(parseBulkLines("Prod:sk-secret")).toEqual([{ label: "prod", key: "sk-secret" }]);
  });

  test("label key (space) format is honored", () => {
    expect(parseBulkLines("backup sk-secret")).toEqual([{ label: "backup", key: "sk-secret" }]);
  });

  test("explicit label colliding with existing falls back to a free auto label", () => {
    const out = parseBulkLines("key-1:sk-other", ["key-1"]);
    expect(out[0].label).toBe("key-2");
    expect(out[0].key).toBe("sk-other");
  });

  test("two identical explicit labels in one paste get distinct labels", () => {
    const out = parseBulkLines("dup:sk-a\ndup:sk-b");
    expect(out[0].label).toBe("dup");
    expect(out[1].label).not.toBe("dup"); // remapped to key-N
    expect(out[1].key).toBe("sk-b");
  });

  test("skips blank lines and lines with no key", () => {
    expect(parseBulkLines("\n   \nlabel:\nsk-real\n")).toEqual([{ label: "key-1", key: "sk-real" }]);
  });

  test("key containing a colon splits on the first colon only", () => {
    expect(parseBulkLines("lab:sk:with:colons")).toEqual([{ label: "lab", key: "sk:with:colons" }]);
  });

  test("empty input yields empty array", () => {
    expect(parseBulkLines("")).toEqual([]);
    expect(parseBulkLines("   \n \n")).toEqual([]);
  });
});

describe("freshUpstreamModels", () => {
  test("returns only models not already listed", () => {
    expect(freshUpstreamModels(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });

  test("case-insensitive dedupe against existing", () => {
    expect(freshUpstreamModels(["GPT-4o"], ["gpt-4o"])).toEqual([]);
  });

  test("empty when everything already present", () => {
    expect(freshUpstreamModels(["a"], ["a"])).toEqual([]);
  });

  test("all when nothing present", () => {
    expect(freshUpstreamModels(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("mergeModels", () => {
  test("appends new models preserving order", () => {
    expect(mergeModels(["a"], ["b", "c"])).toBe("a, b, c");
  });

  test("never removes existing entries", () => {
    expect(mergeModels(["a", "b"], [])).toBe("a, b");
  });

  test("skips case-insensitive duplicates within picked set", () => {
    expect(mergeModels(["a"], ["A", "b"])).toBe("a, b");
  });

  test("does not duplicate an already-listed model", () => {
    expect(mergeModels(["a", "b"], ["b", "c"])).toBe("a, b, c");
  });

  test("empty picked returns existing joined", () => {
    expect(mergeModels(["a", "b"], [])).toBe("a, b");
  });
});

describe("paginateKeys", () => {
  const keys = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));

  test("caps to pageSize when not showing all", () => {
    expect(paginateKeys(keys, false, 10)).toHaveLength(10);
  });

  test("returns full list when showAll is true", () => {
    expect(paginateKeys(keys, true, 10)).toHaveLength(25);
  });

  test("returns full list when it already fits", () => {
    expect(paginateKeys(keys.slice(0, 5), false, 10)).toHaveLength(5);
  });

  test("boundary: exactly pageSize returns all", () => {
    expect(paginateKeys(keys.slice(0, 10), false, 10)).toHaveLength(10);
  });

  test("preserves entry identity/order (indices stay aligned)", () => {
    const page = paginateKeys(keys, false, 10);
    expect(page[0]).toEqual({ id: 1 });
    expect(page[9]).toEqual({ id: 10 });
  });
});
