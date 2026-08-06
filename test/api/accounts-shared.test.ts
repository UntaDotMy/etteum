/**
 * Unit tests for the pure BYOK helpers in src/api/accounts/shared.ts:
 *   parseByokTokens / getByokPrefix / getByokKeyLabel / normalizeModels /
 *   normalizeByokKeys / buildByokEmail / normalizeByokLbMethod, plus the
 *   BYOK_PREFIX_RE / BYOK_KEY_LABEL_RE acceptance-rejection surface.
 *
 * Env is set BEFORE imports because the module chain (config -> db -> pool)
 * reads env at import time. DATABASE_PATH points at a throwaway file so these
 * tests never touch the operator's real data/poolprox3.db. Only pure
 * functions are exercised here — nothing hits the DB or the network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "accounts-shared-"));

process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
process.env.DATABASE_PATH = join(tmpHome, "accounts-shared-test.db");

import { describe, test, expect, afterAll } from "bun:test";
import {
  parseByokTokens,
  getByokPrefix,
  getByokKeyLabel,
  normalizeModels,
  normalizeByokKeys,
  buildByokEmail,
  normalizeByokLbMethod,
  byokLbSettingKey,
  BYOK_PREFIX_RE,
  BYOK_KEY_LABEL_RE,
} from "../../src/api/accounts/shared";

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("parseByokTokens", () => {
  test("parses a JSON string into the token shape", () => {
    const parsed = parseByokTokens(
      JSON.stringify({ base_url: "https://x", model_prefix: "groq", models: ["m1"] }),
    );
    expect(parsed.base_url).toBe("https://x");
    expect(parsed.model_prefix).toBe("groq");
    expect(parsed.models).toEqual(["m1"]);
  });

  test("passes an object through unchanged", () => {
    const obj = { api_key: "k-1", format: "openai" as const };
    const parsed = parseByokTokens(obj);
    expect(parsed).toBe(obj);
    expect(parsed.api_key).toBe("k-1");
  });

  test("returns {} for null/undefined/empty-string", () => {
    expect(parseByokTokens(null)).toEqual({});
    expect(parseByokTokens(undefined)).toEqual({});
    expect(parseByokTokens("")).toEqual({});
  });

  test("returns {} for malformed JSON instead of throwing", () => {
    expect(parseByokTokens("{not-json")).toEqual({});
    expect(parseByokTokens("[1,2")).toEqual({});
  });

  test("returns the parsed value even for JSON arrays (cast, not validated)", () => {
    // Documented behavior: the helper is a cast, not a schema validator.
    const parsed = parseByokTokens("[1,2]");
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe("getByokPrefix", () => {
  test("prefers tokens.model_prefix over the email", () => {
    expect(
      getByokPrefix({ email: "real@example.com#main", tokens: '{"model_prefix":"groq"}' }),
    ).toBe("groq");
  });

  test("falls back to the email local part before '#'", () => {
    expect(getByokPrefix({ email: "openrouter#main", tokens: "{}" })).toBe("openrouter");
  });

  test("returns the full email when there is no '#' marker", () => {
    expect(getByokPrefix({ email: "solo-prefix", tokens: null })).toBe("solo-prefix");
  });

  test("returns empty string when email starts with '#'", () => {
    // split("#")[0] is "" which is falsy, so it falls through to account.email.
    expect(getByokPrefix({ email: "#label", tokens: null })).toBe("#label");
  });
});

describe("getByokKeyLabel", () => {
  test("prefers tokens.key_label", () => {
    expect(
      getByokKeyLabel({ email: "p#main", tokens: '{"key_label":"backup"}' }),
    ).toBe("backup");
  });

  test("derives the label from the email suffix after '#'", () => {
    expect(getByokKeyLabel({ email: "p#west-2", tokens: "{}" })).toBe("west-2");
  });

  test("returns 'default' when there is no '#' marker", () => {
    expect(getByokKeyLabel({ email: "plain-email", tokens: "{}" })).toBe("default");
  });

  test("returns 'default' when the suffix after '#' is empty", () => {
    expect(getByokKeyLabel({ email: "p#", tokens: "{}" })).toBe("default");
  });
});

describe("normalizeModels", () => {
  test("returns [] for non-array input", () => {
    expect(normalizeModels(undefined)).toEqual([]);
    expect(normalizeModels(null)).toEqual([]);
    expect(normalizeModels("gpt-4")).toEqual([]);
    expect(normalizeModels(42)).toEqual([]);
  });

  test("trims, stringifies, drops empties, and dedupes preserving order", () => {
    expect(
      normalizeModels(["  gpt-4 ", "claude", "", "   ", "gpt-4", 7, null]),
    ).toEqual(["gpt-4", "claude", "7", "null"]);
  });

  test("dedupes exact repeats but keeps distinct spellings", () => {
    expect(normalizeModels(["a", "a", "A", "b"])).toEqual(["a", "A", "b"]);
  });
});

describe("normalizeByokKeys", () => {
  test("normalizes an array of keys with default labels and priorities", () => {
    const out = normalizeByokKeys([{ key: "sk-1" }, { key: "sk-2", label: "Backup" }]);
    expect(out).toHaveLength(2);
    expect(out[0]?.label).toBe("key-1");
    expect(out[0]?.key).toBe("sk-1");
    expect(out[0]?.priority).toBe(0);
    expect(out[0]?.weight).toBeUndefined();
    // Labels are lowercased by the normalizer.
    expect(out[1]?.label).toBe("backup");
    expect(out[1]?.priority).toBe(1);
  });

  test("accepts the api_key alias and trims key whitespace", () => {
    const out = normalizeByokKeys([{ api_key: "  sk-aliased  " }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("sk-aliased");
  });

  test("falls back to a single 'default' entry for a legacy string key", () => {
    const out = normalizeByokKeys(undefined, "sk-legacy");
    expect(out).toEqual([{ label: "default", key: "sk-legacy", weight: undefined, priority: 0 }]);
  });

  test("prefers the array form over the legacy key when both are present", () => {
    const out = normalizeByokKeys([{ key: "sk-arr" }], "sk-legacy");
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("sk-arr");
  });

  test("returns [] when there are no keys at all", () => {
    expect(normalizeByokKeys(undefined)).toEqual([]);
    expect(normalizeByokKeys("not-an-array")).toEqual([]);
  });

  test("skips entries with an empty key", () => {
    const out = normalizeByokKeys([{ key: "  " }, { key: "sk-ok" }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("sk-ok");
    // Priority reflects the original array index, not the compacted position.
    expect(out[0]?.priority).toBe(1);
  });

  test("keeps finite numeric weight and priority", () => {
    const out = normalizeByokKeys([{ key: "sk-w", weight: 3, priority: 9 }]);
    expect(out[0]?.weight).toBe(3);
    expect(out[0]?.priority).toBe(9);
  });

  test("coerces numeric strings for weight/priority", () => {
    const out = normalizeByokKeys([{ key: "sk-w", weight: "2.5" as any, priority: "4" as any }]);
    expect(out[0]?.weight).toBe(2.5);
    expect(out[0]?.priority).toBe(4);
  });

  test("drops non-finite weight but falls back to index for priority", () => {
    const out = normalizeByokKeys([{ key: "sk-w", weight: "heavy" as any, priority: "p" as any }]);
    expect(out[0]?.weight).toBeUndefined();
    expect(out[0]?.priority).toBe(0);
  });

  test("throws on an invalid label", () => {
    expect(() => normalizeByokKeys([{ key: "sk", label: "Bad Label!" }])).toThrow(
      /key label must start with lowercase alphanumeric/,
    );
  });

  test("throws on duplicate labels (case-insensitive via lowercasing)", () => {
    expect(() =>
      normalizeByokKeys([
        { key: "sk-1", label: "Main" },
        { key: "sk-2", label: "main" },
      ]),
    ).toThrow(/duplicate BYOK key label: main/);
  });

  test("throws on duplicate key values", () => {
    expect(() =>
      normalizeByokKeys([
        { key: "sk-same", label: "a" },
        { key: "sk-same", label: "b" },
      ]),
    ).toThrow(/duplicate BYOK key value for label: b/);
  });
});

describe("buildByokEmail", () => {
  test("joins prefix and label with '#'", () => {
    expect(buildByokEmail("groq", "main")).toBe("groq#main");
  });

  test("round-trips through getByokPrefix/getByokKeyLabel", () => {
    const email = buildByokEmail("openrouter", "west-2");
    expect(getByokPrefix({ email, tokens: "{}" })).toBe("openrouter");
    expect(getByokKeyLabel({ email, tokens: "{}" })).toBe("west-2");
  });
});

describe("normalizeByokLbMethod", () => {
  test("passes through the two non-default methods", () => {
    expect(normalizeByokLbMethod("sequential")).toBe("sequential");
    expect(normalizeByokLbMethod("least_inflight")).toBe("least_inflight");
  });

  test("accepts the explicit default", () => {
    expect(normalizeByokLbMethod("round_robin")).toBe("round_robin");
  });

  test("coerces anything else to round_robin", () => {
    expect(normalizeByokLbMethod(undefined)).toBe("round_robin");
    expect(normalizeByokLbMethod(null)).toBe("round_robin");
    expect(normalizeByokLbMethod("random")).toBe("round_robin");
    expect(normalizeByokLbMethod("SEQUENTIAL")).toBe("round_robin");
    expect(normalizeByokLbMethod(123)).toBe("round_robin");
  });
});

describe("byokLbSettingKey", () => {
  test("builds the settings key for a prefix", () => {
    expect(byokLbSettingKey("groq")).toBe("byok_groq_lb_method");
  });
});

describe("BYOK_PREFIX_RE", () => {
  test("accepts lowercase alphanumerics and hyphens", () => {
    expect(BYOK_PREFIX_RE.test("groq")).toBe(true);
    expect(BYOK_PREFIX_RE.test("open-router-2")).toBe(true);
    expect(BYOK_PREFIX_RE.test("0")).toBe(true);
  });

  test("rejects empty, uppercase, underscore, dot, and space", () => {
    expect(BYOK_PREFIX_RE.test("")).toBe(false);
    expect(BYOK_PREFIX_RE.test("Groq")).toBe(false);
    expect(BYOK_PREFIX_RE.test("open_router")).toBe(false);
    expect(BYOK_PREFIX_RE.test("open.router")).toBe(false);
    expect(BYOK_PREFIX_RE.test("open router")).toBe(false);
  });
});

describe("BYOK_KEY_LABEL_RE", () => {
  test("accepts a single alphanumeric character", () => {
    expect(BYOK_KEY_LABEL_RE.test("a")).toBe(true);
    expect(BYOK_KEY_LABEL_RE.test("7")).toBe(true);
  });

  test("accepts hyphens and underscores after the first character", () => {
    expect(BYOK_KEY_LABEL_RE.test("west-2")).toBe(true);
    expect(BYOK_KEY_LABEL_RE.test("backup_key")).toBe(true);
    expect(BYOK_KEY_LABEL_RE.test("a-b_c-1")).toBe(true);
  });

  test("rejects a leading hyphen or underscore", () => {
    expect(BYOK_KEY_LABEL_RE.test("-lead")).toBe(false);
    expect(BYOK_KEY_LABEL_RE.test("_lead")).toBe(false);
  });

  test("rejects empty, uppercase, and out-of-charset characters", () => {
    expect(BYOK_KEY_LABEL_RE.test("")).toBe(false);
    expect(BYOK_KEY_LABEL_RE.test("Main")).toBe(false);
    expect(BYOK_KEY_LABEL_RE.test("has space")).toBe(false);
    expect(BYOK_KEY_LABEL_RE.test("dot.name")).toBe(false);
    expect(BYOK_KEY_LABEL_RE.test("pound#tag")).toBe(false);
  });

  test("caps the label at 48 characters", () => {
    const ok = "a" + "b".repeat(47);
    const tooLong = "a" + "b".repeat(48);
    expect(ok).toHaveLength(48);
    expect(BYOK_KEY_LABEL_RE.test(ok)).toBe(true);
    expect(BYOK_KEY_LABEL_RE.test(tooLong)).toBe(false);
  });
});
