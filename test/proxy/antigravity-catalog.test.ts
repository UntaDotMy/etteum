/**
 * Antigravity provider — live model catalog tests.
 *
 * Covers the refreshModelsCache / getModels / ownsModel merge: curated-first
 * dedupe, live-only id ownership, curated ownership preserved, never-throw on
 * no-account / fetch failure, and fallback to the curated list when the live
 * catalog is empty.
 *
 * Network is fully mocked by overriding fetchWithTimeout (codex-provider
 * idiom). The DB account query is mocked via mock.module on the db module
 * (spread of the real module, per repo idiom). Accounts are plain objects —
 * no DB rows required. The OAuth dance is short-circuited by giving the
 * account a far-future access_token + bound project_id so ensureAuth performs
 * no network I/O and refreshModelsCache only hits fetchAvailableModels.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeEach, mock } from "bun:test";

// ── DB mock (must be registered before importing the provider) ─────────────
// The provider calls db.select().from(accounts).where(...) — no .limit(). We
// stub that chain; the rows it returns are controlled per-test via mockAccounts.
let mockAccounts: any[] = [];

// Self-contained db stub — does NOT re-import the real db/index. Re-importing
// the real module from inside the factory deadlocks for this provider (its
// config→…→db import graph cycles with the pending mock), so we stub only what
// refreshModelsCache touches: db.select().from(accounts).where(...) → rows.
mock.module("../../src/db/index", () => {
  const terminal = () => ({
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(mockAccounts).then(onFulfilled, onRejected),
    catch: (onRejected: any) => Promise.resolve(mockAccounts).catch(onRejected),
  });
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => terminal(),
    // Awaiting the chain itself (no .limit()) also resolves the rows.
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(mockAccounts).then(onFulfilled, onRejected),
    catch: (onRejected: any) => Promise.resolve(mockAccounts).catch(onRejected),
  };
  return {
    db: { select: () => chain },
    client: null,
  };
});

import { AntigravityProvider } from "../../src/proxy/providers/antigravity";
import type { Account } from "../../src/db/schema";

// ── Harness ────────────────────────────────────────────────────────────────

const CURATED_COUNT = 3; // ag-gemini-3-pro, ag-gemini-3-pro-high, ag-gemini-3-flash

function makeAccount(): Account {
  return {
    id: 424242,
    provider: "antigravity",
    email: "ag-test",
    password: null,
    // Far-future access_token + bound project_id → ensureAuth does no I/O.
    tokens: JSON.stringify({
      refresh_token: "rt-test",
      access_token: "ya29.test-access",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      project_id: "proj-test",
    }),
    enabled: true,
    status: "active",
  } as unknown as Account;
}

function modelsResponse(names: string[]): Response {
  return new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

class TestAntigravityProvider extends AntigravityProvider {
  constructor(
    private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    super();
  }
  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return this.responder(url, init);
  }
}

beforeEach(() => {
  mockAccounts = [];
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("antigravity live catalog — getModels merge/dedupe", () => {
  test("falls back to curated supportedModels when live catalog is empty", () => {
    const provider = new AntigravityProvider();
    const models = provider.getModels();
    expect(models.length).toBe(CURATED_COUNT);
    expect(models.some((m) => m.id === "ag-gemini-3-pro")).toBe(true);
  });

  test("merges live ids after curated, deduped by id (curated wins)", async () => {
    mockAccounts = [makeAccount()];
    // Upstream returns a curated model (gemini-3-pro) plus new ones.
    const provider = new TestAntigravityProvider(() =>
      modelsResponse(["gemini-3-pro", "gemini-3-ultra", "gemini-4-pro"]),
    );
    await provider.refreshModelsCache(true);

    const models = provider.getModels();
    const ids = models.map((m) => m.id.toLowerCase());
    // Curated first
    expect(ids[0]).toBe("ag-gemini-3-pro");
    // New live ids appended under ag- prefix
    expect(ids).toContain("ag-gemini-3-ultra");
    expect(ids).toContain("ag-gemini-4-pro");
    // No duplicate of the curated model that upstream also listed
    expect(ids.filter((i) => i === "ag-gemini-3-pro").length).toBe(1);
    // Total = curated + 2 new
    expect(models.length).toBe(CURATED_COUNT + 2);
  });

  test("curated spec is preserved on conflict (verified specs kept)", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestAntigravityProvider(() => modelsResponse(["gemini-3-pro"]));
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "ag-gemini-3-pro");
    // applyModelSpecs resolves gemini-3-pro's verified spec from the central
    // registry (1Mi context), overriding the hardcoded fallback — the point is
    // the curated entry (not the discovered one) is served on id collision.
    expect(info?.context_window).toBe(1048576);
    expect(info?.thinking).toBe(true);
    expect(info?.owned_by).toBe("antigravity");
  });
});

describe("antigravity live catalog — ownsModel", () => {
  test("preserves curated ag- prefix ownership without any fetch", () => {
    const provider = new AntigravityProvider();
    expect(provider.ownsModel("ag-gemini-3-pro")).toBe(true);
    expect(provider.ownsModel("ag-gemini-3-flash")).toBe(true);
    expect(provider.ownsModel("gemini-3-pro")).toBe(false);
    expect(provider.ownsModel("grok-4")).toBe(false);
  });

  test("owns a live-only id after refresh (ag- prefix matches anyway)", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestAntigravityProvider(() => modelsResponse(["gemini-3-ultra"]));
    expect(provider.ownsModel("ag-gemini-3-ultra")).toBe(true); // prefix match anyway
    await provider.refreshModelsCache(true);
    expect(provider.ownsModel("ag-gemini-3-ultra")).toBe(true);
  });
});

describe("antigravity live catalog — refreshModelsCache resilience", () => {
  test("never throws with no antigravity account", async () => {
    mockAccounts = [];
    const provider = new TestAntigravityProvider(() => {
      throw new Error("fetch should not be called");
    });
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on fetch network failure, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestAntigravityProvider(() => {
      throw new Error("network down");
    });
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on non-OK response, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestAntigravityProvider(
      () => new Response("upstream boom", { status: 500 }),
    );
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on malformed JSON, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestAntigravityProvider(
      () => new Response("not json{{{", { status: 200 }),
    );
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("posts to fetchAvailableModels with bearer + User-Agent", async () => {
    mockAccounts = [makeAccount()];
    let seenUrl = "";
    let seenAuth: string | undefined;
    let seenUa: string | undefined;
    const provider = new TestAntigravityProvider((url, init) => {
      seenUrl = url;
      const headers = init?.headers as Record<string, string>;
      seenAuth = headers?.Authorization;
      seenUa = headers?.["User-Agent"];
      return modelsResponse(["gemini-3-ultra"]);
    });
    await provider.refreshModelsCache(true);
    expect(seenUrl).toContain("fetchAvailableModels");
    expect(seenAuth).toBe("Bearer ya29.test-access");
    expect(seenUa).toBe("antigravity");
  });
});
