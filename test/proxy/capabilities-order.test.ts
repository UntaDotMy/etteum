/**
 * capabilities-order.test.ts — unit tests for the provider capability database.
 *
 * Locks current behavior of:
 *   - isProviderCapabilityKnown: "declared in DB" vs UNKNOWN (≠ unsupported).
 *   - getCapabilities: glob-pattern matching, first-match-wins, case folding,
 *     and the cache-returns-same-reference detail.
 *   - reorderByCapabilities: hard-vs-soft tiering, stable sort inside a tier,
 *     and the early-outs (empty required set / single candidate).
 *
 * Pure module (no env, no I/O), so no setup needed before import.
 */
import { describe, expect, test } from "bun:test";
import {
  getCapabilities,
  isProviderCapabilityKnown,
  reorderByCapabilities,
  type Capability,
} from "../../src/proxy/capabilities";

describe("isProviderCapabilityKnown", () => {
  test("known providers return true", () => {
    for (const p of [
      "gitlab-duo",
      "kiro",
      "kiro-pro",
      "codebuddy",
      "codebuddy-china",
      "canva",
      "codex",
      "qoder",
      "alibaba",
      "antigravity",
      "grok",
    ]) {
      expect(isProviderCapabilityKnown(p)).toBe(true);
    }
  });

  test("unlisted providers are UNKNOWN (false), not unsupported", () => {
    // byok / youmind are deliberately absent per source comment.
    for (const p of ["byok", "youmind", "cursor", "openai", "groq", "deepseek", "nonsense-provider"]) {
      expect(isProviderCapabilityKnown(p)).toBe(false);
    }
  });

  test("empty string is not a known provider", () => {
    expect(isProviderCapabilityKnown("")).toBe(false);
  });
});

describe("getCapabilities — pattern matching", () => {
  test("unknown provider yields empty caps (reads as unknown, not unsupported)", () => {
    expect(getCapabilities("byok", "anything")).toEqual({});
    expect(getCapabilities("not-a-provider", "gpt-9")).toEqual({});
  });

  test("wildcard '*' entry matches any model", () => {
    expect(getCapabilities("kiro", "claude-sonnet-4.5")).toEqual({ thinking: true });
    expect(getCapabilities("codex", "gpt-5-codex")).toEqual({ thinking: true });
    expect(getCapabilities("canva", "canva-image")).toEqual({ vision: true });
    expect(getCapabilities("grok", "grok-4.5")).toEqual({ thinking: true });
    expect(getCapabilities("alibaba", "qwen-max")).toEqual({ vision: true, thinking: true });
    expect(getCapabilities("gitlab-duo", "duo-chat")).toEqual({ thinking: true });
  });

  test("prefix glob 'gemini-2.0*' matches prefix only (antigravity first entry wins)", () => {
    expect(getCapabilities("antigravity", "gemini-2.0-flash")).toEqual({
      vision: true,
      thinking: true,
      search: true,
      computerUse: true,
    });
  });

  test("'gemini*' fallback matches other gemini models with computerUse false", () => {
    expect(getCapabilities("antigravity", "gemini-2.5-pro")).toEqual({
      vision: true,
      thinking: true,
      search: true,
      computerUse: false,
    });
  });

  test("antigravity '*' fallback covers non-gemini models without search/computerUse", () => {
    expect(getCapabilities("antigravity", "claude-sonnet-4.5")).toEqual({
      vision: true,
      thinking: true,
    });
  });

  test("matching is case-insensitive on both pattern and model", () => {
    expect(getCapabilities("antigravity", "GEMINI-2.0-FLASH")).toEqual({
      vision: true,
      thinking: true,
      search: true,
      computerUse: true,
    });
    expect(getCapabilities("codebuddy-china", "CBC-HAIKU-4.5")).toEqual({ thinking: false });
  });

  test("codebuddy-china exact-match exceptions beat the '*' fallback (first match wins)", () => {
    expect(getCapabilities("codebuddy-china", "cbc-haiku-4.5")).toEqual({ thinking: false });
    expect(getCapabilities("codebuddy-china", "cbc-deepseek-r1")).toEqual({ thinking: true });
    expect(getCapabilities("codebuddy-china", "cbc-deepseek-v3")).toEqual({ thinking: false });
    expect(getCapabilities("codebuddy-china", "cbc-hy3-preview")).toEqual({ thinking: false });
    // Any other cbc- model falls through to vision+thinking.
    expect(getCapabilities("codebuddy-china", "cbc-kimi-k3")).toEqual({ vision: true, thinking: true });
  });

  test("exact pattern does not substring-match a longer model name", () => {
    // "cbc-haiku-4.5" is exact — a suffixed variant must NOT match it and
    // instead falls to the '*' entry (vision+thinking).
    expect(getCapabilities("codebuddy-china", "cbc-haiku-4.5-extended")).toEqual({
      vision: true,
      thinking: true,
    });
  });

  test("returns the same cached object reference on repeat calls", () => {
    const a = getCapabilities("kiro", "cache-check-model");
    const b = getCapabilities("kiro", "cache-check-model");
    expect(b).toBe(a);
  });
});

describe("reorderByCapabilities", () => {
  type Cand = { provider: string; model: string; tag?: string };
  const key = (c: Cand) => ({ provider: c.provider, model: c.model });

  test("empty required set returns the same array unchanged", () => {
    const cands: Cand[] = [
      { provider: "kiro", model: "x" },
      { provider: "canva", model: "y" },
    ];
    const out = reorderByCapabilities(cands, new Set<Capability>(), key);
    expect(out).toBe(cands);
  });

  test("single candidate returns unchanged regardless of requirements", () => {
    const cands: Cand[] = [{ provider: "kiro", model: "x" }];
    const out = reorderByCapabilities(cands, new Set<Capability>(["vision"]), key);
    expect(out).toBe(cands);
  });

  test("hard capability: vision-capable candidates sort before vision-less ones", () => {
    const cands: Cand[] = [
      { provider: "kiro", model: "k", tag: "text-only" }, // thinking only → tier 2
      { provider: "canva", model: "c", tag: "vision" }, // vision → tier 0
    ];
    const out = reorderByCapabilities(cands, new Set<Capability>(["vision"]), key);
    expect(out.map((c) => c.tag)).toEqual(["vision", "text-only"]);
  });

  test("hard capability: unknown provider ({} caps) fails the hard check and sinks", () => {
    const cands: Cand[] = [
      { provider: "byok", model: "b", tag: "unknown" }, // {} caps → tier 2 for hard req
      { provider: "alibaba", model: "a", tag: "vision" }, // vision → tier 0
    ];
    const out = reorderByCapabilities(cands, new Set<Capability>(["vision"]), key);
    expect(out[0]?.tag).toBe("vision");
    expect(out[1]?.tag).toBe("unknown");
  });

  test("soft capability alone demotes but does not sink to hard-fail tier", () => {
    // antigravity gemini-2.0* has search:true; kiro has no search.
    const cands: Cand[] = [
      { provider: "kiro", model: "k", tag: "no-search" }, // soft miss → tier 1
      { provider: "antigravity", model: "gemini-2.0-x", tag: "search" }, // tier 0
    ];
    const out = reorderByCapabilities(cands, new Set<Capability>(["search"]), key);
    expect(out[0]?.tag).toBe("search");
    expect(out[1]?.tag).toBe("no-search");
  });

  test("mixed hard+soft: hard-pass/soft-miss (tier 1) beats hard-fail (tier 2)", () => {
    const cands: Cand[] = [
      { provider: "kiro", model: "k", tag: "hard-fail" }, // no vision → tier 2
      { provider: "alibaba", model: "a", tag: "hard-pass-soft-miss" }, // vision, no search → tier 1
      { provider: "antigravity", model: "gemini-2.0-x", tag: "full" }, // vision+search → tier 0
    ];
    const out = reorderByCapabilities(
      cands,
      new Set<Capability>(["vision", "search"]),
      key,
    );
    expect(out.map((c) => c.tag)).toEqual(["full", "hard-pass-soft-miss", "hard-fail"]);
  });

  test("stable within a tier: original relative order preserved", () => {
    const cands: Cand[] = [
      { provider: "kiro", model: "k1", tag: "a" },
      { provider: "codex", model: "c1", tag: "b" },
      { provider: "kiro-pro", model: "k2", tag: "c" },
    ];
    // None have vision → all tier 2 → original order must be preserved.
    const out = reorderByCapabilities(cands, new Set<Capability>(["vision"]), key);
    expect(out.map((c) => c.tag)).toEqual(["a", "b", "c"]);
  });

  test("explicit thinking:false counts as missing for a soft thinking requirement", () => {
    // cbc-deepseek-v3 declares thinking:false (falsy) → soft miss → tier 1.
    // cbc-deepseek-r1 declares thinking:true → tier 0.
    const cands: Cand[] = [
      { provider: "codebuddy-china", model: "cbc-deepseek-v3", tag: "think-false" },
      { provider: "codebuddy-china", model: "cbc-deepseek-r1", tag: "think-true" },
    ];
    const out = reorderByCapabilities(cands, new Set<Capability>(["thinking"]), key);
    expect(out.map((c) => c.tag)).toEqual(["think-true", "think-false"]);
  });

  test("does not mutate the input array", () => {
    const cands: Cand[] = [
      { provider: "kiro", model: "k", tag: "text" },
      { provider: "canva", model: "c", tag: "vision" },
    ];
    const snapshot = cands.map((c) => c.tag);
    reorderByCapabilities(cands, new Set<Capability>(["vision"]), key);
    expect(cands.map((c) => c.tag)).toEqual(snapshot);
  });
});
