/**
 * H5: execute() must honor the `maxRetries` cap so the router can rotate to a
 * fresh account (maxRetries: 0 → single hop) instead of re-hitting a degraded
 * one, and so the dashboard-tunable budget bounds total upstream hops.
 */
import { describe, test, expect } from "bun:test";
import { execute } from "../../src/proxy/executor";
import { BaseProvider, type ChatCompletionRequest, type ProviderResult } from "../../src/proxy/providers/base";
import type { Account } from "../../src/db/schema";

const fakeAccount = { id: 1, email: "a@b.c", provider: "mock" } as unknown as Account;
const req = { model: "mock", messages: [{ role: "user", content: "hi" }] } as ChatCompletionRequest;

/** Provider that always fails with a retryable 503 (soft overload). */
function failingProvider(calls: { n: number }) {
  return new (class extends BaseProvider {
    name = "mock";
    supportedModels = [];
    async chatCompletion(): Promise<ProviderResult> {
      calls.n++;
      return { success: false, error: "503 service unavailable", statusCode: 503 } as any;
    }
    async chatCompletionStream(): Promise<ProviderResult> {
      calls.n++;
      return { success: false, error: "503 service unavailable", statusCode: 503 } as any;
    }
    async refreshToken() { return { success: false, error: "not supported" }; }
    async validateAccount() { return true; }
    async fetchQuota() { return { success: false, error: "not supported" }; }
  })();
}

function succeedingProvider(calls: { n: number }) {
  return new (class extends BaseProvider {
    name = "mock";
    supportedModels = [];
    async chatCompletion(): Promise<ProviderResult> {
      calls.n++;
      return { success: true, response: { choices: [] } } as any;
    }
    async chatCompletionStream(): Promise<ProviderResult> {
      calls.n++;
      return { success: true, response: { choices: [] } } as any;
    }
    async refreshToken() { return { success: false, error: "not supported" }; }
    async validateAccount() { return true; }
    async fetchQuota() { return { success: false, error: "not supported" }; }
  })();
}

describe("execute() maxRetries cap (H5)", () => {
  test("maxRetries: 0 → exactly one attempt (rotate, don't re-hit)", async () => {
    const calls = { n: 0 };
    const r = await execute({ provider: failingProvider(calls), providerName: "mock", account: fakeAccount, request: req, stream: false, maxRetries: 0 });
    expect(r.success).toBe(false);
    expect(calls.n).toBe(1);
  });

  test("maxRetries: 1 → at most two attempts", async () => {
    const calls = { n: 0 };
    await execute({ provider: failingProvider(calls), providerName: "mock", account: fakeAccount, request: req, stream: false, maxRetries: 1 });
    expect(calls.n).toBeLessThanOrEqual(2);
  });

  test("undefined maxRetries → legacy budget (≥2 attempts on persistent 503)", async () => {
    const calls = { n: 0 };
    await execute({ provider: failingProvider(calls), providerName: "mock", account: fakeAccount, request: req, stream: false });
    expect(calls.n).toBeGreaterThanOrEqual(2);
  }, 20_000); // default path sleeps 3s+3s+2s between 503 retries

  test("success on first attempt is never retried regardless of cap", async () => {
    const calls = { n: 0 };
    const r = await execute({ provider: succeedingProvider(calls), providerName: "mock", account: fakeAccount, request: req, stream: false, maxRetries: 0 });
    expect(r.success).toBe(true);
    expect(calls.n).toBe(1);
  });

  /**
   * §5.3; a retryable status slept twice per hop: once for the per-status
   * RETRY_CONFIG delay before `continue`, then again for DEFAULT_DELAY_MS at the
   * top of the next iteration. A 503 cost 4s per retry instead of 2s.
   */
  test("a retryable status sleeps its per-status delay ONCE per retry", async () => {
    const calls = { n: 0 };
    const started = Date.now();
    await execute({ provider: failingProvider(calls), providerName: "mock", account: fakeAccount, request: req, stream: false, maxRetries: 1 });
    const elapsed = Date.now() - started;
    expect(calls.n).toBe(2);
    // 503 delay is 2000ms. One retry ⇒ ~2s. The double-sleep made it ~4s.
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(3_400);
  }, 20_000);
});
