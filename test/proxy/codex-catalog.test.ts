/**
 * Codex provider — live model catalog tests.
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
 * account an access_token so refreshModelsCache only hits GET /codex/models.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeEach, mock } from "bun:test";

// ── DB mock (must be registered before importing the provider) ─────────────
// The provider calls db.select().from(accounts).where(...) — no .limit(). We
// stub that chain; the rows it returns are controlled per-test via mockAccounts.
// The stub is self-contained: re-importing the real db/index inside its own
// mock factory deadlocks bun's module resolver (and the real module's
// setInterval WAL checkpoint would hold the test process open).
let mockAccounts: any[] = [];

mock.module("../../src/db/index", () => {
  const chain: any = {
    from: () => chain,
    where: () => Promise.resolve(mockAccounts),
  };
  return {
    db: { select: () => chain },
    client: undefined,
  };
});

import { CodexProvider } from "../../src/proxy/providers/codex/provider";
import { CODEX_MODELS_URL } from "../../src/proxy/providers/codex/helpers";
import type { Account } from "../../src/db/schema";

// ── Harness ────────────────────────────────────────────────────────────────

// codex-auto, 5.6-sol/terra/luna, 5.5, 5.4, 5.4-mini, auto-review, 5.5-xhigh
const CURATED_COUNT = 9;

function makeAccount(): Account {
  return {
    id: 424242,
    provider: "codex",
    email: "codex-test",
    password: null,
    tokens: JSON.stringify({
      access_token: "codex-test-access",
      refresh_token: "rt-test",
      account_id: "acct-test",
    }),
    enabled: true,
    status: "active",
  } as unknown as Account;
}

// OpenAI-style {data:[...]} shape.
function modelsDataResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: "model" })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// CLI-style {models:[...]} shape.
function modelsListResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ models: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

class TestCodexProvider extends CodexProvider {
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

describe("codex live catalog — getModels merge/dedupe", () => {
  test("falls back to curated supportedModels when live catalog is empty", () => {
    const provider = new CodexProvider();
    const models = provider.getModels();
    expect(models.length).toBe(CURATED_COUNT);
    expect(models.some((m) => m.id === "codex-gpt-5.6-sol")).toBe(true);
    expect(models.some((m) => m.id === "codex-gpt-5.5")).toBe(true);
    expect(models.some((m) => m.id === "codex-auto")).toBe(true);
  });

  test("merges live ids after curated as codex-* prefix (curated wins)", async () => {
    mockAccounts = [makeAccount()];
    // Upstream bare slug for a curated model + brand-new ones.
    const provider = new TestCodexProvider(() =>
      modelsDataResponse(["gpt-5.5", "gpt-5.7", "gpt-5.7-mini"]),
    );
    await provider.refreshModelsCache(true);

    const models = provider.getModels();
    const ids = models.map((m) => m.id);
    // Curated first
    expect(ids[0]).toBe("codex-auto");
    // Live-only models stored with codex- prefix (never bare upstream in catalog)
    expect(ids).toContain("codex-gpt-5.7");
    expect(ids).toContain("codex-gpt-5.7-mini");
    // gpt-5.5 is already covered by curated codex-gpt-5.5 — not duplicated
    expect(ids.filter((i) => i === "codex-gpt-5.5").length).toBe(1);
    expect(models.length).toBe(CURATED_COUNT + 2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("does not duplicate a live id that exactly matches a curated served id", async () => {
    mockAccounts = [makeAccount()];
    // codex-auto is a curated served id; upstream listing it must not duplicate.
    const provider = new TestCodexProvider(() => modelsDataResponse(["codex-auto", "gpt-5.7"]));
    await provider.refreshModelsCache(true);
    const ids = provider.getModels().map((m) => m.id);
    expect(ids.filter((i) => i === "codex-auto").length).toBe(1);
    expect(ids).toContain("codex-gpt-5.7");
    expect(provider.getModels().length).toBe(CURATED_COUNT + 1);
  });

  test("accepts the CLI {models:[...]} shape too", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestCodexProvider(() => modelsListResponse(["gpt-5.7"]));
    await provider.refreshModelsCache(true);
    expect(provider.getModels().some((m) => m.id === "codex-gpt-5.7")).toBe(true);
  });

  test("curated spec is preserved on conflict (verified 400k context kept)", async () => {
    mockAccounts = [makeAccount()];
    // Upstream listing codex-gpt-5.5 must not overwrite curated context_window.
    const provider = new TestCodexProvider(() => modelsDataResponse(["codex-gpt-5.5"]));
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "codex-gpt-5.5");
    expect(info?.context_window).toBe(400000);
    expect(info?.thinking).toBe(true);
  });

  test("live-only discovered model is catalogued as codex-* with safe defaults", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestCodexProvider(() => modelsDataResponse(["totally-unknown-model-xyz"]));
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "codex-totally-unknown-model-xyz");
    expect(info).toBeDefined();
    expect(info?.context_window).toBe(400000);
    expect(info?.thinking).toBe(true);
  });
});

describe("codex live catalog — ownsModel", () => {
  test("preserves curated prefix + special-name ownership without any fetch", () => {
    const provider = new CodexProvider();
    expect(provider.ownsModel("codex-gpt-5.6-sol")).toBe(true);
    expect(provider.ownsModel("codex-gpt-5.5")).toBe(true);
    expect(provider.ownsModel("codex-anything")).toBe(true); // codex- prefix
    expect(provider.ownsModel("gpt-5-codex")).toBe(true);
    expect(provider.ownsModel("gpt-5.5-xhigh")).toBe(true);
    expect(provider.ownsModel("gpt-5.6-sol")).toBe(true); // bare 5.6 family
    expect(provider.ownsModel("grok-4")).toBe(false);
  });

  test("owns a bare live-only id after refresh (no codex- prefix)", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestCodexProvider(() => modelsDataResponse(["gpt-5.7-experimental"]));
    // Before refresh, an unknown bare slug is not owned.
    expect(provider.ownsModel("gpt-5.7-experimental")).toBe(false);
    await provider.refreshModelsCache(true);
    expect(provider.ownsModel("gpt-5.7-experimental")).toBe(true);
    expect(provider.ownsModel("codex-gpt-5.7-experimental")).toBe(true);
    // Case-insensitive
    expect(provider.ownsModel("GPT-5.7-EXPERIMENTAL")).toBe(true);
  });
});

describe("codex live catalog — refreshModelsCache resilience", () => {
  test("never throws with no codex account", async () => {
    mockAccounts = [];
    const provider = new TestCodexProvider(() => {
      throw new Error("fetch should not be called");
    });
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws when account has no access_token", async () => {
    mockAccounts = [{ ...makeAccount(), tokens: JSON.stringify({ refresh_token: "rt-only" }) }];
    const provider = new TestCodexProvider(() => {
      throw new Error("fetch should not be called");
    });
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on fetch network failure, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestCodexProvider(() => {
      throw new Error("network down");
    });
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on non-OK response, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestCodexProvider(() => new Response("upstream boom", { status: 500 }));
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on malformed JSON, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    const provider = new TestCodexProvider(() => new Response("not json{{{", { status: 200 }));
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("GETs the codex models endpoint with bearer + account-id headers", async () => {
    mockAccounts = [makeAccount()];
    let seenUrl = "";
    let seenAuth: string | undefined;
    let seenAcct: string | undefined;
    let seenMethod: string | undefined;
    const provider = new TestCodexProvider((url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      const headers = init?.headers as Record<string, string>;
      seenAuth = headers?.Authorization;
      seenAcct = headers?.["chatgpt-account-id"];
      return modelsDataResponse(["gpt-5.6"]);
    });
    await provider.refreshModelsCache(true);
    expect(seenUrl).toBe(CODEX_MODELS_URL);
    expect(seenUrl).toContain("/backend-api/codex/models");
    expect(seenMethod).toBe("GET");
    expect(seenAuth).toBe("Bearer codex-test-access");
    expect(seenAcct).toBe("acct-test");
  });
});
