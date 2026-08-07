/**
 * Qoder provider — live model catalog tests.
 *
 * Covers refreshModelsCache / getModels / ownsModel: curated-first dedupe,
 * live-only id ownership, curated ownership preserved, never-throw on
 * no-account / fetch failure / malformed payload, and fallback to the curated
 * list when the live catalog is empty.
 *
 * Network is fully mocked by stubbing global fetch (bearerFetch calls it
 * directly). The DB account query is mocked via mock.module on the db module
 * (spread of the real module, per repo idiom). Accounts are plain objects —
 * no DB rows required. The auth dance is short-circuited by giving the
 * account a device-session token (no personalToken) with a far-future
 * expireTime so ensureFreshAuth performs no network I/O and
 * refreshModelsCache only hits GET /algo/api/v2/model/list.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// ── DB mock (must be registered before importing the provider) ─────────────
// The provider calls db.select().from(accounts).where(...).limit(1). We stub
// that chain; the rows it returns are controlled per-test via mockAccounts.
// The stub is self-contained: re-importing the real db/index inside its own
// mock factory deadlocks bun's module resolver (and the real module's
// setInterval WAL checkpoint would hold the test process open).
let mockAccounts: any[] = [];

mock.module("../../src/db/index", () => {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(mockAccounts.slice(0, 1)),
  };
  return {
    db: { select: () => chain },
    client: undefined,
  };
});

import { QoderProvider } from "../../src/proxy/providers/qoder/provider";
import { QODER_MODELS } from "../../src/proxy/providers/qoder/helpers";
import type { Account } from "../../src/db/schema";

// ── Harness ────────────────────────────────────────────────────────────────

const CURATED_COUNT = QODER_MODELS.length;

/** Device-session account: securityOauthToken present, no PAT, far-future expiry. */
function makeAccount(): Account {
  return {
    id: 424242,
    provider: "qoder",
    email: "qd-test",
    password: null,
    tokens: JSON.stringify({
      securityOauthToken: "dt-test-session-token",
      userId: "u-test",
      userName: "qd test",
      userType: "personal_standard",
      machineId: "0123456789abcdef0123456789abcdef",
      machineToken: "fedcba9876543210fedcba9876543210",
      machineType: "a1b2c3",
      machineCode: "test-machine-code",
      machineOs: "x86_64_windows",
      expireTime: Date.now() + 3600_000,
    }),
    enabled: true,
    status: "active",
  } as unknown as Account;
}

function modelListResponse(chat: unknown[]): Response {
  return new Response(JSON.stringify({ code: 0, data: { chat } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;

function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    return responder(url, init ?? {});
  }) as typeof fetch;
}

beforeEach(() => {
  mockAccounts = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("qoder live catalog — getModels merge/dedupe", () => {
  test("falls back to curated supportedModels when live catalog is empty", () => {
    const provider = new QoderProvider();
    const models = provider.getModels();
    expect(models.length).toBe(CURATED_COUNT);
    expect(models.some((m) => m.id === "qd-Lite")).toBe(true);
  });

  test("merges live ids after curated, deduped by id (curated wins)", async () => {
    mockAccounts = [makeAccount()];
    // Upstream returns a curated model (qmodel_latest = qd-Qwen3.7-Max) plus new ones.
    stubFetch(() =>
      modelListResponse([
        { key: "qmodel_latest", display_name: "Qwen3.7-Max", max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
        { key: "newmodel_x", display_name: "NewModel X", max_input_tokens: 500000, is_vl: false, is_reasoning: true },
        { key: "newmodel_y", display_name: "NewModel Y", max_input_tokens: 200000, is_vl: true, is_reasoning: false },
      ]),
    );
    const provider = new QoderProvider();
    await provider.refreshModelsCache(true);

    const models = provider.getModels();
    const ids = models.map((m) => m.id);
    // Curated first
    expect(ids[0]).toBe("qd-Auto");
    // New live ids appended under qd- prefix
    expect(ids).toContain("qd-newmodel_x");
    expect(ids).toContain("qd-newmodel_y");
    // No duplicate of the curated model that upstream also listed
    expect(ids.filter((i) => i === "qd-Qwen3.7-Max").length).toBe(1);
    // Total = curated + 2 new
    expect(models.length).toBe(CURATED_COUNT + 2);
  });

  test("skips enable:false (plan-gated) upstream entries", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() =>
      modelListResponse([
        { key: "gatedmodel", enable: false, max_input_tokens: 100000 },
        { key: "openmodel", enable: true, max_input_tokens: 100000 },
      ]),
    );
    const provider = new QoderProvider();
    await provider.refreshModelsCache(true);
    const ids = provider.getModels().map((m) => m.id);
    expect(ids).not.toContain("qd-gatedmodel");
    expect(ids).toContain("qd-openmodel");
  });

  test("live entries carry upstream-advertised specs", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() =>
      modelListResponse([
        { key: "specmodel", max_input_tokens: 777000, max_output_tokens: 12345, is_vl: true, is_reasoning: true },
      ]),
    );
    const provider = new QoderProvider();
    await provider.refreshModelsCache(true);
    const info = provider.getModels().find((m) => m.id === "qd-specmodel");
    expect(info?.context_window).toBe(777000);
    expect(info?.max_output).toBe(12345);
    expect(info?.thinking).toBe(true);
    expect(info?.vision).toBe(true);
  });
});

describe("qoder live catalog — ownsModel", () => {
  test("preserves curated qd- prefix ownership without any fetch", () => {
    const provider = new QoderProvider();
    expect(provider.ownsModel("qd-Qwen3.7-Max")).toBe(true);
    expect(provider.ownsModel("qd-Lite")).toBe(true);
    expect(provider.ownsModel("qd-AnythingNew")).toBe(true); // prefix match
    expect(provider.ownsModel("qwen3.7-max")).toBe(false);
    expect(provider.ownsModel("grok-4")).toBe(false);
  });

  test("owns a live-only id after refresh (qd- prefix matches anyway)", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => modelListResponse([{ key: "brand_new", max_input_tokens: 1000 }]));
    const provider = new QoderProvider();
    expect(provider.ownsModel("qd-brand_new")).toBe(true); // prefix match anyway
    await provider.refreshModelsCache(true);
    expect(provider.ownsModel("qd-brand_new")).toBe(true);
  });
});

describe("qoder live catalog — refreshModelsCache resilience", () => {
  test("never throws with no qoder account", async () => {
    mockAccounts = [];
    stubFetch(() => {
      throw new Error("fetch should not be called");
    });
    const provider = new QoderProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on fetch network failure, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => {
      throw new Error("network down");
    });
    const provider = new QoderProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on non-OK response, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => new Response("upstream boom", { status: 500 }));
    const provider = new QoderProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws on malformed JSON, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => new Response("not json{{{", { status: 200 }));
    const provider = new QoderProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("never throws when chat array is missing, keeps curated", async () => {
    mockAccounts = [makeAccount()];
    stubFetch(() => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
    const provider = new QoderProvider();
    await expect(provider.refreshModelsCache(true)).resolves.toBeUndefined();
    expect(provider.getModels().length).toBe(CURATED_COUNT);
  });

  test("hits /algo/api/v2/model/list with COSY bearer auth", async () => {
    mockAccounts = [makeAccount()];
    let seenUrl = "";
    let seenAuth: string | undefined;
    let seenMethod = "";
    stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = (init?.method as string) || "";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers?.authorization ?? headers?.Authorization;
      return modelListResponse([{ key: "newmodel_x" }]);
    });
    const provider = new QoderProvider();
    await provider.refreshModelsCache(true);
    expect(seenUrl).toContain("/algo/api/v2/model/list");
    expect(seenMethod).toBe("GET");
    expect(seenAuth?.startsWith("Bearer COSY.")).toBe(true);
  });
});
