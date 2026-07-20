/**
 * Pool-exhaustion UX (P0–P2):
 *  - typed all-exhausted error: clean client message, raw upstream only in rawDetail
 *  - reset-aware exhaustion: markExhausted(resetAt) earlier-wins, self-revive
 *    after the window passes, pool depletion summary
 *  - ledger-zero probe decision (restore vs park)
 *  - grok free-usage actual/limit parsing + full-body fidelity
 *  - token estimator per-tool overhead (OpenAI cookbook constants)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildPoolExhaustedError } from "../../src/proxy/router";
import {
  pool,
  computeResetRevivePatch,
  summarizePoolDepletion,
} from "../../src/proxy/pool";
import { resolveLedgerZeroAction } from "../../src/proxy/ledger-exhaustion";
import {
  classifyGrokUpstreamError,
  parseGrokFreeUsageActualLimit,
} from "../../src/proxy/providers/grok/index";
import { estimateRequestTokens } from "../../src/proxy/compression";
import { db } from "../../src/db/index";
import { accounts } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../../src/utils/crypto";

const FREE_USAGE_BODY =
  'cli-chat-proxy error 429: {"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage for model grok-4.5-build-free for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 2,012,345/2,000,000, requests (actual/limit): 101/100"}';

describe("parseGrokFreeUsageActualLimit", () => {
  test("parses the tokens actual/limit pair (comma-grouped)", () => {
    const r = parseGrokFreeUsageActualLimit(FREE_USAGE_BODY);
    expect(r).toEqual({ kind: "tokens", actual: 2_012_345, limit: 2_000_000 });
  });

  test("falls back to requests pair when tokens pair is absent", () => {
    const r = parseGrokFreeUsageActualLimit("some error — requests (actual/limit): 101/100");
    expect(r).toEqual({ kind: "requests", actual: 101, limit: 100 });
  });

  test("null on plain errors / empty text", () => {
    expect(parseGrokFreeUsageActualLimit("rate_limited: HTTP 429 too many requests")).toBeNull();
    expect(parseGrokFreeUsageActualLimit("")).toBeNull();
  });
});

describe("classifyGrokUpstreamError free-usage metadata", () => {
  test("attaches parsed freeUsage to ProviderResult.metadata", () => {
    const r = classifyGrokUpstreamError(new Error(FREE_USAGE_BODY));
    expect(r.quotaExhausted).toBe(true);
    expect((r.metadata as any)?.freeUsage).toEqual({
      kind: "tokens",
      actual: 2_012_345,
      limit: 2_000_000,
    });
  });

  test("no metadata when body lacks actual/limit detail", () => {
    const r = classifyGrokUpstreamError(
      new Error('cli-chat-proxy error 429: {"code":"subscription:free-usage-exhausted"}'),
    );
    expect(r.quotaExhausted).toBe(true);
    expect(r.metadata).toBeUndefined();
  });
});

describe("buildPoolExhaustedError", () => {
  test("typed error: quotaExhausted + retryAfterMs from future resetAt", () => {
    const resetAt = new Date(Date.now() + 2500_000);
    const err = buildPoolExhaustedError({ providerName: "grok", exhaustedCount: 6, resetAt });
    expect(err.quotaExhausted).toBe(true);
    // Allow test-execution jitter around the exact millisecond delta.
    expect(err.retryAfterMs).toBeGreaterThan(2400_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(2500_000);
    expect(err.message).toContain("grok");
    expect(err.message).toContain("6");
    expect(err.message).toMatch(/Retry in ~/);
  });

  test("defaults to 15min retry when no reset hint", () => {
    const err = buildPoolExhaustedError({ providerName: "codex" });
    expect(err.retryAfterMs).toBe(15 * 60_000);
    expect(err.message).not.toContain("codex accounts failed"); // clean phrasing
    expect(err.message).toContain("codex");
  });

  test("raw upstream detail is kept off the client message", () => {
    const err = buildPoolExhaustedError({
      providerName: "grok",
      rawDetail: FREE_USAGE_BODY,
    });
    expect(err.rawDetail).toBe(FREE_USAGE_BODY);
    expect(err.message).not.toContain("free-usage-exhausted");
    expect(err.message).not.toContain("actual/limit");
    expect(err.message).not.toContain("cli-chat-proxy");
  });

  test("past/absent reset falls back to default retry", () => {
    const err = buildPoolExhaustedError({
      providerName: "grok",
      resetAt: new Date(Date.now() - 60_000),
    });
    expect(err.retryAfterMs).toBe(15 * 60_000);
  });
});

describe("computeResetRevivePatch", () => {
  const now = new Date();

  test("exhausted + past reset → revive refilled to the package limit", () => {
    expect(
      computeResetRevivePatch(
        { status: "exhausted", quotaResetAt: new Date(now.getTime() - 1000), quotaLimit: 100 },
        now,
      ),
    ).toEqual({ quotaRemaining: 100 });
  });

  test("future reset / missing reset / non-exhausted → no revive", () => {
    expect(
      computeResetRevivePatch(
        { status: "exhausted", quotaResetAt: new Date(now.getTime() + 60_000), quotaLimit: 100 },
        now,
      ),
    ).toBeNull();
    expect(
      computeResetRevivePatch({ status: "exhausted", quotaResetAt: null, quotaLimit: 100 }, now),
    ).toBeNull();
    expect(
      computeResetRevivePatch(
        { status: "active", quotaResetAt: new Date(now.getTime() - 1000), quotaLimit: 100 },
        now,
      ),
    ).toBeNull();
  });

  test("limit<=0 revives with remaining 0 (unknown budget stays eligible)", () => {
    expect(
      computeResetRevivePatch(
        { status: "exhausted", quotaResetAt: new Date(now.getTime() - 1000), quotaLimit: 0 },
        now,
      ),
    ).toEqual({ quotaRemaining: 0 });
  });

  test("string timestamps are accepted", () => {
    expect(
      computeResetRevivePatch(
        { status: "exhausted", quotaResetAt: new Date(now.getTime() - 1000).toISOString(), quotaLimit: 42 },
        now,
      ),
    ).toEqual({ quotaRemaining: 42 });
  });
});

describe("summarizePoolDepletion", () => {
  test("counts exhausted enabled rows and finds the earliest FUTURE reset", () => {
    const nowMs = Date.now();
    const dep = summarizePoolDepletion(
      [
        { status: "active", quotaResetAt: null },
        { status: "exhausted", quotaResetAt: new Date(nowMs + 300_000) },
        { status: "exhausted", quotaResetAt: new Date(nowMs + 60_000) },
        { status: "exhausted", quotaResetAt: new Date(nowMs - 60_000) }, // past — not a hint
        { status: "error", quotaResetAt: null },
      ],
      nowMs,
    );
    expect(dep.enabled).toBe(5);
    expect(dep.exhausted).toBe(3);
    expect(dep.earliestResetAt?.getTime()).toBe(nowMs + 60_000);
  });

  test("no exhausted rows → earliestResetAt null", () => {
    const dep = summarizePoolDepletion([{ status: "active", quotaResetAt: null }], Date.now());
    expect(dep.exhausted).toBe(0);
    expect(dep.earliestResetAt).toBeNull();
  });
});

describe("resolveLedgerZeroAction", () => {
  test("healthy probe with remaining → restore, capped at the account limit", () => {
    expect(
      resolveLedgerZeroAction({ probeHealthy: true, probeRemaining: 1_500_000, quotaLimit: 2_000_000 }),
    ).toEqual({ action: "restore", remaining: 1_500_000 });
    // Weekly-percent account: absolute probe numbers clamp to the 0–100 scale.
    expect(
      resolveLedgerZeroAction({ probeHealthy: true, probeRemaining: 1_500_000, quotaLimit: 100 }),
    ).toEqual({ action: "restore", remaining: 100 });
  });

  test("no positive limit → cap at 100 (weekly scale guard)", () => {
    expect(
      resolveLedgerZeroAction({ probeHealthy: true, probeRemaining: 500, quotaLimit: 0 }),
    ).toEqual({ action: "restore", remaining: 100 });
  });

  test("unhealthy / zero / unknown probe → park", () => {
    expect(resolveLedgerZeroAction({ probeHealthy: false, probeRemaining: 500, quotaLimit: 100 }))
      .toEqual({ action: "park" });
    expect(resolveLedgerZeroAction({ probeHealthy: true, probeRemaining: 0, quotaLimit: 100 }))
      .toEqual({ action: "park" });
    expect(resolveLedgerZeroAction({ probeHealthy: true, probeRemaining: null, quotaLimit: 100 }))
      .toEqual({ action: "park" });
  });
});

describe("token estimator tool overhead", () => {
  const base = {
    model: "grok-4.5",
    messages: [{ role: "user" as const, content: "hello world" }],
  };
  const tool = {
    type: "function",
    function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
  };

  test("each tool adds JSON chars/4 + 19 tokens overhead (func_init 7 + func_end 12)", () => {
    const withoutTools = estimateRequestTokens(base as any);
    const withOneTool = estimateRequestTokens({ ...base, tools: [tool] } as any);
    const withTwoTools = estimateRequestTokens({ ...base, tools: [tool, tool] } as any);

    const perTool = withOneTool - withoutTools;
    expect(perTool).toBe(Math.ceil(JSON.stringify(tool).length / 4) + 19);
    // Overhead is charged per tool definition.
    expect(withTwoTools - withOneTool).toBe(perTool);
  });
});

// ── DB-backed pool behavior (pattern mirrors pool-depleted-routing.test.ts) ──
const TEST_PROVIDER = "exhaustionux" as any;

async function insertRow(opts: {
  email: string;
  status?: string;
  quotaLimit?: number;
  quotaRemaining?: number;
  quotaResetAt?: Date | null;
}): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: TEST_PROVIDER,
      email: opts.email,
      password: encrypt("irrelevant"),
      status: opts.status ?? "active",
      enabled: true,
      quotaLimit: opts.quotaLimit ?? 100,
      quotaRemaining: opts.quotaRemaining ?? 50,
      quotaResetAt: opts.quotaResetAt ?? null,
    })
    .returning({ id: accounts.id });
  return row!.id;
}

describe("pool markExhausted resetAt + self-revive", () => {
  beforeEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, TEST_PROVIDER));
    pool.invalidate(TEST_PROVIDER);
  });

  afterEach(async () => {
    await db.delete(accounts).where(eq(accounts.provider, TEST_PROVIDER));
    pool.invalidate(TEST_PROVIDER);
  });

  test("markExhausted stores resetAt; earlier-wins on subsequent marks", async () => {
    const id = await insertRow({ email: "rw@test", quotaLimit: 100, quotaRemaining: 50 });
    // SQLite timestamps persist at second precision — compare in whole seconds.
    const sec = (d: Date) => Math.floor(d.getTime() / 1000);

    const later = new Date(Date.now() + 2 * 3600_000);
    await pool.markExhausted(id, { resetAt: later });
    let [row] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(row!.status).toBe("exhausted");
    expect(Number(row!.quotaRemaining)).toBe(0);
    expect(sec(new Date(row!.quotaResetAt!))).toBe(sec(later));

    // Later reset must NOT push the window out.
    const muchLater = new Date(Date.now() + 5 * 3600_000);
    await pool.markExhausted(id, { resetAt: muchLater });
    [row] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(sec(new Date(row!.quotaResetAt!))).toBe(sec(later));

    // Earlier reset DOES win (sooner revive is always more useful).
    const sooner = new Date(Date.now() + 1800_000);
    await pool.markExhausted(id, { resetAt: sooner });
    [row] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(sec(new Date(row!.quotaResetAt!))).toBe(sec(sooner));
  });

  test("exhausted row with PAST resetAt self-revives on next selection (refilled to limit)", async () => {
    const id = await insertRow({
      email: "revive@test",
      status: "exhausted",
      quotaLimit: 100,
      quotaRemaining: 0,
      quotaResetAt: new Date(Date.now() - 60_000),
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick?.id).toBe(id);

    const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(row!.status).toBe("active");
    expect(Number(row!.quotaRemaining)).toBe(100);
  });

  test("exhausted row with FUTURE resetAt stays parked; depletion exposes the hint", async () => {
    const resetAt = new Date(Date.now() + 3600_000);
    await insertRow({
      email: "parked@test",
      status: "exhausted",
      quotaLimit: 100,
      quotaRemaining: 0,
      quotaResetAt: resetAt,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick).toBeNull();

    const dep = await pool.getPoolDepletion(TEST_PROVIDER);
    expect(dep.enabled).toBe(1);
    expect(dep.exhausted).toBe(1);
    // SQLite timestamps persist at second precision — compare in whole seconds.
    expect(Math.floor((dep.earliestResetAt?.getTime() ?? 0) / 1000)).toBe(
      Math.floor(resetAt.getTime() / 1000),
    );
  });

  test("exhausted row with NO resetAt does not self-revive (warmup owns it)", async () => {
    await insertRow({
      email: "noreset@test",
      status: "exhausted",
      quotaLimit: 100,
      quotaRemaining: 0,
      quotaResetAt: null,
    });
    pool.invalidate(TEST_PROVIDER);

    const pick = await pool.getNextAccount(TEST_PROVIDER);
    expect(pick).toBeNull();
  });
});
