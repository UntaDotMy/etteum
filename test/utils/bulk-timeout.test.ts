import { describe, expect, test } from "bun:test";
import { bulkTimeoutMs, BULK_API_TIMEOUT_MS } from "../../dashboard/src/lib/bulkTimeout";

describe("bulkTimeoutMs", () => {
  test("floors at 2 minutes for small batches", () => {
    expect(bulkTimeoutMs(1)).toBe(120_000);
    expect(bulkTimeoutMs(5, 1000)).toBe(120_000);
  });

  test("scales with item count", () => {
    expect(bulkTimeoutMs(100, 3_000)).toBe(300_000);
  });

  test("caps at BULK_API_TIMEOUT_MS", () => {
    expect(bulkTimeoutMs(10_000, 3_000)).toBe(BULK_API_TIMEOUT_MS);
  });
});
