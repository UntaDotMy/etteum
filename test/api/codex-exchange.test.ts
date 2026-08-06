/**
 * Codex OAuth exchange payload shaping (src/api/accounts/actionroutes.ts).
 *
 * Pure seams only: decodeJwtPayload + the request/response shaping of
 * exchangeCodexAuthorizationCode / exchangeCodexRefreshTokens /
 * importCodexAccessToken with globalThis.fetch stubbed — NO network, no live
 * OAuth. Account rows created by the exchange are deleted in afterAll.
 */
process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  decodeJwtPayload,
  importCodexAccessToken,
  exchangeCodexAuthorizationCode,
  exchangeCodexRefreshTokens,
} from "../../src/api/accounts/actionroutes";
import { db } from "../../src/db/index";
import { accounts } from "../../src/db/schema";
import { inArray } from "drizzle-orm";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Build an unsigned JWT whose payload is the given object (base64url). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let captured: CapturedCall[] = [];
let fetchQueue: Array<(url: string) => Response | Promise<Response>> = [];
let fetchFallback: ((url: string) => Response | Promise<Response>) | null = null;
const createdIds: number[] = [];
const origFetch = globalThis.fetch;

function pushJsonResponse(status: number, json: unknown) {
  fetchQueue.push(
    () =>
      new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

/** Track account ids created for an email so cleanup can delete them. */
async function trackEmail(email: string) {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.email, [email]));
  for (const r of rows) if (!createdIds.includes(r.id)) createdIds.push(r.id);
}

beforeEach(() => {
  captured = [];
  fetchQueue = [];
  fetchFallback = null;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? String(init.body) : "",
    });
    const next = fetchQueue.shift();
    if (next) return next(url);
    if (fetchFallback) return fetchFallback(url);
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, createdIds));
  }
});

// ── decodeJwtPayload ────────────────────────────────────────────────────────

describe("decodeJwtPayload", () => {
  test("parses a base64url payload without padding", () => {
    // Payload crafted so base64 length is not a multiple of 4 (needs padding logic).
    const token = makeJwt({ sub: "user-123", email: "a@b.c", exp: 1234567890 });
    const claims = decodeJwtPayload(token);
    expect(claims.sub).toBe("user-123");
    expect(claims.email).toBe("a@b.c");
    expect(claims.exp).toBe(1234567890);
  });

  test("returns {} for a token with fewer than 2 segments", () => {
    expect(decodeJwtPayload("not-a-jwt")).toEqual({});
    expect(decodeJwtPayload("")).toEqual({});
  });

  test("returns {} for invalid base64/json payload", () => {
    expect(decodeJwtPayload("aaa.!!!not-base64!!!.ccc")).toEqual({});
    expect(decodeJwtPayload("aaa.bm90LWpzb24.ccc")).toEqual({}); // "not-json"
  });

  test("handles nested OpenAI namespaced claims", () => {
    const token = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-9", chatgpt_plan_type: "plus" },
      "https://api.openai.com/profile": { email: "nested@example.com" },
    });
    const claims = decodeJwtPayload(token);
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown>;
    expect(auth.chatgpt_account_id).toBe("acct-9");
    expect(
      (claims["https://api.openai.com/profile"] as Record<string, unknown>).email,
    ).toBe("nested@example.com");
  });
});

// ── exchangeCodexAuthorizationCode ─────────────────────────────────────────

describe("exchangeCodexAuthorizationCode", () => {
  test("posts authorization_code grant form to the OpenAI token endpoint", async () => {
    const idToken = makeJwt({
      email: "pkce@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-pkce",
        chatgpt_plan_type: "pro",
      },
    });
    pushJsonResponse(200, {
      access_token: "at-123",
      refresh_token: "rt-456",
      id_token: idToken,
      expires_in: 7200,
    });

    const result = await exchangeCodexAuthorizationCode({
      code: "auth-code-xyz",
      codeVerifier: "verifier-abc",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    await trackEmail("pkce@example.com");

    // Exactly one upstream call (no usage fallback — claims were complete).
    expect(captured.length).toBe(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://auth.openai.com/oauth/token");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");

    const form = new URLSearchParams(call.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-xyz");
    expect(form.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(form.get("code_verifier")).toBe("verifier-abc");

    expect(result.provider).toBe("codex");
    expect(result.email).toBe("pkce@example.com");
    expect(result.workspace).toBe("acct-pkce");
    expect(result.plan).toBe("pro");
    expect(typeof result.id).toBe("number");
  });

  test("throws with status + truncated body when the exchange fails", async () => {
    pushJsonResponse(400, { error: "invalid_grant", detail: "x".repeat(500) });

    let err: Error | null = null;
    try {
      await exchangeCodexAuthorizationCode({
        code: "bad-code",
        codeVerifier: "v",
        redirectUri: "http://localhost:1455/auth/callback",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("400");
    expect(err!.message).toContain("invalid_grant");
    // Body sliced to 200 chars — the 500-char detail is truncated.
    expect(err!.message.length).toBeLessThan(400);
  });

  test("throws when response has no access_token", async () => {
    pushJsonResponse(200, { id_token: "x" });
    await expect(
      exchangeCodexAuthorizationCode({
        code: "c",
        codeVerifier: "v",
        redirectUri: "http://localhost/cb",
      }),
    ).rejects.toThrow("no access_token");
  });

  test("falls back to usage endpoint when id_token claims lack email/account", async () => {
    const idToken = makeJwt({ sub: "opaque" }); // no email, no auth claim
    pushJsonResponse(200, {
      access_token: "at-fallback",
      id_token: idToken,
      expires_in: 3600,
    });
    pushJsonResponse(200, { email: "usage@example.com", account_id: "acct-usage" });

    const result = await exchangeCodexAuthorizationCode({
      code: "code-fallback",
      codeVerifier: "v",
      redirectUri: "http://localhost/cb",
    });
    await trackEmail("usage@example.com");

    expect(captured.length).toBe(2);
    const usageCall = captured[1]!;
    expect(usageCall.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(usageCall.headers.authorization).toBe("Bearer at-fallback");
    expect(result.email).toBe("usage@example.com");
    expect(result.workspace).toBe("acct-usage");
  });

  test("synthesizes a stable oauth.local email when nothing yields an email", async () => {
    const idToken = makeJwt({ sub: "opaque" });
    pushJsonResponse(200, { access_token: "at-x", id_token: idToken });
    // usage endpoint errors → caught and ignored
    fetchQueue.push(() => {
      throw new Error("network down");
    });

    const result = await exchangeCodexAuthorizationCode({
      code: "code-ABCDEFGH",
      codeVerifier: "v",
      redirectUri: "http://localhost/cb",
    });
    await trackEmail("codex-ABCDEFGH@oauth.local");

    expect(result.email).toBe("codex-ABCDEFGH@oauth.local");
    expect(result.workspace).toBeNull();
  });
});

// ── importCodexAccessToken ─────────────────────────────────────────────────

describe("importCodexAccessToken", () => {
  test("rejects an empty token before any network call", async () => {
    await expect(importCodexAccessToken("   ")).rejects.toThrow(
      "Access token is required",
    );
    expect(captured.length).toBe(0);
  });

  test("shapes tokens from JWT claims without hitting the network", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({
      exp,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-imp",
        chatgpt_plan_type: "team",
      },
      "https://api.openai.com/profile": { email: "import@example.com" },
    });

    const result = await importCodexAccessToken(token, "My Work Acct");
    await trackEmail("import@example.com");

    expect(captured.length).toBe(0); // claims were complete → no usage call
    expect(result.provider).toBe("codex");
    expect(result.email).toBe("import@example.com");
    expect(result.name).toBe("My Work Acct");
    expect(result.workspace).toBe("acct-imp");
    expect(result.plan).toBe("team");
  });

  test("falls back to usage endpoint when JWT has no email/account claims", async () => {
    const token = makeJwt({ sub: "opaque", exp: Math.floor(Date.now() / 1000) + 60 });
    pushJsonResponse(200, { email: "imp-usage@example.com", chatgpt_account_id: "acct-iu" });

    const result = await importCodexAccessToken(token);
    await trackEmail("imp-usage@example.com");

    expect(captured.length).toBe(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(call.headers.authorization).toBe(`Bearer ${token}`);
    expect(call.headers["user-agent"]).toBe("codex_cli_rs/0.1.0");
    expect(result.email).toBe("imp-usage@example.com");
    expect(result.workspace).toBe("acct-iu");
  });

  test("synthesizes token.local email from the token suffix as last resort", async () => {
    const token = makeJwt({ sub: "opaque" }) + "ZZZZ9999";
    // usage fetch fails → swallowed
    fetchQueue.push(() => {
      throw new Error("offline");
    });

    const result = await importCodexAccessToken(token);
    await trackEmail(result.email);

    expect(result.email.endsWith("@token.local")).toBe(true);
    expect(result.email).toContain("ZZZZ9999");
    // name falls back to the synthesized email
    expect(result.name).toBe(result.email);
  });
});

// ── exchangeCodexRefreshTokens ─────────────────────────────────────────────

describe("exchangeCodexRefreshTokens", () => {
  test("posts refresh_token grant with scope for each token", async () => {
    const idToken = makeJwt({
      email: "ref@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-ref" },
    });
    pushJsonResponse(200, {
      access_token: "at-new",
      refresh_token: "rt-new",
      id_token: idToken,
      expires_in: 3600,
    });

    const out = await exchangeCodexRefreshTokens(["rt-old"]);
    await trackEmail("ref@example.com");

    expect(out).toEqual({ success: 1, failed: 0, errors: undefined });
    expect(captured.length).toBe(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://auth.openai.com/oauth/token");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-old");
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(form.get("scope")).toBe("openid profile email offline_access");
  });

  test("counts blanks as failed without a network call", async () => {
    const out = await exchangeCodexRefreshTokens(["", "   "]);
    expect(out.success).toBe(0);
    expect(out.failed).toBe(2);
    expect(out.errors).toBeUndefined(); // blanks push no error entries
    expect(captured.length).toBe(0);
  });

  test("collects per-token errors and keeps going after a failure", async () => {
    pushJsonResponse(401, { error: "invalid_grant" });
    const idToken = makeJwt({
      email: "ok@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-ok" },
    });
    pushJsonResponse(200, { access_token: "at-ok", id_token: idToken });

    const out = await exchangeCodexRefreshTokens(["rt-bad-token-1", "rt-good-token-2"]);
    await trackEmail("ok@example.com");

    expect(out.success).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.errors).toBeDefined();
    expect(out.errors!.length).toBe(1);
    // Error carries the token's last-8 suffix ("-token-1"), not the full secret.
    expect(out.errors![0]).toContain("...-token-1");
    expect(out.errors![0]).not.toContain("rt-bad-token-1");
    expect(out.errors![0]).toContain("401");
  });

  test("treats a 200 without access_token as a failure", async () => {
    pushJsonResponse(200, { id_token: "x" });
    const out = await exchangeCodexRefreshTokens(["rt-no-access-token"]);
    expect(out.success).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.errors![0]).toContain("no access_token");
  });
});
