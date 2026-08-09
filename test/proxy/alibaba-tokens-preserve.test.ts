/**
 * Alibaba tokens-blob writers must preserve queryableModels (regression, 2026-08-08).
 *
 * pool.getNextAccountForModel ranks accounts on queryableModels (probe-confirmed
 * tier 0 vs un-probed tier 1). Two writers rebuilt the whole tokens blob without
 * it — decrementModelQuota (every request) and fetchQuota (warmup) — so one
 * request demoted a probed account back to "un-probed". setModelQuotaToZero
 * already preserved it; this test pins all writers to that invariant.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, mock } from "bun:test";

let writtenTokens: unknown[] = [];
let txRowTokens: unknown = null;

const mockDb: any = {
  update: () => ({
    set: (payload: any) => ({
      // awaitable for the tx path, and .run() exists for the fire-and-forget path
      where: () => {
        writtenTokens.push(payload.tokens);
        const p = Promise.resolve() as any;
        p.run = () => Promise.resolve();
        return p;
      },
    }),
  }),
  transaction: async (fn: any) => {
    const tx: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ tokens: txRowTokens }]),
          }),
        }),
      }),
      update: () => ({
        set: (payload: any) => ({
          where: () => {
            writtenTokens.push(payload.tokens);
            return Promise.resolve();
          },
        }),
      }),
    };
    return fn(tx);
  },
};

mock.module("../../src/db/index", () => ({ db: mockDb, client: undefined }));

import { AlibabaProvider } from "../../src/proxy/providers/alibaba/provider";
import { encrypt } from "../../src/utils/crypto";
import type { Account } from "../../src/db/schema";

const QUERYABLE = ["qwen3.8-max", "glm-5.2"];

function seededTokens() {
  return {
    modelQuotas: {
      "qwen3.8-max": { limit: 500, remaining: 400, periodDays: 60, resetAt: null },
    },
    queryableModels: QUERYABLE,
    updatedAt: new Date().toISOString(),
  };
}

function makeAccount(tokens: unknown): Account {
  return {
    id: 424242,
    provider: "alibaba",
    email: "ali-tokens-test",
    password: encrypt("sk-test-key"),
    tokens,
  } as unknown as Account;
}

describe("alibaba tokens writers preserve queryableModels", () => {
  test("decrementModelQuota keeps queryableModels from the live row", async () => {
    writtenTokens = [];
    txRowTokens = seededTokens();
    const provider = new AlibabaProvider();
    const account = makeAccount(seededTokens());

    const remaining = await (provider as any).decrementModelQuota(account, "qwen3.8-max", 10);

    expect(remaining).toBe(390);
    expect(writtenTokens.length).toBe(1);
    const written = writtenTokens[0] as any;
    expect(written.modelQuotas["qwen3.8-max"].remaining).toBe(390);
    expect(written.queryableModels).toEqual(QUERYABLE);
  });

  test("fetchQuota keeps queryableModels when persisting per-model quotas", async () => {
    writtenTokens = [];
    const provider = new QuotaStubProvider();
    const account = makeAccount(seededTokens());

    const res = await provider.fetchQuota(account);
    if (!res.success) throw new Error(`fetchQuota failed: ${res.error}`);

    expect(res.success).toBe(true);
    expect(writtenTokens.length).toBe(1);
    const written = writtenTokens[0] as any;
    expect(written.modelQuotas["qwen3.8-max"].limit).toBe(500);
    // locally-tracked remaining is min-preserved, not reset to the cap
    expect(written.modelQuotas["qwen3.8-max"].remaining).toBe(400);
    expect(written.queryableModels).toEqual(QUERYABLE);
  });
});

describe("setModelQuotaToZero parks drained accounts transactionally", () => {
  test("zeroes an existing tracked model and reports fully drained", async () => {
    writtenTokens = [];
    txRowTokens = seededTokens(); // only qwen3.8-max tracked, remaining 400
    const provider = new AlibabaProvider();
    const account = makeAccount(seededTokens());

    const res = await (provider as any).setModelQuotaToZero(account, "qwen3.8-max");

    expect(res.allModelsDrained).toBe(true); // no other tracked model has quota
    expect(writtenTokens.length).toBe(1);
    const written = writtenTokens[0] as any;
    expect(written.modelQuotas["qwen3.8-max"].remaining).toBe(0);
    expect(written.queryableModels).toEqual(QUERYABLE); // probe results preserved
  });

  test("creates a ledger entry when the model was never tracked (no silent no-op)", async () => {
    writtenTokens = [];
    txRowTokens = seededTokens(); // ledger knows only qwen3.8-max
    const provider = new AlibabaProvider();
    const account = makeAccount(seededTokens());

    const res = await (provider as any).setModelQuotaToZero(account, "glm-5.2");

    // qwen3.8-max still has 400 → NOT fully drained → stays active for it.
    expect(res.allModelsDrained).toBe(false);
    const written = writtenTokens[0] as any;
    expect(written.modelQuotas["glm-5.2"].remaining).toBe(0);
    expect(written.queryableModels).toEqual(QUERYABLE);
  });

  test("fully drained only when EVERY tracked model is at zero", async () => {
    writtenTokens = [];
    txRowTokens = {
      modelQuotas: {
        "qwen3.8-max": { limit: 500, remaining: 0, periodDays: 60, resetAt: null },
        "glm-5.2": { limit: 800, remaining: 120, periodDays: 60, resetAt: null },
      },
      queryableModels: QUERYABLE,
      updatedAt: new Date().toISOString(),
    };
    const provider = new AlibabaProvider();
    const account = makeAccount(txRowTokens);

    const res = await (provider as any).setModelQuotaToZero(account, "glm-5.2");
    expect(res.allModelsDrained).toBe(true);
  });
});

/** Mocks the network: quotas endpoint returns one capped model. */
class QuotaStubProvider extends AlibabaProvider {
  protected override async fetchWithTimeout(url: string): Promise<Response> {
    if (url.includes("quotas")) {
      return new Response(
        JSON.stringify({
          success: true,
          output: {
            total: 1,
            quotas: [
              {
                model: "qwen3.8-max",
                model_limit: {
                  usage_limit: 500,
                  usage_limit_field: "token",
                  usage_limit_period: 60,
                  request_limit: null,
                  request_limit_period: null,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }
}
