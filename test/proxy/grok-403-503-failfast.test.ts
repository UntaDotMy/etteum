/**
 * Grok 403 Access denied + 503 hard-connect must not stall the fleet:
 *  - 403 Access denied → banned (permanent), not generic error / rate limit
 *  - hard connect refused → no multi-retry on same account (executor)
 *  - isHardConnectFailure / isAccessDeniedForbidden helpers drive fail-fast
 */
import { describe, test, expect } from "bun:test";
import { classifyGrokUpstreamError } from "../../src/proxy/providers/grok/index";
import {
  isHardConnectFailure,
  isAccessDeniedForbidden,
  isTransientError,
} from "../../src/proxy/errors";
import { classifyError } from "../../src/proxy/error-rules";
import { execute } from "../../src/proxy/executor";
import type { Account } from "../../src/db/schema";
import type { BaseProvider, ProviderResult } from "../../src/proxy/providers/base";

const ACCESS_DENIED =
  'cli-chat-proxy error 403: {"error":"Access denied"}';
const CONNECT_REFUSED =
  "cli-chat-proxy error 503: upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused";

describe("isAccessDeniedForbidden / isHardConnectFailure", () => {
  test("detects Access denied body", () => {
    expect(isAccessDeniedForbidden(ACCESS_DENIED)).toBe(true);
    expect(isAccessDeniedForbidden(`error: ${ACCESS_DENIED}`)).toBe(true);
    expect(isAccessDeniedForbidden("rate_limited: HTTP 429")).toBe(false);
  });

  test("detects connection refused / upstream connect 503", () => {
    expect(isHardConnectFailure(CONNECT_REFUSED)).toBe(true);
    expect(isHardConnectFailure(`error: ${CONNECT_REFUSED}`)).toBe(true);
    expect(isHardConnectFailure("server_is_overloaded")).toBe(false);
  });
});

describe("classifyGrokUpstreamError 403/503", () => {
  test("403 Access denied → banned (not generic error)", () => {
    const r = classifyGrokUpstreamError(new Error(ACCESS_DENIED));
    expect(r.success).toBe(false);
    expect(r.banned).toBe(true);
    expect(r.rateLimited).toBeUndefined();
    expect(r.error).toMatch(/forbidden/i);
  });

  test("permission-denied still banned", () => {
    const r = classifyGrokUpstreamError(
      new Error("cli-chat-proxy error 403: permission-denied chat endpoint is denied"),
    );
    expect(r.banned).toBe(true);
  });

  test("503 connection refused is hard-connect (not rateLimited)", () => {
    const r = classifyGrokUpstreamError(new Error(CONNECT_REFUSED));
    expect(r.success).toBe(false);
    expect(r.rateLimited).toBeUndefined();
    expect(r.banned).toBeUndefined();
    expect(isHardConnectFailure(r.error)).toBe(true);
  });
});

describe("error-rules permanent for Access denied", () => {
  test("access denied is permanent (executor must not multi-retry)", () => {
    const rule = classifyError(403, `forbidden: ${ACCESS_DENIED}`);
    expect(rule?.kind).toBe("permanent");
    expect(rule?.id).toBe("banned");
  });
});

describe("isTransientError bare 503 format", () => {
  test("matches cli-chat-proxy error 503 without parentheses", () => {
    expect(isTransientError(`error: ${CONNECT_REFUSED}`)).toBe(true);
  });
});

describe("execute hard-connect fail-fast (same account)", () => {
  test("does not multi-retry connection refused on the same account", async () => {
    let calls = 0;
    const provider = {
      name: "grok",
      async chatCompletion(): Promise<ProviderResult> {
        calls++;
        return {
          success: false,
          error: `error: ${CONNECT_REFUSED}`,
        };
      },
      async chatCompletionStream(): Promise<ProviderResult> {
        return this.chatCompletion({} as Account, {} as any);
      },
    } as unknown as BaseProvider;

    const account = { id: 1, provider: "grok", email: "t@oauth" } as Account;
    const t0 = Date.now();
    const result = await execute({
      provider,
      providerName: "grok",
      account,
      request: { model: "grok-4.5", messages: [{ role: "user", content: "hi" }] },
      stream: false,
    });
    const elapsed = Date.now() - t0;

    expect(result.success).toBe(false);
    // Old path: 3 attempts with 2s sleeps → ≥4s. Fail-fast = single call.
    expect(calls).toBe(1);
    expect(elapsed).toBeLessThan(1500);
    expect(isHardConnectFailure(result.error)).toBe(true);
  });

  test("Access denied permanent → single call (no retry)", async () => {
    let calls = 0;
    const provider = {
      name: "grok",
      async chatCompletion(): Promise<ProviderResult> {
        calls++;
        return classifyGrokUpstreamError(new Error(ACCESS_DENIED));
      },
      async chatCompletionStream(): Promise<ProviderResult> {
        return this.chatCompletion({} as Account, {} as any);
      },
    } as unknown as BaseProvider;

    const result = await execute({
      provider,
      providerName: "grok",
      account: { id: 2, provider: "grok" } as Account,
      request: { model: "grok-4.5", messages: [{ role: "user", content: "hi" }] },
      stream: false,
    });

    expect(result.banned).toBe(true);
    expect(calls).toBe(1);
  });
});
