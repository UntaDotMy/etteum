/**
 * Unit tests for:
 *  - src/api/management.ts KV get/put/delete validation (custom models, disabled
 *    models, pricing) — mounted Hono router against the real drizzle client,
 *    seeding only uniquely-scoped rows and cleaning them up.
 *  - src/ws/index.ts broadcast() payload truncation + dead-socket reaping, and
 *    getClientCount() — driving the module-level client set through
 *    websocketHandler.open/close with stub ServerWebSocket objects.
 *
 * why KV-through-router: the management kv helpers are not exported; the public
 * surface is the Hono routes, so validation is asserted at the HTTP boundary.
 *
 * why a temp DATABASE_PATH: kv.value is an AES-GCM encryptedText column, so
 * pointing db at a fresh temp file avoids ever mutating the operator's real
 * poolprox3.db rows. (Hermetic READS additionally rely on keyed selects — see
 * kvReadOne below — because a co-loaded test file can win the DATABASE_PATH
 * race in bun test's shared process.)
 */
// Env MUST be set inside a module imported BEFORE src/db (its top level opens
// config.databasePath at import time). Bare assignments here would run AFTER
// hoisted imports — too late. management-ws-env.ts is imported first on purpose.
import "./management-ws-env";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { ServerWebSocket } from "bun";
import { rmSync } from "node:fs";
import { managementRouter } from "../../src/api/management";
import { websocketHandler, broadcast, getClientCount } from "../../src/ws/index";
import { db, client as sqlite } from "../../src/db/index";
import { kv } from "../../src/db/schema";
import { eq, and } from "drizzle-orm";

// Unique run tag so seeded kv rows never collide with each other across runs.
const RUN = `mgwstest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const seededKeys: Array<{ scope: string; key: string }> = [];

beforeAll(() => {
  // Minimal kv schema (matches drizzle/0002 migration). The db client is already
  // open on the temp file by now; creating the table here keeps the test
  // self-contained without running the full migration chain.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      scope text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      updated_at integer
    );
    CREATE INDEX IF NOT EXISTS kv_scope_idx ON kv (scope);
    CREATE UNIQUE INDEX IF NOT EXISTS kv_scope_key_idx ON kv (scope, key);
  `);
});

afterAll(async () => {
  await cleanupKv();
  const p = process.env.DATABASE_PATH;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(p + suffix, { force: true });
    } catch {
      /* Windows may hold a handle briefly */
    }
  }
});

async function cleanupKv() {
  for (const { scope, key } of seededKeys.splice(0)) {
    await db
      .delete(kv)
      .where(and(eq(kv.scope, scope), eq(kv.key, key)))
      .catch(() => {});
  }
}

// cleanupKv is invoked from afterAll (rows persist across tests within the run
// is fine — keys are RUN-unique). No per-test hook needed.

/**
 * Read back ONE kv row by (scope, key) through the same drizzle client the
 * routes use. why keyed, not the GET routes: bun test runs every file in ONE
 * process with a shared module registry, so a co-loaded test file can win the
 * DATABASE_PATH race and point db at a file holding rows encrypted under a
 * different key; the whole-scope GET routes (kvGet) decrypt every row in the
 * scope and would 500 on those foreign rows. A keyed select decrypts only the
 * row this test wrote, keeping the round-trip assertion hermetic while still
 * verifying the route's write persisted the exact decrypted payload.
 */
async function kvReadOne(scope: string, key: string): Promise<any | null> {
  const [row] = await db
    .select()
    .from(kv)
    .where(and(eq(kv.scope, scope), eq(kv.key, key)))
    .limit(1);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

describe("management KV validation", () => {
  test("POST /models/disabled rejects a missing provider with 400", async () => {
    const res = await managementRouter.request("/models/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${RUN}-m` }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("provider and model required");
  });

  test("POST /models/disabled rejects a missing model with 400", async () => {
    const res = await managementRouter.request("/models/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "grok" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("provider and model required");
  });

  test("POST then GET /models/disabled round-trips a provider:model entry", async () => {
    const provider = "grok";
    const model = `${RUN}-disabled-model`;
    const key = `${provider}:${model}`;
    seededKeys.push({ scope: "disabledModels", key });

    const post = await managementRouter.request("/models/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model }),
    });
    expect(post.status).toBe(200);
    expect(((await post.json()) as { success?: boolean }).success).toBe(true);

    const stored = await kvReadOne("disabledModels", key);
    expect(stored).not.toBeNull();
    expect(stored?.provider).toBe(provider);
    expect(stored?.model).toBe(model);
    expect(typeof stored?.disabledAt).toBe("number");
  });

  test("POST /models/disabled with disabled:false deletes the entry", async () => {
    const provider = "grok";
    const model = `${RUN}-reenable`;
    const key = `${provider}:${model}`;
    seededKeys.push({ scope: "disabledModels", key });

    await managementRouter.request("/models/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model }),
    });
    const del = await managementRouter.request("/models/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model, disabled: false }),
    });
    expect(del.status).toBe(200);

    expect(await kvReadOne("disabledModels", key)).toBeNull();
  });

  test("POST /models/custom rejects a missing provider with 400", async () => {
    const res = await managementRouter.request("/models/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${RUN}-custom` }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("model and provider required");
  });

  test("POST /models/custom rejects a missing model with 400", async () => {
    const res = await managementRouter.request("/models/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "grok" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("model and provider required");
  });

  test("POST then GET /models/custom persists displayName + spec, DELETE removes it", async () => {
    const model = `${RUN}-custom-model`;
    seededKeys.push({ scope: "customModels", key: model });

    const post = await managementRouter.request("/models/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        provider: "grok",
        displayName: "My Custom",
        spec: { context_window: 12345, thinking: true },
      }),
    });
    expect(post.status).toBe(200);

    const stored = await kvReadOne("customModels", model);
    expect(stored).not.toBeNull();
    expect(stored?.provider).toBe("grok");
    expect(stored?.displayName).toBe("My Custom");
    expect(stored?.spec?.context_window).toBe(12345);
    expect(stored?.spec?.thinking).toBe(true);

    const del = await managementRouter.request(`/models/custom/${encodeURIComponent(model)}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await kvReadOne("customModels", model)).toBeNull();
  });

  test("POST /pricing rejects a missing model with 400", async () => {
    const res = await managementRouter.request("/pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputPer1M: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("model required");
  });

  test("POST /pricing defaults omitted rates to 0 and DELETE removes the row", async () => {
    const model = `${RUN}-priced`;
    seededKeys.push({ scope: "pricing", key: model });

    const post = await managementRouter.request("/pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, inputPer1M: 2.5 }),
    });
    expect(post.status).toBe(200);

    const stored = await kvReadOne("pricing", model);
    expect(stored).not.toBeNull();
    expect(stored?.inputPer1M).toBe(2.5);
    expect(stored?.outputPer1M).toBe(0);
    expect(stored?.cachedInputPer1M).toBe(0);
    expect(stored?.reasoningPer1M).toBe(0);
    expect(stored?.cacheCreationPer1M).toBe(0);
    expect(typeof stored?.updatedAt).toBe("number");

    const del = await managementRouter.request(`/pricing/${encodeURIComponent(model)}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await kvReadOne("pricing", model)).toBeNull();
  });

  test("POST /pricing upserts (second write overwrites, no duplicate row)", async () => {
    const model = `${RUN}-upsert`;
    seededKeys.push({ scope: "pricing", key: model });

    await managementRouter.request("/pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, inputPer1M: 1 }),
    });
    await managementRouter.request("/pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, inputPer1M: 9 }),
    });

    const rows = await db
      .select()
      .from(kv)
      .where(and(eq(kv.scope, "pricing"), eq(kv.key, model)));
    expect(rows.length).toBe(1);

    const stored = await kvReadOne("pricing", model);
    expect(stored?.inputPer1M).toBe(9);
  });
});

// --- ws broadcast() ---

interface FakeWS {
  data: Record<string, unknown>;
  sent: string[];
  sendImpl: (payload: string) => number;
  closeCalls: number;
}

function makeClient(sendImpl: (payload: string) => number = () => 1) {
  const state: FakeWS = { data: {}, sent: [], sendImpl, closeCalls: 0 };
  const ws = {
    data: state.data,
    send(payload: string) {
      state.sent.push(payload);
      return state.sendImpl(payload);
    },
    close() {
      state.closeCalls++;
    },
  } as unknown as ServerWebSocket<unknown>;
  return { ws, state };
}

describe("ws broadcast()", () => {
  test("open registers a client and getClientCount reflects it; close unregisters", () => {
    const { ws } = makeClient();
    const before = getClientCount();
    websocketHandler.open(ws);
    expect(getClientCount()).toBe(before + 1);
    websocketHandler.close(ws);
    expect(getClientCount()).toBe(before);
  });

  test("broadcast sends the JSON payload to every connected client", () => {
    const a = makeClient();
    const b = makeClient();
    websocketHandler.open(a.ws);
    websocketHandler.open(b.ws);
    try {
      a.state.sent.length = 0; // drop the "connected" greeting
      b.state.sent.length = 0;
      broadcast({ type: "evt", data: { n: 1 } });
      expect(a.state.sent.length).toBe(1);
      expect(b.state.sent.length).toBe(1);
      expect(JSON.parse(a.state.sent[0]!)).toEqual({ type: "evt", data: { n: 1 } });
      expect(JSON.parse(b.state.sent[0]!)).toEqual({ type: "evt", data: { n: 1 } });
    } finally {
      websocketHandler.close(a.ws);
      websocketHandler.close(b.ws);
    }
  });

  test("broadcast with zero clients is a no-op (does not throw)", () => {
    // Ensure the set is empty by closing a fresh client we open-then-close.
    const { ws } = makeClient();
    websocketHandler.open(ws);
    websocketHandler.close(ws);
    expect(() => broadcast({ type: "noop", data: {} })).not.toThrow();
  });

  test("payload over 128KB is truncated: requestBody/responseBody stripped, truncated flag set", () => {
    const c = makeClient();
    websocketHandler.open(c.ws);
    try {
      c.state.sent.length = 0;
      const big = "x".repeat(200 * 1024);
      broadcast({
        type: "log",
        data: { id: "abc", requestBody: big, responseBody: big, keep: "yes" },
      });
      expect(c.state.sent.length).toBe(1);
      const parsed = JSON.parse(c.state.sent[0]!) as any;
      expect(parsed.data.truncated).toBe(true);
      expect(parsed.data.requestBody).toBeUndefined();
      expect(parsed.data.responseBody).toBeUndefined();
      // Non-body fields survive the truncation.
      expect(parsed.data.keep).toBe("yes");
      expect(parsed.data.id).toBe("abc");
      // The truncated payload must be far smaller than the original would be.
      expect(c.state.sent[0]!.length).toBeLessThan(1024);
    } finally {
      websocketHandler.close(c.ws);
    }
  });

  test("payload at/under the limit is NOT truncated", () => {
    const c = makeClient();
    websocketHandler.open(c.ws);
    try {
      c.state.sent.length = 0;
      broadcast({ type: "small", data: { msg: "hello" } });
      const parsed = JSON.parse(c.state.sent[0]!) as any;
      expect(parsed.data.truncated).toBeUndefined();
      expect(parsed.data.msg).toBe("hello");
    } finally {
      websocketHandler.close(c.ws);
    }
  });

  test("dead socket (send returns -1) is reaped and closed", () => {
    const live = makeClient(() => 1);
    const dead = makeClient(() => -1);
    websocketHandler.open(live.ws);
    websocketHandler.open(dead.ws);
    const before = getClientCount();
    try {
      live.state.sent.length = 0;
      dead.state.sent.length = 0;
      broadcast({ type: "evt", data: {} });
      // Dead client removed from the set and close() called on it.
      expect(getClientCount()).toBe(before - 1);
      expect(dead.state.closeCalls).toBe(1);
      // Live client still received the payload.
      expect(live.state.sent.length).toBe(1);
    } finally {
      websocketHandler.close(live.ws);
      // dead.ws already reaped; close is idempotent on the Set.
      websocketHandler.close(dead.ws);
    }
  });

  test("throwing socket is reaped (removed from set, no close call)", () => {
    const live = makeClient(() => 1);
    const throwingState: FakeWS = { data: {}, sent: [], sendImpl: () => 1, closeCalls: 0 };
    let shouldThrow = false;
    const throwing = {
      data: throwingState.data,
      send(payload: string) {
        // The open() greeting must succeed so the socket registers; throw only
        // once broadcast() runs.
        if (shouldThrow) throw new Error("socket gone");
        throwingState.sent.push(payload);
        return 1;
      },
      close() {
        throwingState.closeCalls++;
      },
    } as unknown as ServerWebSocket<unknown>;

    websocketHandler.open(live.ws);
    websocketHandler.open(throwing);
    shouldThrow = true;
    const before = getClientCount();
    try {
      live.state.sent.length = 0;
      broadcast({ type: "evt", data: {} });
      expect(getClientCount()).toBe(before - 1);
      expect(throwingState.closeCalls).toBe(0);
      expect(live.state.sent.length).toBe(1);
    } finally {
      websocketHandler.close(live.ws);
      websocketHandler.close(throwing);
    }
  });

  test("ping message gets a pong reply", () => {
    const c = makeClient();
    websocketHandler.open(c.ws);
    try {
      c.state.sent.length = 0;
      websocketHandler.message(c.ws, JSON.stringify({ type: "ping" }));
      expect(c.state.sent.length).toBe(1);
      const parsed = JSON.parse(c.state.sent[0]!) as any;
      expect(parsed.type).toBe("pong");
      expect(typeof parsed.data.timestamp).toBe("number");
    } finally {
      websocketHandler.close(c.ws);
    }
  });
});
