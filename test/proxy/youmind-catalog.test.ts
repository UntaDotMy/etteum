/**
 * YouMind provider — live model catalog tests.
 *
 * Covers the refreshModelsCache / getModels / ownsModel merge: curated-first
 * dedupe, live-only id ownership, curated ownership preserved, never-throw on
 * no-account / fetch failure, and fallback to the curated list when the live
 * catalog is empty.
 *
 * Network is fully mocked by stubbing global fetch. The DB is mocked via
 * mock.module on the db module (spread of the real module, per repo idiom).
 * Accounts are plain objects — no DB rows required.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// ── DB mock (must be registered before importing the provider) ─────────────
// The provider calls db.select().from(accounts).where(...).limit(1). We stub
// that chain; the account row it returns is controlled per-test via
// mockAccounts. We do NOT spread the real module — importing it would open the
// dev DB and start a setInterval that keeps the process alive (hangs bun test).
let mockAccounts: any[] = [];

mock.module("../../src/db/index", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(mockAccounts),
  };
  return {
    db: { select: () => chain },
    client: null,
  };
});

import { YouMindProvider } from "../../src/proxy/providers/youmind/provider";
import { YM_MODELS } from "../../src/proxy/providers/youmind/helpers";
import { encrypt } from "../../src/utils/crypto";
import type { Account } from "../../src/db/schema";

// ── Harness ────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

function makeAccount(): Account {
  return {
    id: 424242,
    provider: "youmind",
    email: "ym-test",
    password: encrypt("sk-ym-test-key"),
    tokens: null,
    enabled: true,
    status: "active",
  } as unknown as Account;
}

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: any, init?: any) => responder(String(url), init)) as typeof fetch;
}

beforeEach(() => {
  mockAccounts = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("youmind live catalog — getModels merge/dedupe", () => {
  test("falls back to curated supportedModels when live catalog is empty", () => {
    const provider = new YouMindProvider();
    const models = provider.getModels();
    expect(models.length).toBe(YM_MODELS.length);
    // Curated ids present
    expect(models.some((m) => m.id === "ym-claude-opus-4.6")).toBe(true);
  });

  test("merges live ids after curated, deduped by id (curated wins)", async () => {
    mockAccounts = [makeAccount()];
    // Upstream returns one id that matches a curated proxy id exactly
    // (ym-gpt-4o → upstream gpt-4o) plus two genuinely new models. The gpt-4o
    // collision must be deduped (curated wins); the two new ones are appended.
    stubFetch(() => modelsResponse(["gpt-4o", "claude-fable-9", "gpt-9.9-turbo"]));
    const provider = new YouMindProvider();
    await provider.refreshModelsCache(true);

    const models = provider.getModels();
    const ids = models.map((m) => m.id.toLowerCase());
    // Curated first
    expect(ids[0]).toBe("ym-claude-opus-4.6");
    // New live ids appended under ym- prefix
    expect(ids).toContain("ym-claude-fable-9");
    expect(ids).toContain("ym-gpt-9.9-turbo");
    // The colliding curated id appears exactly once (curated entry kept)
    expect(ids.filter((i) => i === "ym-gpt-4o").length).toBe(1);
    // Total = curated + 2 new (gpt-4o deduped away)
    expect(models.length).toBe(YM_MODELS.length + 2);
  });

  test("curated spec is preserved on conflict (curated entry wins over live)", async () => {
    mockAccounts = [makeAccount()];
    // gpt-4o collides with the curated ym-gpt-4o; the curated entry must win.
    stubFetch(() => modelsResponse(["gpt-4o"]));
    const provider = new YouMindProvider();
    await provider.refreshModelsCache(true);
    const info = provider.getModelInfo("ym-gpt-4o");
    // Curated def has thinking:false for gpt-4o; a spec-registry/live entry
    // would not downgrade it. Context window comes from the spec registry.
    expect(info?.thinking).toBe(false);
    expect(info?.owned_by).toBe("youmind");
  });
});

describe("youmind live catalog — ownsModel", () => {
  test("preserves curated ym- prefix ownership without any fetch", () => {
    const provider = new YouMindProvider();
    expect(provider.ownsModel("ym-claude-opus-4.6")).toBe(true);
    expect(provider.ownsModel("ym-gpt-5.5")).toBe(true);
    expect(provider.ownsModel("claude-opus-4-6")).toBe(false);
    expect(provider.ownsModel("grok-4")).toBe(false);
  });

  test("owns a live-only id after refresh", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => modelsResponse(["claude-fable-9"]));
    const provider = new YouMindProvider();
    expect(provider.ownsModel("ym-claude-fable-9")).toBe(true); // prefix match anyway
    await provider.refreshModelsCache(true);
    expect(provider.ownsModel("ym-claude-fable-9")).toBe(true);
  });
});

describe("youmind live catalog — refreshModelsCache resilience", () => {
  test("never throws with no youmind account", async () => {
    mockAccounts = [];
    stubFetch(() => {
      throw new Error("fetch should not be called");
    });
    const provider = new YouMindProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    // Still serving curated
    expect(provider.getModels().length).toBe(YM_MODELS.length);
  });

  test("never throws on fetch network failure, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => {
      throw new Error("network down");
    });
    const provider = new YouMindProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(YM_MODELS.length);
  });

  test("never throws on non-OK response, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => new Response("upstream boom", { status: 500 }));
    const provider = new YouMindProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(YM_MODELS.length);
  });

  test("never throws on malformed JSON, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => new Response("not json{{{", { status: 200 }));
    const provider = new YouMindProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(YM_MODELS.length);
  });

  test("sends the account bearer key to the models endpoint", async () => {
    mockAccounts = [makeAccount()];
    let seenAuth: string | undefined;
    stubFetch((url, init) => {
      expect(url).toContain("/openapi/v1/chat/anthropic/v1/models");
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return modelsResponse(["claude-fable-9"]);
    });
    const provider = new YouMindProvider();
    await provider.refreshModelsCache(true);
    expect(seenAuth).toBe("Bearer sk-ym-test-key");
  });
});
