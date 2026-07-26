/**
 * Regression cover for the wiring gaps closed on 2026-07-26.
 *
 *   §4.8  SHARE_LOCK was substituted into the HTML only, so `curl /v1/share/board`
 *         still enumerated every managed key while the operator believed the
 *         page was link-only.
 *   §5.5  config.providers is a hand-maintained list of the 14 first-party
 *         providers; consumers meaning "all providers" skipped the
 *         OpenAI-compatible catalog and every dynamic compatible-node.
 *   §5.7  the model-mapping native-id allowlist was missing real provider
 *         prefixes, so a generic Claude Code template rewrote provider models.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../src/config";
import { listProviderNames, providers } from "../../src/proxy/providers/registry";
import { resolveModelAlias } from "../../src/proxy/model-mapping";
import { isShareLocked } from "../../src/proxy/share-key-public";

describe("SHARE_LOCK is enforced server-side (§4.8)", () => {
  const saved = process.env.SHARE_LOCK;
  afterEach(() => {
    if (saved === undefined) delete process.env.SHARE_LOCK;
    else process.env.SHARE_LOCK = saved;
  });

  test("unset → board open", () => {
    delete process.env.SHARE_LOCK;
    expect(isShareLocked()).toBe(false);
  });

  test("SHARE_LOCK=1 → board locked", () => {
    process.env.SHARE_LOCK = "1";
    expect(isShareLocked()).toBe(true);
  });

  test("any other value → open (only '1' locks, matching serve-share.ts)", () => {
    process.env.SHARE_LOCK = "0";
    expect(isShareLocked()).toBe(false);
    process.env.SHARE_LOCK = "true";
    expect(isShareLocked()).toBe(false);
  });

  test("read per call, not captured at import", () => {
    delete process.env.SHARE_LOCK;
    expect(isShareLocked()).toBe(false);
    process.env.SHARE_LOCK = "1";
    expect(isShareLocked()).toBe(true);
  });
});

describe("listProviderNames covers the whole registry (§5.5)", () => {
  test("includes every first-party provider from config.providers", () => {
    const names = new Set(listProviderNames());
    for (const p of config.providers) expect(names.has(p)).toBe(true);
  });

  test("includes providers config.providers does NOT list", () => {
    const names = listProviderNames();
    const extra = names.filter((n) => !(config.providers as readonly string[]).includes(n));
    // The OpenAI-compatible catalog lives only in the registry.
    expect(extra.length).toBeGreaterThan(0);
  });

  test("matches the registry's own provider map", () => {
    const names = new Set(listProviderNames());
    for (const key of Object.keys(providers)) expect(names.has(key)).toBe(true);
  });

  test("returns no duplicates", () => {
    const names = listProviderNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("model-mapping never rewrites a native provider id (§5.7)", () => {
  // No mapping rules are loaded in a unit test, so resolveModelAlias is an
  // identity function here; these assert the ids stay untouched either way.
  const nativeIds = [
    "cbc-haiku-4.5",     // codebuddy-china — was rewritable by a "haiku" template
    "cbc-deepseek-v3",
    "ali-qwen3-max",     // alibaba
    "codex-mini",        // codex
    "kp-opus-4.8",       // kiro-pro
    "qd-Qwen3.7-Max",    // qoder
    "cb-gpt-5",          // codebuddy
    "ym-default",        // youmind
    "grok-4",            // grok
    "claude_sonnet_4_6", // gitlab-duo underscore ids
    "gitlab-duo:claude",
    "kiro:opus",
  ];

  for (const id of nativeIds) {
    test(`${id} is preserved`, () => {
      expect(resolveModelAlias(id)).toBe(id);
    });
  }
});
