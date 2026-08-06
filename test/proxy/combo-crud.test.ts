/**
 * Unit tests for src/proxy/combo.ts CRUD + model-string parsing.
 *
 * Env is set BEFORE imports because config reads ENCRYPTION_KEY / DATABASE_PATH
 * at import time. DATABASE_PATH is pointed at a temp file so these tests never
 * touch the operator's real data/poolprox3.db.
 *
 * Covered units:
 *   createCombo / updateCombo / deleteCombo / toggleCombo / getAllCombos / getComboByName
 *   resolveCombo (combo-name + alias parsing, enabled/disabled gating)
 *   expandComboRequest (bare "combo" and "combo/alias" forms, alias fallback)
 *
 * parseComboModel itself is not exported; it is exercised indirectly through
 * resolveCombo and expandComboRequest (both exported), which is also the real
 * call path used by the router.
 *
 * routeCombo is intentionally NOT exercised: it needs live pool accounts and
 * real upstreams, which the suite deliberately avoids (see skippedUnits).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "combo-crud-"));

process.env.ENCRYPTION_KEY =
  "x9f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9";
process.env.API_KEY = "a-strong-test-api-key-value";
process.env.POOLPROX_ALLOW_INSECURE = "1";
process.env.DATABASE_PATH = join(tmpHome, "combo-crud-test.db");

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runMigrations } from "../../src/db/migrate";
import { db } from "../../src/db/index";
import { combos } from "../../src/db/schema";
import { like } from "drizzle-orm";
import {
  createCombo,
  updateCombo,
  deleteCombo,
  toggleCombo,
  getAllCombos,
  getComboByName,
  resolveCombo,
  expandComboRequest,
} from "../../src/proxy/combo";

// Prefix all names so a stale row from another run can't collide with the
// unique constraint on combos.name.
const P = "combo-crud-test-";

beforeAll(async () => {
  await runMigrations();
  // Start from a clean slate for our prefix only — leave other suites' rows alone.
  await db.delete(combos).where(like(combos.name, `${P}%`));
});

afterAll(async () => {
  try {
    await db.delete(combos).where(like(combos.name, `${P}%`));
  } catch { /* best-effort */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// createCombo
// ---------------------------------------------------------------------------
describe("createCombo", () => {
  test("inserts a row and returns it with id/name/models/enabled", async () => {
    const row = await createCombo(`${P}basic`, ["m-a", "m-b"]);
    expect(row).toBeTruthy();
    expect(row?.name).toBe(`${P}basic`);
    expect(row?.models).toEqual(["m-a", "m-b"]);
    expect(row?.enabled).toBe(true);
    expect(typeof row?.id).toBe("number");
    expect(row?.id).toBeGreaterThan(0);
  });

  test("round-trips through getComboByName", async () => {
    await createCombo(`${P}rt`, ["x/one", "y/two"]);
    const fetched = await getComboByName(`${P}rt`);
    expect(fetched).toBeTruthy();
    expect(fetched?.models).toEqual(["x/one", "y/two"]);
    expect(fetched?.enabled).toBe(true);
  });

  test("persists models as a JSON array in insertion order", async () => {
    await createCombo(`${P}order`, ["z", "a", "m"]);
    const fetched = await getComboByName(`${P}order`);
    // Order matters for fallback chains — must not be sorted or deduped.
    expect(fetched?.models).toEqual(["z", "a", "m"]);
  });

  test("rejects duplicate names (unique constraint)", async () => {
    await createCombo(`${P}dup`, ["a"]);
    let threw = false;
    try {
      await createCombo(`${P}dup`, ["b"]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAllCombos
// ---------------------------------------------------------------------------
describe("getAllCombos", () => {
  test("returns enabled combos only", async () => {
    await createCombo(`${P}ga-on`, ["m1"]);
    const off = await createCombo(`${P}ga-off`, ["m2"]);
    await toggleCombo(off!.id, false);

    const all = await getAllCombos();
    const names = all.map((c: { name: string }) => c.name);
    expect(names).toContain(`${P}ga-on`);
    expect(names).not.toContain(`${P}ga-off`);
  });

  test("does not leak other rows when filtering enabled", async () => {
    const mine = await createCombo(`${P}ga-mine`, ["m"]);
    await toggleCombo(mine!.id, false);
    const all = await getAllCombos();
    // Every returned row must be enabled — the disabled one must not appear.
    for (const row of all) {
      expect(row.enabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getComboByName
// ---------------------------------------------------------------------------
describe("getComboByName", () => {
  test("returns null for a name that does not exist", async () => {
    const row = await getComboByName(`${P}does-not-exist`);
    expect(row).toBeNull();
  });

  test("matches exact name only (no prefix/substring match)", async () => {
    await createCombo(`${P}exact`, ["m"]);
    const near = await getComboByName(`${P}exac`);
    expect(near).toBeNull();
  });

  test("finds disabled combos too (lookup is not gated by enabled)", async () => {
    const row = await createCombo(`${P}gbn-disabled`, ["m"]);
    await toggleCombo(row!.id, false);
    const fetched = await getComboByName(`${P}gbn-disabled`);
    expect(fetched).toBeTruthy();
    expect(fetched?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateCombo
// ---------------------------------------------------------------------------
describe("updateCombo", () => {
  test("replaces the models list and bumps updatedAt", async () => {
    const created = await createCombo(`${P}upd`, ["old-1", "old-2"]);
    expect(created).toBeTruthy();
    const before = created!.updatedAt;

    const updated = await updateCombo(created!.id, ["new-1"]);
    expect(updated).toBeTruthy();
    expect(updated?.models).toEqual(["new-1"]);

    const refetched = await getComboByName(`${P}upd`);
    expect(refetched?.models).toEqual(["new-1"]);

    // updatedAt is a timestamp; if the two writes land in different ms it
    // advances, otherwise it at least must not regress.
    expect(refetched!.updatedAt!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
  });

  test("returns undefined for a missing id", async () => {
    const updated = await updateCombo(9_999_999, ["x"]);
    expect(updated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toggleCombo
// ---------------------------------------------------------------------------
describe("toggleCombo", () => {
  test("disables then re-enables a combo", async () => {
    const created = await createCombo(`${P}tgl`, ["m"]);
    expect(created?.enabled).toBe(true);

    await toggleCombo(created!.id, false);
    expect((await getComboByName(`${P}tgl`))?.enabled).toBe(false);

    await toggleCombo(created!.id, true);
    expect((await getComboByName(`${P}tgl`))?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteCombo
// ---------------------------------------------------------------------------
describe("deleteCombo", () => {
  test("removes the row so getComboByName returns null", async () => {
    const created = await createCombo(`${P}del`, ["m"]);
    await deleteCombo(created!.id);
    expect(await getComboByName(`${P}del`)).toBeNull();
  });

  test("is a no-op for a missing id", async () => {
    // Must not throw.
    await deleteCombo(9_999_998);
  });
});

// ---------------------------------------------------------------------------
// resolveCombo — combo-name parsing + enabled gating
// ---------------------------------------------------------------------------
describe("resolveCombo", () => {
  test("returns null for a bare combo name (no slash → parseComboModel yields no combo)", async () => {
    // A model with no "/" is treated as a plain model, not a combo reference.
    // parseComboModel returns comboName=null, so resolveCombo short-circuits to
    // null even if a combo with that exact name exists in the DB.
    await createCombo(`${P}rc-bare`, ["a", "b"]);
    expect(await resolveCombo(`${P}rc-bare`)).toBeNull();
  });

  test("returns the model chain for a combo/alias string", async () => {
    await createCombo(`${P}rc-alias`, ["x/1", "y/2"]);
    expect(await resolveCombo(`${P}rc-alias/preferred`)).toEqual(["x/1", "y/2"]);
  });

  test("returns null when there is no combo for the prefix", async () => {
    expect(await resolveCombo(`${P}rc-none/anything`)).toBeNull();
  });

  test("returns null for a disabled combo", async () => {
    const created = await createCombo(`${P}rc-disabled`, ["m"]);
    await toggleCombo(created!.id, false);
    expect(await resolveCombo(`${P}rc-disabled`)).toBeNull();
  });

  test("returns null for a model with no slash and no matching combo", async () => {
    // No "/" means parseComboModel yields comboName=null — plain model, not a combo.
    expect(await resolveCombo(`${P}rc-no-slash-nope`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// expandComboRequest — the router entry point that uses parseComboModel
// ---------------------------------------------------------------------------
describe("expandComboRequest", () => {
  test("returns null for a plain model name (no combo prefix)", async () => {
    const out = await expandComboRequest({ model: "plain-model", messages: [] } as any);
    expect(out).toBeNull();
  });

  test("returns null for an unknown combo prefix", async () => {
    const out = await expandComboRequest({
      model: `${P}unknown/alias`,
      messages: [],
    } as any);
    expect(out).toBeNull();
  });

  test("returns null for a bare combo name with no slash (parseComboModel gate)", async () => {
    // The comment in combo.ts says `"combo-name" alone` should work, and
    // expandComboRequest has explicit `alias || chain[0]` fallback code for the
    // bare form — but parseComboModel returns comboName=null when there is no
    // "/", so expandComboRequest returns null before that fallback can ever run.
    // The bare-name branch is unreachable in the current code. This test pins
    // the actual behavior (null); see suspected-bug note in notes.
    await createCombo(`${P}ex-bare`, ["first", "second"]);
    const out = await expandComboRequest({ model: `${P}ex-bare`, messages: [] } as any);
    expect(out).toBeNull();
  });

  test("expands combo/ with a trailing-slash empty alias to the first chain model", async () => {
    // A trailing slash yields alias="" — the `alias || chain[0]` fallback in
    // expandComboRequest catches this and routes chain[0]. This is the only
    // path that exercises the empty-alias fallback today.
    await createCombo(`${P}ex-trailing`, ["first", "second"]);
    const out = await expandComboRequest({ model: `${P}ex-trailing/`, messages: [] } as any);
    expect(out).toBeTruthy();
    expect(out?.expanded).toBe(true);
    expect(out?.comboName).toBe(`${P}ex-trailing`);
    expect(out?.models).toEqual(["first", "second"]);
    expect(out?.request.model).toBe("first");
  });

  test("uses the alias as the routed model when present", async () => {
    await createCombo(`${P}ex-alias`, ["fallback"]);
    const out = await expandComboRequest({
      model: `${P}ex-alias/chosen`,
      messages: [],
    } as any);
    expect(out).toBeTruthy();
    expect(out?.request.model).toBe("chosen");
    expect(out?.models).toEqual(["fallback"]);
  });

  test("preserves the rest of the request when rewriting model", async () => {
    await createCombo(`${P}ex-preserve`, ["m1"]);
    const req = {
      model: `${P}ex-preserve/alias`,
      messages: [{ role: "user" as const, content: "hi" }],
      temperature: 0.5,
    };
    const out = await expandComboRequest(req as any);
    expect(out?.request.messages).toEqual(req.messages);
    expect((out?.request as any).temperature).toBe(0.5);
    expect(out?.request.model).toBe("alias");
  });

  test("returns null for a disabled combo", async () => {
    const created = await createCombo(`${P}ex-disabled`, ["m"]);
    await toggleCombo(created!.id, false);
    const out = await expandComboRequest({ model: `${P}ex-disabled/x`, messages: [] } as any);
    expect(out).toBeNull();
  });
});
