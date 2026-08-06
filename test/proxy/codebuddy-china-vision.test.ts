// Set env BEFORE any imports that transitively touch config/crypto/db.
process.env.ENCRYPTION_KEY = "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";

import { describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import { CodeBuddyChinaProvider } from "../../src/proxy/providers/codebuddy-china/provider";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";

/**
 * Stub fetchWithTimeout (same idiom as TestCodexProvider) so we never make a
 * real network call. The responder receives the URL + init and returns a
 * canned Response; we capture the parsed request body for assertions.
 */
class TestCodeBuddyChinaProvider extends CodeBuddyChinaProvider {
  lastRequestBody: any;
  lastRequestUrl: string | null = null;

  constructor(
    private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>
  ) {
    super();
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    this.lastRequestUrl = url;
    try {
      this.lastRequestBody = JSON.parse(String(init.body || "{}"));
    } catch {
      this.lastRequestBody = null;
    }
    return this.responder(url, init);
  }
}

const account = {
  id: 1,
  provider: "codebuddy-china",
  email: "cbc@test.local",
  tokens: { api_key: "test-api-key" },
} as unknown as Account;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

/** Minimal stream payload the aggregator can consume. */
const DONE_STREAM = [
  {
    choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
];

function req(messages: ChatCompletionRequest["messages"], model = "cbc-kimi-k3"): ChatCompletionRequest {
  return { model, messages };
}

describe("CodeBuddy China — cleanMessages vision path", () => {
  test("image_url content blocks are passed through unchanged (standard OpenAI format)", async () => {
    const provider = new TestCodeBuddyChinaProvider(() => sseResponse(DONE_STREAM));

    const content = [
      { type: "text", text: "what is in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];
    await provider.chatCompletion(account, req([{ role: "user", content }], "cbc-glm-5v-turbo"));

    const sent = provider.lastRequestBody;
    expect(sent).toBeTruthy();
    const msg = sent?.messages?.[0];
    expect(msg?.role).toBe("user");
    // Vision path: image_url blocks must be preserved INSIDE the content array
    // (the previous hoisted-fields approach caused 100% hallucinated responses).
    expect(Array.isArray(msg?.content)).toBe(true);
    const types = (msg?.content as any[]).map((b) => b?.type);
    expect(types).toContain("text");
    expect(types).toContain("image_url");
    const img = (msg?.content as any[]).find((b) => b?.type === "image_url");
    expect(img?.image_url?.url).toBe("data:image/png;base64,AAA");
    // No hoisted legacy fields may leak into the payload.
    expect(msg?.files).toBeUndefined();
    expect(msg?.images).toBeUndefined();
  });

  test("'image' block type also marks the request as vision (hasVision)", async () => {
    const provider = new TestCodeBuddyChinaProvider(() => sseResponse(DONE_STREAM));
    const content = [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", data: "AAA" } },
    ];
    await provider.chatCompletion(account, req([{ role: "user", content }]));
    const msg = provider.lastRequestBody?.messages?.[0];
    expect(Array.isArray(msg?.content)).toBe(true);
    expect((msg?.content as any[]).some((b) => b?.type === "image")).toBe(true);
  });

  test("string content is forwarded verbatim", async () => {
    const provider = new TestCodeBuddyChinaProvider(() => sseResponse(DONE_STREAM));
    await provider.chatCompletion(account, req([{ role: "user", content: "hello" }]));
    expect(provider.lastRequestBody?.messages?.[0]?.content).toBe("hello");
  });

  test("agent system prompts are replaced with a neutral coding prompt", async () => {
    const provider = new TestCodeBuddyChinaProvider(() => sseResponse(DONE_STREAM));
    const agentPrompt = "You are Cursor, an AI coding agent. " + "x".repeat(2100);
    await provider.chatCompletion(
      account,
      req([
        { role: "system", content: agentPrompt },
        { role: "user", content: "hi" },
      ])
    );
    const sys = provider.lastRequestBody?.messages?.[0];
    expect(sys?.role).toBe("system");
    expect(sys?.content).toBe(
      "You are a helpful AI assistant that helps with software engineering tasks."
    );
  });
});

describe("CodeBuddy China — get-user-resource package aggregation", () => {
  /** Build the envelope the real upstream returns: { code: 0, data: { Response: { Data: { Accounts: [...] } } } }. */
  function resourceResponse(accounts: Array<Record<string, unknown>>) {
    return jsonResponse({
      code: 0,
      data: {
        Response: {
          Data: {
            TotalDosage: accounts.reduce((s, a) => s + Number(a.CapacitySize ?? 0), 0),
            Accounts: accounts,
          },
        },
      },
    });
  }

  test("sums CapacitySize/Used/Remain across every active package row", async () => {
    const provider = new TestCodeBuddyChinaProvider(() =>
      resourceResponse([
        { PackageCode: "TCACA_code_001_PqouKr6QWV", CapacitySize: 1000, CapacityUsed: 100, CapacityRemain: 900 },
        { PackageCode: "TCACA_code_002_AkiJS3ZHF5", CapacitySize: 5000, CapacityUsed: 500, CapacityRemain: 4500 },
        { PackageCode: "TCACA_code_006_DbXS0lrypC", CapacitySize: 200, CapacityUsed: 0, CapacityRemain: 200 },
      ])
    );

    const result = await provider.fetchQuota(account);
    expect(result.success).toBe(true);
    const quota = result.quota!;
    expect(quota.limit).toBe(6200);
    expect(quota.used).toBe(600);
    expect(quota.remaining).toBe(5600);
    // Per-package breakdown must be present for the dashboard.
    expect(Array.isArray(quota.packages)).toBe(true);
    expect(quota.packages!.length).toBe(3);
  });

  test("returns zeroed quota (success) when Accounts is empty", async () => {
    const provider = new TestCodeBuddyChinaProvider(() => resourceResponse([]));
    const result = await provider.fetchQuota(account);
    expect(result.success).toBe(true);
    const quota = result.quota!;
    expect(quota.limit).toBe(0);
    expect(quota.used).toBe(0);
    expect(quota.remaining).toBe(0);
  });

  test("refill vs bonus split: cycle-windowed packs become 'refill' rows using Cycle* numbers", async () => {
    // Refill heuristic: DeductionEndTime is >2 days after CycleEndTime.
    const provider = new TestCodeBuddyChinaProvider(() =>
      resourceResponse([
        {
          PackageCode: "TCACA_code_002_AkiJS3ZHF5",
          PackageName: "",
          CapacitySize: 5000, CapacityUsed: 500, CapacityRemain: 4500,
          CycleCapacitySize: 1000, CycleCapacityUsed: 100, CycleCapacityRemain: 900,
          CycleEndTime: "2026-09-01 00:00:00",
          DeductionEndTime: "2027-09-01 00:00:00", // far future → refill
        },
        {
          PackageCode: "TCACA_code_006_DbXS0lrypC",
          PackageName: "",
          CapacitySize: 200, CapacityUsed: 50, CapacityRemain: 150,
          CycleEndTime: "2026-08-10 00:00:00",
          DeductionEndTime: "2026-08-10 01:00:00", // ~cycle end → bonus
        },
      ])
    );

    const result = await provider.fetchQuota(account);
    expect(result.success).toBe(true);
    const packages = result.quota!.packages!;
    expect(packages.length).toBe(2);

    const refill = packages.find((p) => p.kind === "refill")!;
    const bonus = packages.find((p) => p.kind === "bonus")!;

    // Refill rows use the Cycle* numbers, not the outer Capacity* ones.
    expect(refill.total).toBe(1000);
    expect(refill.used).toBe(100);
    expect(refill.remaining).toBe(900);
    // Known package code with no name falls back to the documented label.
    expect(refill.name).toBe("pro monthly pack");
    expect(refill.packageCode).toBe("TCACA_code_002_AkiJS3ZHF5");

    // Bonus rows use the plain Capacity* numbers.
    expect(bonus.total).toBe(200);
    expect(bonus.used).toBe(50);
    expect(bonus.remaining).toBe(150);
    expect(bonus.name).toBe("gift pack");
  });

  test("aggregated limit/remaining/used always come from the plain Capacity* totals", async () => {
    // Even when a pack is a refill (whose live numbers are in Cycle*), the
    // top-level aggregate uses Capacity* so existing columns keep meaning.
    const provider = new TestCodeBuddyChinaProvider(() =>
      resourceResponse([
        {
          PackageCode: "TCACA_code_002_AkiJS3ZHF5",
          CapacitySize: 5000, CapacityUsed: 500, CapacityRemain: 4500,
          CycleCapacitySize: 1000, CycleCapacityUsed: 100, CycleCapacityRemain: 900,
          CycleEndTime: "2026-09-01 00:00:00",
          DeductionEndTime: "2027-09-01 00:00:00",
        },
      ])
    );
    const result = await provider.fetchQuota(account);
    expect(result.success).toBe(true);
    expect(result.quota!.limit).toBe(5000);
    expect(result.quota!.remaining).toBe(4500);
    expect(result.quota!.used).toBe(500);
  });

  test("non-zero upstream code fails the quota fetch with the code in the error", async () => {
    const provider = new TestCodeBuddyChinaProvider(() =>
      jsonResponse({ code: 40100, msg: "invalid signature" })
    );
    const result = await provider.fetchQuota(account);
    expect(result.success).toBe(false);
    expect(result.error).toContain("40100");
  });

  test("HTTP error status fails the quota fetch, never throws", async () => {
    const provider = new TestCodeBuddyChinaProvider(() =>
      jsonResponse({ error: "unauthorized" }, 401)
    );
    const result = await provider.fetchQuota(account);
    expect(result.success).toBe(false);
    expect(result.error).toContain("401");
  });
});
