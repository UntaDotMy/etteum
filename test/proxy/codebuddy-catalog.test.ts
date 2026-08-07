/**
 * CodeBuddy + CodeBuddy China providers — live model catalog tests.
 *
 * Covers refreshModelsCache / getModels / ownsModel for BOTH relays:
 * curated-first dedupe, live-only id ownership, curated ownership preserved,
 * never-throw on no-account / fetch failure, and fallback to the curated list
 * when the live catalog is empty.
 *
 * Network is fully mocked by stubbing global fetch. The DB is mocked via
 * mock.module on the db module (NON-spread, per youmind-catalog idiom — the
 * real module opens the dev DB and starts a setInterval that hangs bun test).
 * Accounts are plain objects — no DB rows required. Auth is short-circuited by
 * giving the account an api_key so refreshModelsCache only hits GET {base}/v2/models.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// ── DB mock (must be registered before importing the providers) ────────────
// The providers call db.select().from(accounts).where(...).limit(1). We stub
// that chain; the account rows it returns are controlled per-test via
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

import { CodeBuddyProvider } from "../../src/proxy/providers/codebuddy/provider";
import { CodeBuddyChinaProvider } from "../../src/proxy/providers/codebuddy-china/provider";
import type { Account } from "../../src/db/schema";

// ── Harness ────────────────────────────────────────────────────────────────

const CB_CURATED_COUNT = 27; // cb-* curated models
const CBC_CURATED_COUNT = 15; // cbc-* curated models

const realFetch = globalThis.fetch;

function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: any, init?: any) => responder(String(url), init)) as typeof fetch;
}

function makeCbAccount(): Account {
  return {
    id: 424242,
    provider: "codebuddy",
    email: "cb-test",
    password: null,
    tokens: JSON.stringify({ api_key: "cb-test-key" }),
    enabled: true,
    status: "active",
  } as unknown as Account;
}

function makeCbcAccount(): Account {
  return {
    id: 434343,
    provider: "codebuddy-china",
    email: "cbc-test",
    password: null,
    tokens: JSON.stringify({ api_key: "ck_test-key" }),
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

beforeEach(() => {
  mockAccounts = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── CodeBuddy (codebuddy.ai) ───────────────────────────────────────────────

describe("codebuddy live catalog — getModels merge/dedupe", () => {
  test("falls back to curated supportedModels when live catalog is empty", () => {
    const provider = new CodeBuddyProvider();
    const models = provider.getModels();
    expect(models.length).toBe(CB_CURATED_COUNT);
    expect(models.some((m) => m.id === "cb-opus-4.8")).toBe(true);
    expect(models.some((m) => m.id === "cb-kimi-k3")).toBe(true);
  });

  test("merges live ids after curated, deduped by id (curated wins)", async () => {
    mockAccounts = [makeCbAccount()];
    // Upstream returns a curated collision plus brand-new ids.
    stubFetch(() => modelsDataResponse(["cb-opus-4.8", "new-model-a", "new-model-b"]));
    const provider = new CodeBuddyProvider();
    await provider.refreshModelsCache(true);

    const models = provider.getModels();
    const ids = models.map((m) => m.id);
    // Curated first
    expect(ids[0]).toBe("cb-opus-4.8");
    // New live ids appended with the cb- prefix
    expect(ids).toContain("cb-new-model-a");
    expect(ids).toContain("cb-new-model-b");
    // Total = curated + 2 new (cb-opus-4.8 collides, not duplicated)
    expect(models.length).toBe(CB_CURATED_COUNT + 2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("curated spec is preserved on collision (1M context kept)", async () => {
    mockAccounts = [makeCbAccount()];
    stubFetch(() => modelsDataResponse(["cb-opus-4.8"]));
    const provider = new CodeBuddyProvider();
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "cb-opus-4.8");
    expect(info?.context_window).toBe(1000000);
    expect(info?.thinking).toBe(true);
    // No duplicate
    expect(provider.getModels().filter((m) => m.id === "cb-opus-4.8").length).toBe(1);
  });

  test("live-only discovered model uses resolveModelSpec defaults (0/false when unknown)", async () => {
    mockAccounts = [makeCbAccount()];
    stubFetch(() => modelsDataResponse(["totally-unknown-xyz"]));
    const provider = new CodeBuddyProvider();
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "cb-totally-unknown-xyz");
    expect(info).toBeDefined();
    expect(info?.context_window).toBe(0);
    expect(info?.thinking).toBe(false);
  });
});

describe("codebuddy live catalog — ownsModel", () => {
  test("preserves curated prefix ownership without any fetch", () => {
    const provider = new CodeBuddyProvider();
    expect(provider.ownsModel("cb-opus-4.8")).toBe(true);
    expect(provider.ownsModel("cb-anything")).toBe(true); // cb- prefix
    expect(provider.ownsModel("grok-4")).toBe(false);
  });

  test("owns a bare live-only id after refresh (already cb- prefixed)", async () => {
    mockAccounts = [makeCbAccount()];
    // Upstream already returns the cb- prefixed id.
    stubFetch(() => modelsDataResponse(["cb-future-model"]));
    const provider = new CodeBuddyProvider();
    await provider.refreshModelsCache(true);
    expect(provider.ownsModel("cb-future-model")).toBe(true);
    expect(provider.ownsModel("CB-FUTURE-MODEL")).toBe(true); // case-insensitive
  });
});

describe("codebuddy live catalog — refreshModelsCache resilience", () => {
  test("never throws with no codebuddy account", async () => {
    mockAccounts = [];
    stubFetch(() => {
      throw new Error("fetch should not be called");
    });
    const provider = new CodeBuddyProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CB_CURATED_COUNT);
  });

  test("never throws when account has no api_key", async () => {
    mockAccounts = [{ ...makeCbAccount(), tokens: JSON.stringify({ web_cookie: "c=1" }) }];
    stubFetch(() => {
      throw new Error("fetch should not be called");
    });
    const provider = new CodeBuddyProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CB_CURATED_COUNT);
  });

  test("never throws on fetch network failure, keeps curated", async () => {
    mockAccounts = [makeCbAccount()];
    stubFetch(() => {
      throw new Error("network down");
    });
    const provider = new CodeBuddyProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CB_CURATED_COUNT);
  });

  test("never throws on non-OK response, keeps curated", async () => {
    mockAccounts = [makeCbAccount()];
    stubFetch(() => new Response("boom", { status: 500 }));
    const provider = new CodeBuddyProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CB_CURATED_COUNT);
  });

  test("never throws on malformed JSON, keeps curated", async () => {
    mockAccounts = [makeCbAccount()];
    stubFetch(() => new Response("not json{{{", { status: 200 }));
    const provider = new CodeBuddyProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CB_CURATED_COUNT);
  });

  test("GETs the codebuddy models endpoint with bearer auth", async () => {
    mockAccounts = [makeCbAccount()];
    let seenUrl = "";
    let seenAuth: string | undefined;
    let seenMethod: string | undefined;
    stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return modelsDataResponse(["cb-future-model"]);
    });
    const provider = new CodeBuddyProvider();
    await provider.refreshModelsCache(true);
    expect(seenUrl).toBe("https://www.codebuddy.ai/v2/models");
    expect(seenMethod).toBe("GET");
    expect(seenAuth).toBe("Bearer cb-test-key");
  });
});

// ── CodeBuddy China (codebuddy.cn) ─────────────────────────────────────────

describe("codebuddy-china live catalog — getModels merge/dedupe", () => {
  test("falls back to curated supportedModels when live catalog is empty", () => {
    const provider = new CodeBuddyChinaProvider();
    const models = provider.getModels();
    expect(models.length).toBe(CBC_CURATED_COUNT);
    expect(models.some((m) => m.id === "cbc-kimi-k3")).toBe(true);
    expect(models.some((m) => m.id === "cbc-hy3-preview")).toBe(true);
  });

  test("merges live ids after curated, deduped by id (curated wins)", async () => {
    mockAccounts = [makeCbcAccount()];
    stubFetch(() => modelsDataResponse(["cbc-kimi-k3", "new-cn-model-a", "new-cn-model-b"]));
    const provider = new CodeBuddyChinaProvider();
    await provider.refreshModelsCache(true);

    const models = provider.getModels();
    const ids = models.map((m) => m.id);
    expect(ids[0]).toBe("cbc-haiku-4.5"); // curated first
    expect(ids).toContain("cbc-new-cn-model-a");
    expect(ids).toContain("cbc-new-cn-model-b");
    expect(models.length).toBe(CBC_CURATED_COUNT + 2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("curated spec is preserved on collision (vision flag kept)", async () => {
    mockAccounts = [makeCbcAccount()];
    // cbc-deepseek-v4-flash is curated with vision: true.
    stubFetch(() => modelsDataResponse(["cbc-deepseek-v4-flash"]));
    const provider = new CodeBuddyChinaProvider();
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "cbc-deepseek-v4-flash");
    expect(info?.vision).toBe(true);
    expect(provider.getModels().filter((m) => m.id === "cbc-deepseek-v4-flash").length).toBe(1);
  });

  test("live-only discovered model uses resolveModelSpec defaults (0/false when unknown)", async () => {
    mockAccounts = [makeCbcAccount()];
    stubFetch(() => modelsDataResponse(["totally-unknown-cn-xyz"]));
    const provider = new CodeBuddyChinaProvider();
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "cbc-totally-unknown-cn-xyz");
    expect(info).toBeDefined();
    expect(info?.context_window).toBe(0);
    expect(info?.thinking).toBe(false);
  });
});

describe("codebuddy-china live catalog — ownsModel", () => {
  test("preserves curated prefix ownership without any fetch", () => {
    const provider = new CodeBuddyChinaProvider();
    expect(provider.ownsModel("cbc-kimi-k3")).toBe(true);
    expect(provider.ownsModel("cbc-anything")).toBe(true); // cbc- prefix
    expect(provider.ownsModel("cb-opus-4.8")).toBe(false); // different provider
  });

  test("owns a bare live-only id after refresh (already cbc- prefixed)", async () => {
    mockAccounts = [makeCbcAccount()];
    stubFetch(() => modelsDataResponse(["cbc-future-cn-model"]));
    const provider = new CodeBuddyChinaProvider();
    await provider.refreshModelsCache(true);
    expect(provider.ownsModel("cbc-future-cn-model")).toBe(true);
    expect(provider.ownsModel("CBC-FUTURE-CN-MODEL")).toBe(true);
  });
});

describe("codebuddy-china live catalog — refreshModelsCache resilience", () => {
  test("never throws with no codebuddy-china account", async () => {
    mockAccounts = [];
    stubFetch(() => {
      throw new Error("fetch should not be called");
    });
    const provider = new CodeBuddyChinaProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CBC_CURATED_COUNT);
  });

  test("never throws on fetch network failure, keeps curated", async () => {
    mockAccounts = [makeCbcAccount()];
    stubFetch(() => {
      throw new Error("network down");
    });
    const provider = new CodeBuddyChinaProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CBC_CURATED_COUNT);
  });

  test("never throws on non-OK response, keeps curated", async () => {
    mockAccounts = [makeCbcAccount()];
    stubFetch(() => new Response("boom", { status: 500 }));
    const provider = new CodeBuddyChinaProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CBC_CURATED_COUNT);
  });

  test("GETs the codebuddy.cn models endpoint with bearer auth", async () => {
    mockAccounts = [makeCbcAccount()];
    let seenUrl = "";
    let seenAuth: string | undefined;
    let seenMethod: string | undefined;
    stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return modelsDataResponse(["cbc-future-cn-model"]);
    });
    const provider = new CodeBuddyChinaProvider();
    await provider.refreshModelsCache(true);
    expect(seenUrl).toBe("https://www.codebuddy.cn/v2/models");
    expect(seenMethod).toBe("GET");
    expect(seenAuth).toBe("Bearer ck_test-key");
  });
});
