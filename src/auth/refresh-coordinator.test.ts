import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { isUnrecoverableRefreshError } from "./refresh-coordinator";
import type { Account } from "../db/schema";
import type { BaseProvider } from "../proxy/providers/base";
import { coordinatedRefresh, setRefreshBackoffBaseMs } from "./refresh-coordinator";

// Zero out the real 1s/2s backoff so retry tests don't slow/block the suite
// (which can cause unrelated network tests like update.test.ts to time out).
beforeAll(() => setRefreshBackoffBaseMs(0));
afterAll(() => setRefreshBackoffBaseMs(1000));

// Minimal fake provider to exercise the coordinator without network calls.
function makeFakeProvider(opts: {
  name?: string;
  outcomes: Array<{ success: boolean; tokens?: string; error?: string }>;
}) {
  let calls = 0;
  const provider = {
    name: opts.name || "fake",
    async refreshToken(_account: Account) {
      const outcome = opts.outcomes[calls] ?? opts.outcomes[opts.outcomes.length - 1];
      calls++;
      return outcome;
    },
  } as unknown as BaseProvider;
  return { provider, getCalls: () => calls };
}

function makeAccount(id: number, refreshTokenTail = "abcdef0123456789"): Account {
  return {
    id,
    provider: "fake",
    email: `acct${id}@test`,
    password: "",
    status: "active",
    enabled: true,
    tokens: { refresh_token: "rt_" + refreshTokenTail },
  } as unknown as Account;
}

describe("refresh-coordinator isUnrecoverableRefreshError", () => {
  test("flags invalid_grant variants", () => {
    expect(isUnrecoverableRefreshError("invalid_grant")).toBe(true);
    expect(isUnrecoverableRefreshError("Invalid Grant")).toBe(true);
    expect(isUnrecoverableRefreshError("refresh_token_reused")).toBe(true);
    expect(isUnrecoverableRefreshError("refresh token reused")).toBe(true);
    expect(isUnrecoverableRefreshError("refresh_token_expired")).toBe(true);
    expect(isUnrecoverableRefreshError("refresh_token_invalidated")).toBe(true);
    expect(isUnrecoverableRefreshError("unrecoverable_refresh_error")).toBe(true);
    // Grok/xAI exchange wording + missing RT (warmup must hard-error only these)
    expect(isUnrecoverableRefreshError("refresh token invalid or revoked (invalid_grant)")).toBe(true);
    expect(isUnrecoverableRefreshError("No refresh token to renew OAuth access")).toBe(true);
    expect(isUnrecoverableRefreshError("wrong OAuth client (token not issued to this client_id)")).toBe(true);
    // Dead ChatGPT web session cookie (session-imported codex accounts).
    expect(isUnrecoverableRefreshError("session_expired: HTTP 401")).toBe(true);
    expect(isUnrecoverableRefreshError("session_expired: no accessToken in session response")).toBe(true);
  });

  test("does not flag transient/unknown errors", () => {
    expect(isUnrecoverableRefreshError("503 Service Unavailable")).toBe(false);
    expect(isUnrecoverableRefreshError("timeout")).toBe(false);
    expect(isUnrecoverableRefreshError("429 rate limit")).toBe(false);
    expect(isUnrecoverableRefreshError(undefined)).toBe(false);
    expect(isUnrecoverableRefreshError("")).toBe(false);
  });
});

describe("coordinatedRefresh", () => {
  test("returns parsed tokens on success", async () => {
    const { provider } = makeFakeProvider({
      name: "fake-success",
      outcomes: [{ success: true, tokens: JSON.stringify({ access_token: "abc", expires_at: "9999999999" }) }],
    });
    const result = await coordinatedRefresh(provider, makeAccount(1, "success_tail"));
    expect(result.success).toBe(true);
    expect(result.unrecoverable).toBe(false);
    expect((result.tokens as any).access_token).toBe("abc");
  });

  test("flags unrecoverable errors and does not retry them", async () => {
    const { provider, getCalls } = makeFakeProvider({
      name: "fake-unrecoverable",
      outcomes: [{ success: false, error: "invalid_grant" }],
    });
    const result = await coordinatedRefresh(provider, makeAccount(2, "unrecoverable_tail"));
    expect(result.success).toBe(false);
    expect(result.unrecoverable).toBe(true);
    expect(getCalls()).toBe(1); // no retry for unrecoverable
  });

  test("retries transient errors up to 3 attempts", async () => {
    const { provider, getCalls } = makeFakeProvider({
      name: "fake-transient",
      outcomes: [
        { success: false, error: "503 service_unavailable" },
        { success: false, error: "503 service_unavailable" },
        { success: true, tokens: JSON.stringify({ access_token: "recovered" }) },
      ],
    });
    const result = await coordinatedRefresh(provider, makeAccount(3, "transient_tail"));
    expect(result.success).toBe(true);
    expect((result.tokens as any).access_token).toBe("recovered");
    expect(getCalls()).toBe(3);
  });

  test("coalesces concurrent refreshes on the same account (one in-flight)", async () => {
    let calls = 0;
    const provider = {
      name: "fake-coalesce",
      async refreshToken(_account: Account) {
        calls++;
        // delay so concurrent callers arrive while in-flight
        await new Promise((r) => setTimeout(r, 50));
        return { success: true, tokens: JSON.stringify({ access_token: "shared" }) };
      },
    } as unknown as BaseProvider;
    // Distinct refresh-token tail so this test isn't served by another test's
    // 10s dedup cache (provider name + tail form the dedup key).
    const acct = makeAccount(4, "coalesce_unique_tail");
    const [a, b, c] = await Promise.all([
      coordinatedRefresh(provider, acct),
      coordinatedRefresh(provider, acct),
      coordinatedRefresh(provider, acct),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(c.success).toBe(true);
    // All three coalesced onto ONE refresh attempt (per-account lock).
    expect(calls).toBe(1);
  });
});
